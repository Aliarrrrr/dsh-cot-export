/**
 * Host half of dsh-cot-export.
 *
 * One export pipeline serves four callers: the `cot_export` tool (any agent,
 * any session), the `/cot` command (the human plane), the authenticated
 * `GET /api/cot.export` Fetch route (the header button), and `cot_review`, which
 * reuses the same artifact to prepare a supervised review package.
 *
 * The pipeline only reads: `ctx.sessionQuery` supplies the replay-validated log
 * and the surface classification, and nothing here appends a session event or
 * changes an existing plugin.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  buildExportPath,
  cotError,
  extractCoT,
  mimeOf,
  parseFormat,
  parseScope,
  render,
  shortSessionId,
} from './cot.js'
import { RUBRIC, buildDelegationPrompt, buildReviewDoc, planWindows } from './rubric.js'

export const name = 'dsh-cot-export'

export const inject = ['tools', 'sessionQuery']

export const Config = z.object({
  enabled: z.boolean().default(true),
  outputDir: z.string().default('cot-exports'),
  defaultFormat: z.string().default('markdown'),
  defaultScope: z.string().default('all'),
  includeContext: z.boolean().default(true),
  includeFailedAttempts: z.boolean().default(false),
  crossSession: z.string().default('workspace'),
  maxToolPreviewChars: z.number().default(600),
  reviewWindowTurns: z.number().default(8),
  enableRoute: z.boolean().default(true),
  routePath: z.string().default('/api/cot.export'),
  enableSkill: z.boolean().default(true),
})

const FORMAT_TOKENS = new Set(['md', 'markdown', 'json', 'jsonl', 'ndjson', 'txt', 'text'])
const USAGE = '/cot [md|json|jsonl|txt] [all|surface] [session-id|latest] | /cot review [focus]'

/** @param {unknown} error @returns {string} one safe diagnostic line. */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback @returns {number} */
function clampInteger(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** @param {unknown} value @param {string} fallback @returns {string} */
function safeFormat(value, fallback) {
  try {
    return parseFormat(value)
  } catch {
    return fallback
  }
}

/** @param {unknown} value @param {string} fallback @returns {string} */
function safeScope(value, fallback) {
  try {
    return parseScope(value)
  } catch {
    return fallback
  }
}

/**
 * Fold the Loader-provided config into the values this plugin actually uses, so
 * one malformed field degrades to its default instead of disabling the feature.
 * @param {Record<string, unknown>} raw - validated plugin config.
 * @returns {object} normalized settings.
 */
function normalizeConfig(raw) {
  const config = raw ?? {}
  return {
    enabled: config.enabled !== false,
    outputDir:
      typeof config.outputDir === 'string' && config.outputDir.trim() !== '' ? config.outputDir.trim() : 'cot-exports',
    defaultFormat: safeFormat(config.defaultFormat, 'markdown'),
    defaultScope: safeScope(config.defaultScope, 'all'),
    includeContext: config.includeContext !== false,
    includeFailedAttempts: config.includeFailedAttempts === true,
    crossSession: config.crossSession === 'any' ? 'any' : 'workspace',
    maxToolPreviewChars: clampInteger(config.maxToolPreviewChars, 0, 4000, 600),
    reviewWindowTurns: clampInteger(config.reviewWindowTurns, 0, 200, 8),
    enableRoute: config.enableRoute !== false,
    routePath:
      typeof config.routePath === 'string' && config.routePath.startsWith('/')
        ? config.routePath
        : '/api/cot.export',
    enableSkill: config.enableSkill !== false,
  }
}

/** @param {string} filePath @returns {Promise<string>} a path that does not exist yet. */
async function uniquePath(filePath) {
  try {
    await stat(filePath)
  } catch {
    return filePath
  }
  const extension = path.extname(filePath)
  const stem = filePath.slice(0, filePath.length - extension.length)
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${extension}`
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
  }
  return `${stem}-${Date.now()}${extension}`
}

/**
 * Write one artifact atomically: a sibling temporary file then a rename, so a
 * failed export never leaves a truncated document behind.
 * @param {string} filePath - final absolute path.
 * @param {string} text - complete artifact text.
 * @returns {Promise<{path: string, bytes: number}>} the written artifact.
 */
async function writeArtifact(filePath, text) {
  const directory = path.dirname(filePath)
  try {
    await mkdir(directory, { recursive: true })
  } catch (error) {
    throw cotError('COT_WRITE_FAILED', `cannot create ${directory}: ${messageOf(error)}`)
  }
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    await writeFile(temporary, text, 'utf8')
    await rename(temporary, filePath)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch {
      // The temporary file never existed or is already gone.
    }
    throw cotError('COT_WRITE_FAILED', `cannot write ${filePath}: ${messageOf(error)}`)
  }
  try {
    const info = await stat(filePath)
    return { path: filePath, bytes: info.size }
  } catch {
    return { path: filePath, bytes: Buffer.byteLength(text, 'utf8') }
  }
}

/**
 * First reasoning passage of an artifact, for a tool-result preview.
 * @param {object} model - extracted model.
 * @param {number} limit - maximum characters (0 disables the preview).
 * @returns {string|undefined} the preview text.
 */
function previewOf(model, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return undefined
  for (const turnEntry of model.turns) {
    for (const step of turnEntry.steps) {
      for (const part of step.reasoning ?? []) {
        const text = typeof part.text === 'string' ? part.text.trim() : ''
        if (text === '') continue
        return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
      }
    }
  }
  return undefined
}

/**
 * Build the shared export/review operations bound to one plugin context.
 * @param {object} ctx - plugin context with the hard dependencies injected.
 * @param {ReturnType<typeof normalizeConfig>} settings - normalized settings.
 * @returns {{exportSession: Function, prepareReview: Function, registerRoute: Function}} operations.
 */
function createExporter(ctx, settings) {
  /** @param {string} message @param {unknown} [error] */
  const warn = (message, error) => {
    try {
      const suffix = error === undefined ? '' : `: ${messageOf(error)}`
      ctx.logger?.warn?.(`[dsh-cot-export] ${message}${suffix}`)
    } catch {
      // Logging must never break an export.
    }
  }

  /** @param {AbortSignal|undefined} signal */
  function assertNotAborted(signal) {
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      throw cotError('COT_ABORTED', 'the export was cancelled')
    }
  }

  /** @param {readonly object[]} records @param {string} id */
  function headerOf(records, id) {
    for (const record of records) {
      const header = record?.header
      if (header !== null && typeof header === 'object' && header.id === id) return header
    }
    return undefined
  }

  /**
   * Resolve one session reference against the live-preferred corpus.
   * @param {readonly object[]} records - `listSessions()` result, newest first.
   * @param {unknown} input - `current`, `latest`, exact id or unique id prefix.
   * @param {string|undefined} callerId - calling session id.
   * @param {object|undefined} callerHeader - calling session header.
   * @returns {object} the target session header.
   */
  function resolveTarget(records, input, callerId, callerHeader) {
    const headers = records.map((record) => record?.header).filter((header) => header?.id)
    const byId = new Map(headers.map((header) => [header.id, header]))
    const reference = typeof input === 'string' ? input.trim() : ''
    if (reference === '' || reference.toLowerCase() === 'current') {
      if (callerId === undefined) {
        throw cotError('COT_NO_SESSION', 'no session_id was given and this caller has no session of its own')
      }
      const header = byId.get(callerId)
      if (header === undefined && callerHeader !== undefined) return callerHeader
      if (header === undefined) throw cotError('COT_NO_SESSION', `the calling session ${callerId} is not readable`)
      return header
    }
    if (reference.toLowerCase() === 'latest') {
      const callerCwd = callerHeader?.cwd
      const candidates = headers.filter((header) => header.id !== callerId && header.cwd === callerCwd)
      if (candidates.length === 0) {
        throw cotError(
          'COT_NO_SESSION',
          `no other session exists in workspace ${callerCwd ?? '(none)'} — pass an explicit session_id`,
        )
      }
      return candidates[0]
    }
    if (byId.has(reference)) return byId.get(reference)
    const needle = reference.toLowerCase()
    const matches = headers.filter((header) => String(header.id).toLowerCase().startsWith(needle))
    if (matches.length === 1) return matches[0]
    if (matches.length === 0) {
      const newest = headers.slice(0, 3).map((header) => header.id).join(', ')
      throw cotError(
        'COT_NO_SESSION',
        `no session matches "${reference}"${newest === '' ? '' : ` — newest sessions: ${newest}`}`,
      )
    }
    throw cotError(
      'COT_NO_SESSION',
      `"${reference}" matches ${matches.length} sessions — pass more characters: ${matches
        .slice(0, 5)
        .map((header) => header.id)
        .join(', ')}`,
    )
  }

  /** @param {object|undefined} callerHeader @param {object} target @param {string|undefined} callerId */
  function assertCrossSessionAllowed(callerHeader, target, callerId) {
    if (settings.crossSession === 'any') return
    if (callerId === undefined) return
    const callerCwd = callerHeader?.cwd
    const targetCwd = target?.cwd
    if (callerCwd === targetCwd) return
    throw cotError(
      'COT_UNAUTHORIZED',
      `session ${target.id} lives in ${targetCwd ?? '(no workspace)'} but the caller is in ${callerCwd ?? '(no workspace)'}; ` +
        'cross-session export requires the same workspace, or set crossSession: any in the plugin config',
    )
  }

  /** @param {string} sessionId @returns {Promise<{log: object}>} */
  async function readLog(sessionId) {
    try {
      const snapshot = await ctx.sessionQuery.readSession(sessionId)
      if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.events)) {
        throw new Error('the session query returned no event log')
      }
      return snapshot
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('COT_')) throw error
      throw cotError('COT_NO_SESSION', `cannot read session ${sessionId}: ${messageOf(error)}`)
    }
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<Map<number, string>>} seq to surface classification.
   */
  async function readSurfaceMap(sessionId) {
    try {
      const records = await ctx.sessionQuery.listEvents(sessionId)
      const map = new Map()
      for (const record of records ?? []) {
        if (record !== null && typeof record === 'object' && typeof record.seq === 'number') {
          map.set(record.seq, record.surface)
        }
      }
      return map
    } catch (error) {
      // The classification only annotates superseded steps; degrading to
      // "every committed message is current" keeps the export usable.
      warn('surface classification unavailable; treating every committed reasoning message as current', error)
      return new Map()
    }
  }

  /** @param {string} sessionId @param {AbortSignal|undefined} signal @returns {Promise<string|undefined>} */
  async function readTitle(sessionId, signal) {
    try {
      const observation = await ctx.sessionQuery.readTitleSnapshot(sessionId, signal)
      const title = observation?.title?.title
      return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
    } catch (error) {
      warn(`could not fold the title of ${sessionId}`, error)
      return undefined
    }
  }

  /**
   * Directory the artifact resolves against: the live working directory for the
   * calling session, otherwise the recorded workspace of the target.
   * @param {object} header @param {string|undefined} callerId @returns {string}
   */
  function cwdFor(header, callerId) {
    if (callerId !== undefined && header.id === callerId) {
      try {
        const sessions = ctx.get('sessions')
        const workingDirectory = ctx.get('workingDirectory')
        const session = typeof sessions?.get === 'function' ? sessions.get(header.id) : undefined
        if (session !== undefined && typeof workingDirectory?.get === 'function') {
          const directory = workingDirectory.get(session)
          if (typeof directory === 'string' && directory !== '') return directory
        }
      } catch (error) {
        warn('could not read the live working directory; using the recorded workspace', error)
      }
    }
    if (typeof header.cwd === 'string' && header.cwd !== '') return header.cwd
    return process.cwd()
  }

  /**
   * Export one already-resolved session.
   * @param {object} options - export inputs.
   * @returns {Promise<{value: object, model: object, rendered: object}>} artifact + value.
   */
  async function exportResolved(options) {
    const {
      header,
      callerId,
      format,
      scope,
      includeContext,
      includeFailedAttempts,
      outPath,
      outputDir,
      baseDir,
      signal,
      previewLimit,
    } = options
    assertNotAborted(signal)
    const log = await readLog(header.id)
    assertNotAborted(signal)
    const surfaceOf = await readSurfaceMap(header.id)
    assertNotAborted(signal)
    const title = await readTitle(header.id, signal)
    const exportedAt = Date.now()
    const model = extractCoT({
      session: log.session ?? header,
      inheritedEventCount: log.inheritedEventCount ?? 0,
      events: log.events,
      surfaceOf,
      title,
      exportedAt,
      scope,
      includeContext,
      includeFailedAttempts,
    })
    const rendered = render(model, format, { includeContext })
    const candidate = buildExportPath({
      baseDir,
      outputDir,
      format,
      sessionId: header.id,
      title,
      outPath,
      exportedAt,
    })
    const finalPath = await uniquePath(candidate)
    const written = await writeArtifact(finalPath, rendered.text)

    const value = {
      session_id: model.session.id,
      format,
      scope: model.scope,
      path: written.path,
      bytes: written.bytes,
      turns: model.stats.turns,
      steps: model.stats.steps,
      reasoning_blocks: model.stats.reasoning_blocks,
      reasoning_chars: model.stats.reasoning_chars,
      current_steps: model.stats.current_steps,
      superseded_steps: model.stats.superseded_steps,
    }
    if (model.session.title !== undefined) value.title = model.session.title
    if (model.stats.reasoning_tokens !== undefined) value.reasoning_tokens = model.stats.reasoning_tokens
    if (model.stats.inherited_steps > 0) value.inherited_steps = model.stats.inherited_steps
    if (model.stats.failed_attempts > 0) value.failed_attempts = model.stats.failed_attempts
    if (model.stats.models.length > 0) value.models = model.stats.models
    const preview = previewOf(model, previewLimit ?? 0)
    if (preview !== undefined) value.preview = preview
    return { value, model, rendered }
  }

  /**
   * Export one session, resolving the reference and enforcing workspace policy.
   * @param {object} options - caller inputs.
   * @returns {Promise<{value: object, model: object, rendered: object}>} artifact + value.
   */
  async function exportSession(options) {
    const {
      sessionIdInput,
      callerId,
      format: formatInput,
      scope: scopeInput,
      includeContext: contextInput,
      includeFailedAttempts: failedInput,
      outPath,
      includeDescendants = false,
      signal,
      previewLimit,
    } = options ?? {}

    const format = parseFormat(formatInput ?? settings.defaultFormat)
    const scope = parseScope(scopeInput ?? settings.defaultScope)
    const includeContext = contextInput === undefined ? settings.includeContext : contextInput === true
    const includeFailedAttempts = failedInput === undefined ? settings.includeFailedAttempts : failedInput === true

    assertNotAborted(signal)
    const records = await ctx.sessionQuery.listSessions(signal)
    assertNotAborted(signal)
    const callerHeader = callerId === undefined ? undefined : headerOf(records, callerId)
    const target = resolveTarget(records, sessionIdInput, callerId, callerHeader)
    assertCrossSessionAllowed(callerHeader, target, callerId)
    const baseDir = cwdFor(target, callerId)

    const result = await exportResolved({
      header: target,
      callerId,
      format,
      scope,
      includeContext,
      includeFailedAttempts,
      outPath,
      outputDir: settings.outputDir,
      baseDir,
      signal,
      previewLimit: previewLimit === undefined ? settings.maxToolPreviewChars : previewLimit,
    })

    if (includeDescendants !== true) return result

    try {
      assertNotAborted(signal)
      const trace = await ctx.sessionQuery.traceSession(target.id, signal)
      const treeDirectory = path.join(path.dirname(result.value.path), `tree-${shortSessionId(target.id)}`)
      const descendants = []
      const indexLines = [
        `# Session tree — ${target.id}`,
        '',
        `- ${target.id}${result.value.title === undefined ? '' : ` — ${result.value.title}`} (root, ${result.value.turns} turns)`,
      ]
      const walk = async (nodes) => {
        for (const node of nodes ?? []) {
          const session = node?.session
          const header = session?.header
          if (header?.id !== undefined) {
            try {
              const child = await exportResolved({
                header,
                callerId,
                format,
                scope,
                includeContext,
                includeFailedAttempts,
                outPath: undefined,
                outputDir: treeDirectory,
                baseDir: treeDirectory,
                signal,
                previewLimit: 0,
              })
              descendants.push({ session_id: child.model.session.id, path: child.value.path, turns: child.value.turns })
              indexLines.push(
                `- ${child.model.session.id}${child.value.title === undefined ? '' : ` — ${child.value.title}`} ` +
                  `(${child.value.turns} turns) → ${path.basename(child.value.path)}`,
              )
            } catch (error) {
              indexLines.push(`- ${header.id} — not exported: ${messageOf(error)}`)
            }
          }
          await walk(node?.descendants)
        }
      }
      await walk(trace?.descendants)
      if (descendants.length > 0) {
        await writeArtifact(path.join(treeDirectory, 'INDEX.md'), `${indexLines.join('\n')}\n`)
        result.value.descendants = descendants
      }
    } catch (error) {
      warn('descendant export failed; the target artifact is unaffected', error)
    }
    return result
  }

  /**
   * Export the CoT and write the supervised-review package beside it.
   * @param {object} options - review inputs.
   * @returns {Promise<{value: object, model: object}>} review value.
   */
  async function prepareReview(options) {
    const { sessionIdInput, callerId, focus, windowTurns, signal } = options ?? {}
    const built = await exportSession({
      sessionIdInput,
      callerId,
      format: 'markdown',
      scope: settings.defaultScope,
      outPath: undefined,
      includeDescendants: false,
      signal,
      previewLimit: 0,
    })
    const size = clampInteger(windowTurns ?? settings.reviewWindowTurns, 0, 200, settings.reviewWindowTurns)
    const windows = planWindows(built.rendered.turnLines, size)
    const generatedAt = Date.now()
    const reviewPath = await uniquePath(path.join(path.dirname(built.value.path), 'REVIEW.md'))
    const reviewName = path.basename(reviewPath)
    const document = buildReviewDoc({
      model: built.model,
      cotPath: built.value.path,
      reviewName,
      focus,
      windows,
      generatedAt,
    })
    const written = await writeArtifact(reviewPath, document)
    const delegationPrompt = buildDelegationPrompt({
      cotPath: built.value.path,
      reviewPath: written.path,
      focus,
      windows,
      sessionId: built.model.session.id,
    })
    return {
      value: {
        session_id: built.model.session.id,
        cot_path: built.value.path,
        review_path: written.path,
        turns: built.model.stats.turns,
        steps: built.model.stats.steps,
        reasoning_chars: built.model.stats.reasoning_chars,
        windows,
        delegation_prompt: delegationPrompt,
      },
      model: built.model,
    }
  }

  /**
   * Register the authenticated browser route that the header action calls.
   * @param {object} cctx - context where `connection` is available.
   */
  function registerRoute(cctx) {
    if (settings.enableRoute !== true) return
    /** @param {Request} request */
    const handleFetch = async (request) => {
      let url
      try {
        url = new URL(request.url)
      } catch {
        return jsonResponse(400, { error: 'COT_INVALID_ARGUMENT', message: 'malformed request URL' })
      }
      // HEAD is a cheap availability probe, exactly like the shipped session-log
      // route: it answers whether this Host serves the export route without
      // reading a session or writing a file.
      if (request.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'cache-control': 'no-store',
            'x-cot-export-route': settings.routePath,
            'x-cot-export-formats': 'markdown,json,jsonl,text',
          },
        })
      }
      const sessionId = url.searchParams.get('sessionId')
      if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        return jsonResponse(400, { error: 'COT_INVALID_ARGUMENT', message: 'sessionId is required' })
      }
      const download = url.searchParams.get('download') === '1'
      const booleanParam = (key) => {
        const value = url.searchParams.get(key)
        if (value === null) return undefined
        return value === '1' || value.toLowerCase() === 'true'
      }
      try {
        const result = await exportSession({
          sessionIdInput: sessionId,
          callerId: undefined,
          format: url.searchParams.get('format') ?? undefined,
          scope: url.searchParams.get('scope') ?? undefined,
          includeContext: booleanParam('includeContext'),
          includeFailedAttempts: booleanParam('includeFailedAttempts'),
          previewLimit: 0,
        })
        if (download !== true) {
          const value = result.value
          const payload = {
            session_id: value.session_id,
            format: value.format,
            scope: value.scope,
            path: value.path,
            bytes: value.bytes,
            turns: value.turns,
            steps: value.steps,
            reasoning_blocks: value.reasoning_blocks,
            reasoning_chars: value.reasoning_chars,
            current_steps: value.current_steps,
            superseded_steps: value.superseded_steps,
          }
          if (value.title !== undefined) payload.title = value.title
          if (value.reasoning_tokens !== undefined) payload.reasoning_tokens = value.reasoning_tokens
          return jsonResponse(200, payload)
        }
        return new Response(result.rendered.text, {
          status: 200,
          headers: {
            'content-type': mimeOf(result.value.format),
            'content-disposition': `attachment; filename="${path.basename(result.value.path)}"`,
            'cache-control': 'no-store',
          },
        })
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'COT_FAILED'
        const status =
          code === 'COT_NO_SESSION' ? 404 : code === 'COT_INVALID_ARGUMENT' ? 400 : code === 'COT_NO_REASONING' ? 409 : 500
        return jsonResponse(status, { error: code, message: messageOf(error) })
      }
    }
    cctx.effect(() => {
      try {
        return cctx.connection.fetch.register({
          path: settings.routePath,
          methods: ['GET', 'HEAD'],
          requestBody: 'buffered',
          fetch: handleFetch,
        })
      } catch (error) {
        warn(
          `the browser route ${settings.routePath} could not be registered (another plugin may own that exact path); ` +
            'the /cot command and the cot_export tool still work',
          error,
        )
        return undefined
      }
    })
  }

  return { exportSession, prepareReview, registerRoute }
}

/** @param {number} status @param {object} body @returns {Response} */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Parse one `/cot` invocation. Format, scope and target are accepted in any
 * order; `review` collects the remaining text as the review focus.
 * @param {unknown} rawInput - everything after the command name.
 * @returns {{error?: string, review?: boolean, focus?: string, format?: string, scope?: string, target?: string}} parsed request.
 */
function parseCommandLine(rawInput) {
  const tokens = String(rawInput ?? '')
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '')
  if (tokens.length > 0 && tokens[0].toLowerCase() === 'review') {
    const focus = tokens.slice(1).join(' ').trim()
    return focus === '' ? { review: true } : { review: true, focus }
  }
  const request = {}
  const extras = []
  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (lower === 'all' || lower === 'surface') {
      request.scope = lower
      continue
    }
    if (FORMAT_TOKENS.has(lower)) {
      request.format = lower
      continue
    }
    if (request.target === undefined) {
      request.target = token
      continue
    }
    extras.push(token)
  }
  if (extras.length > 0) return { error: `unexpected "${extras.join(' ')}"` }
  return request
}

/**
 * Plugin entry.
 * @param {object} ctx - plugin context.
 * @param {Record<string, unknown>} config - validated plugin config.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  if (settings.enabled !== true) return
  const exporter = createExporter(ctx, settings)

  ctx.tools.register(
    defineTool({
      name: 'cot_export',
      description:
        "Export one DSH session's complete model chain-of-thought — every reasoning block the model emitted, turn by turn — " +
        'to a Markdown, JSON, JSONL or text file, and return the absolute path. Defaults to the calling session; pass another ' +
        "session_id to read a different session in the same workspace, or 'latest' for the newest other session there. " +
        'The Markdown artifact opens with a turn index (line numbers) so a reader can page through it with the read tool. ' +
        'Use it when the user wants to export, archive, compare or hand over what the model was thinking. ' +
        'Call cot_review instead when the goal is to have another agent supervise the reasoning.',
      parameters: {
        session_id: {
          type: 'string',
          description: "Target session: 'current' (default), 'latest' (newest other session in this workspace), an exact id, or a unique id prefix.",
        },
        format: {
          type: 'string',
          description: "Artifact format: markdown (default), json, jsonl or text. Defaults to the plugin's configured format.",
        },
        scope: {
          type: 'string',
          description:
            '"all" (default) exports every committed reasoning message, including stretches that compaction hid from the current ' +
            'context and marks them superseded; "surface" exports only what the current model context contains.',
        },
        include_descendants: {
          type: 'boolean',
          description: 'Also export every descendant subagent session into a tree directory beside the artifact, with an INDEX.md.',
        },
        include_context: {
          type: 'boolean',
          description: 'Include user prompts, assistant answers and tool-call names next to the reasoning. Defaults to the plugin config.',
        },
        include_failed_attempts: {
          type: 'boolean',
          description:
            'Also rebuild the reasoning of failed or aborted attempts from their recorded stream. Defaults to the plugin config (off).',
        },
        out_path: {
          type: 'string',
          description: 'Explicit artifact path; absolute, or relative to the target session working directory.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            session_id: { type: 'string', required: true },
            format: { type: 'string', required: true },
            scope: { type: 'string', required: true },
            path: { type: 'string', required: true },
            bytes: { type: 'number', required: true },
            turns: { type: 'number', required: true },
            steps: { type: 'number', required: true },
            reasoning_blocks: { type: 'number', required: true },
            reasoning_chars: { type: 'number', required: true },
            current_steps: { type: 'number', required: true },
            superseded_steps: { type: 'number', required: true },
            title: { type: 'string' },
            reasoning_tokens: { type: 'number' },
            inherited_steps: { type: 'number' },
            failed_attempts: { type: 'number' },
            models: { type: 'array', items: { type: 'string' } },
            preview: { type: 'string' },
            descendants: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  session_id: { type: 'string', required: true },
                  path: { type: 'string', required: true },
                  turns: { type: 'number', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const lines = [
            `CoT exported (${value.turns} turns, ${value.steps} steps, ${value.reasoning_chars} reasoning chars` +
              `${value.reasoning_tokens === undefined ? '' : `, ${value.reasoning_tokens} reasoning tokens`}) → ${value.path}`,
          ]
          const notes = []
          if (value.superseded_steps > 0) notes.push(`${value.superseded_steps} step(s) hidden from the current context`)
          if (value.inherited_steps !== undefined) notes.push(`${value.inherited_steps} inherited from the parent session`)
          if (value.failed_attempts !== undefined) notes.push(`${value.failed_attempts} failed attempt(s) recorded`)
          if (notes.length > 0) lines.push(`Notes: ${notes.join('; ')}`)
          if (Array.isArray(value.descendants) && value.descendants.length > 0) {
            lines.push(`Descendants: ${value.descendants.length} session(s) exported under ${path.dirname(value.path)}`)
          }
          lines.push(
            value.format === 'markdown'
              ? 'Read it with the read tool (frontmatter and ## Index carry the line ranges), or call cot_review to prepare a supervised review.'
              : 'Read or process it with the read tool; call cot_review when you need a supervised review package (it writes Markdown).',
          )
          if (typeof value.preview === 'string' && value.preview !== '') lines.push('', `First reasoning: ${value.preview}`)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: args?.session_id === undefined ? 'Export CoT' : `Export CoT (${args.session_id})`,
        kind: 'other',
      }),
      async execute(args, exec) {
        const result = await exporter.exportSession({
          sessionIdInput: args?.session_id,
          callerId: exec?.agent?.id,
          format: args?.format,
          scope: args?.scope,
          includeContext: args?.include_context,
          includeFailedAttempts: args?.include_failed_attempts,
          outPath: args?.out_path,
          includeDescendants: args?.include_descendants === true,
          signal: exec?.signal,
        })
        return result.value
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'cot_review',
      description:
        "Prepare a supervised review package for one session's chain of thought: writes the CoT artifact plus a REVIEW.md that " +
        'carries the review rubric, a window plan with exact line ranges, and a ready-to-pass delegation prompt. Returns the ' +
        'paths and the prompt. Hand that prompt to the subagent tool, a teammate, or another session — this tool only prepares ' +
        'the package, it does not start the reviewer. Use it when the user wants a second agent to audit or supervise the reasoning.',
      parameters: {
        session_id: {
          type: 'string',
          description: "Target session: 'current' (default), 'latest', an exact id, or a unique id prefix.",
        },
        focus: {
          type: 'string',
          description: 'What the review should emphasise, for example "correctness", "wasted effort" or "instruction following".',
        },
        window_turns: {
          type: 'number',
          description: "Turns per review window. 0 means one window. Defaults to the plugin's configured window size.",
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            session_id: { type: 'string', required: true },
            cot_path: { type: 'string', required: true },
            review_path: { type: 'string', required: true },
            turns: { type: 'number', required: true },
            steps: { type: 'number', required: true },
            reasoning_chars: { type: 'number', required: true },
            delegation_prompt: { type: 'string', required: true },
            windows: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  turn_from: { type: 'number', required: true },
                  turn_to: { type: 'number', required: true },
                  line_from: { type: 'number', required: true },
                  line_to: { type: 'number', required: true },
                  chars: { type: 'number', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const lines = [
            `Review package ready → ${value.review_path}`,
            `CoT artifact: ${value.cot_path} (${value.turns} turns, ${value.steps} steps, ${value.reasoning_chars} chars)`,
            Array.isArray(value.windows)
              ? `Windows: ${value.windows
                  .map((window) => `${window.turn_from}-${window.turn_to} lines ${window.line_from}-${window.line_to}`)
                  .join('; ')}`
              : 'Windows: 1',
            '',
            'Pass this prompt to the reviewer you use (the subagent tool, a teammate, or another session):',
            value.delegation_prompt,
          ]
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall: (args) => ({
        card: 'generic',
        title: args?.session_id === undefined ? 'Prepare CoT review' : `Prepare CoT review (${args.session_id})`,
        kind: 'other',
      }),
      async execute(args, exec) {
        const result = await exporter.prepareReview({
          sessionIdInput: args?.session_id,
          callerId: exec?.agent?.id,
          focus: args?.focus,
          windowTurns: args?.window_turns,
          signal: exec?.signal,
        })
        return result.value
      },
    }),
  )

  ctx.inject(['commands'], (cctx) => {
    cctx.effect(() => {
      try {
        return cctx.commands.register({
          name: 'cot',
          description: "Export this session's model chain-of-thought, or prepare a review package for another agent",
          input: { hint: '[md|json|jsonl|txt] [all|surface] [session-id|latest] | review [focus]' },
          handler: async (invocation) => {
            const callerId = invocation?.agent?.id
            const parsed = parseCommandLine(invocation?.rawInput)
            if (typeof parsed.error === 'string') {
              return { kind: 'error', text: `${parsed.error} — usage: ${USAGE}` }
            }
            try {
              if (parsed.review === true) {
                const prepared = await exporter.prepareReview({
                  sessionIdInput: parsed.target,
                  callerId,
                  focus: parsed.focus,
                  windowTurns: settings.reviewWindowTurns,
                })
                return {
                  kind: 'success',
                  text:
                    `CoT review package ready (${prepared.value.turns} turns, ${prepared.value.steps} steps)\n` +
                    `CoT: ${prepared.value.cot_path}\nReview: ${prepared.value.review_path}\n` +
                    'Hand REVIEW.md — or the delegation prompt from cot_review — to the agent that should supervise it.',
                }
              }
              const result = await exporter.exportSession({
                sessionIdInput: parsed.target,
                callerId,
                format: parsed.format,
                scope: parsed.scope,
                outPath: undefined,
                includeDescendants: false,
                previewLimit: 0,
              })
              return {
                kind: 'success',
                text:
                  `CoT exported (${result.value.turns} turns, ${result.value.steps} steps, ` +
                  `${result.value.reasoning_chars} reasoning chars) → ${result.value.path}`,
              }
            } catch (error) {
              return { kind: 'error', text: messageOf(error) }
            }
          },
        })
      } catch (error) {
        warn('the /cot command could not be registered (another registration may own that name)', error)
        return undefined
      }
    })
  })

  ctx.inject(['connection'], (cctx) => {
    exporter.registerRoute(cctx)
  })

  ctx.inject(['skills'], (cctx) => {
    if (settings.enableSkill !== true) return
    cctx.effect(() => {
      try {
        return cctx.skills.register({
          name: 'cot-review',
          description:
            'Review a DSH chain-of-thought export for goal drift, evidence discipline, wasted effort, verification and risk.',
          whenToUse: 'When asked to analyse, audit or supervise what another session or agent was reasoning.',
          source: 'bundled',
          invocation: { modelInvocable: true, userInvocable: false },
          content: RUBRIC,
        })
      } catch (error) {
        warn('the cot-review skill could not be registered', error)
        return undefined
      }
    })
  })
}
