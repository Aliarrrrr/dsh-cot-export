/**
 * Pure core of dsh-cot-export.
 *
 * Turns one session's raw event log into a chain-of-thought model and renders
 * that model as Markdown, JSON, JSONL or plain text. This module performs no
 * I/O and touches no Cordis context, so every transformation here is testable
 * in isolation. Writing the artifact belongs to `index.js`.
 *
 * The chain of thought lives in `assistant/message` events: each committed
 * assistant message carries content blocks, and a `{ type: 'reasoning' }` block
 * is one stretch of model reasoning. A failed or aborted attempt commits
 * `assistant/attempt` instead, whose reasoning survives only inside the compact
 * timed stream, so it is rebuilt from `reasoning-chunks`/`reasoning-delta`.
 */

import path from 'node:path'

/** Identifies the artifact layout produced by this module. */
export const SCHEMA = 'dsh-cot/v1'

const FORMAT_BY_NAME = new Map([
  ['markdown', 'markdown'],
  ['md', 'markdown'],
  ['json', 'json'],
  ['jsonl', 'jsonl'],
  ['ndjson', 'jsonl'],
  ['text', 'text'],
  ['txt', 'text'],
  ['plain', 'text'],
  ['html', 'html'],
  ['htm', 'html'],
  ['replay', 'html'],
])

const EXTENSION_BY_FORMAT = new Map([
  ['markdown', '.md'],
  ['json', '.json'],
  ['jsonl', '.jsonl'],
  ['text', '.txt'],
  ['html', '.html'],
])

const MIME_BY_FORMAT = new Map([
  ['markdown', 'text/markdown; charset=utf-8'],
  ['json', 'application/json; charset=utf-8'],
  ['jsonl', 'application/x-ndjson; charset=utf-8'],
  ['text', 'text/plain; charset=utf-8'],
  ['html', 'text/html; charset=utf-8'],
])

const SCOPE_VALUES = new Set(['all', 'surface'])

/** Longest tool result kept in the extracted model (the HTML view marks the cut). */
const MAX_TOOL_RESULT_CHARS = 4000

/**
 * Build one pluggable error whose message starts with a stable code, so a tool
 * result renders as a single actionable line instead of a stack trace.
 * @param {string} code - stable machine code, for example `COT_NO_SESSION`.
 * @param {string} message - human-readable explanation and next step.
 * @returns {Error} the error to throw.
 */
export function cotError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.name = 'CotExportError'
  error.code = code
  return error
}

/**
 * Normalize one model-supplied format name.
 * @param {unknown} value - raw format such as `md`, `jsonl`, `text` or `html`.
 * @returns {'markdown'|'json'|'jsonl'|'text'|'html'} the canonical format.
 */
export function parseFormat(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw cotError('COT_INVALID_ARGUMENT', 'format must be one of markdown, json, jsonl, text, html')
  }
  const format = FORMAT_BY_NAME.get(value.trim().toLowerCase())
  if (format === undefined) {
    throw cotError('COT_INVALID_ARGUMENT', `unknown format "${value}" — use markdown, json, jsonl, text or html`)
  }
  return format
}

/**
 * Normalize one scope name.
 * @param {unknown} value - `all` or `surface`.
 * @returns {'all'|'surface'} the canonical scope.
 */
export function parseScope(value) {
  if (typeof value !== 'string' || !SCOPE_VALUES.has(value.trim().toLowerCase())) {
    throw cotError('COT_INVALID_ARGUMENT', 'scope must be "all" (complete log) or "surface" (current model context)')
  }
  return /** @type {'all'|'surface'} */ (value.trim().toLowerCase())
}

/** @param {string} format @returns {string} the file extension, with the dot. */
export function extensionOf(format) {
  return EXTENSION_BY_FORMAT.get(format) ?? '.md'
}

/** @param {string} format @returns {string} the artifact media type. */
export function mimeOf(format) {
  return MIME_BY_FORMAT.get(format) ?? 'text/plain; charset=utf-8'
}

/**
 * Turn a session title into one safe file-name fragment.
 * @param {unknown} value - title, session id, or any human label.
 * @returns {string} a non-empty fragment safe on Windows and POSIX.
 */
export function slugify(value) {
  const raw = typeof value === 'string' ? value : ''
  // eslint-disable-next-line no-control-regex
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  if (cleaned === '') return 'session'
  return cleaned.slice(0, 48)
}

/**
 * Compact, sortable timestamp used in artifact file names.
 * @param {number} ms - epoch milliseconds.
 * @returns {string} `yyyyMMdd-HHmmss`.
 */
export function timestampSlug(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** @param {string} sessionId @returns {string} a short readable id fragment. */
export function shortSessionId(sessionId) {
  const raw = typeof sessionId === 'string' ? sessionId : ''
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(raw)
  if (match !== null) return match[1].slice(0, 8)
  const tail = raw.replace(/^session-/, '').replace(/[^A-Za-z0-9]/g, '')
  return tail.slice(-8) || 'session'
}

/**
 * Compute the artifact path for one export, before collision handling.
 * @param {object} options - path inputs.
 * @param {string} options.baseDir - directory the relative output dir resolves against.
 * @param {string} options.outputDir - configured output directory.
 * @param {string} options.format - canonical format.
 * @param {string} options.sessionId - target session id.
 * @param {string} [options.title] - folded session title.
 * @param {string} [options.outPath] - explicit caller-supplied path.
 * @param {number} options.exportedAt - epoch milliseconds of the export.
 * @returns {string} an absolute candidate path.
 */
export function buildExportPath(options) {
  const { baseDir, outputDir, format, sessionId, title, outPath, exportedAt } = options
  const extension = extensionOf(format)
  if (typeof outPath === 'string' && outPath.trim() !== '') {
    const candidate = path.isAbsolute(outPath) ? outPath : path.resolve(baseDir, outPath)
    return path.extname(candidate) === '' ? `${candidate}${extension}` : candidate
  }
  const directory =
    typeof outputDir === 'string' && path.isAbsolute(outputDir)
      ? outputDir
      : path.resolve(baseDir, typeof outputDir === 'string' && outputDir !== '' ? outputDir : 'cot-exports')
  const label = typeof title === 'string' && title.trim() !== '' ? title : sessionId
  const name = `${slugify(label)}-${shortSessionId(sessionId)}-${timestampSlug(exportedAt)}${extension}`
  return path.join(directory, name)
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** @param {unknown} content @returns {{text: string}[]} visible text blocks. */
function textBlocksOf(content) {
  const blocks = []
  if (!Array.isArray(content)) return blocks
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text })
    }
  }
  return blocks
}

/** @param {unknown} content @returns {string[]} verbatim reasoning block texts. */
function reasoningTextsOf(content) {
  const texts = []
  if (!Array.isArray(content)) return texts
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'reasoning' && typeof block.text === 'string') {
      texts.push(block.text)
    }
  }
  return texts
}

/** @param {unknown} content @returns {{id?: string, name: string, arguments: string}[]} tool-call blocks. */
function toolCallsOf(content) {
  const calls = []
  if (!Array.isArray(content)) return calls
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'tool-call') {
      const call = {
        name: typeof block.name === 'string' ? block.name : 'tool',
        arguments: typeof block.arguments === 'string' ? block.arguments : '',
      }
      // The id is what pairs this call with its recorded result.
      if (typeof block.id === 'string' && block.id !== '') call.id = block.id
      calls.push(call)
    }
  }
  return calls
}

/**
 * Rebuild the reasoning text of one failed attempt from its compact timed
 * stream. The authoritative `block-end` text wins; otherwise the delta records
 * are joined in block order.
 * @param {unknown} stream - `assistant/attempt.data.stream`.
 * @returns {string} the reconstructed reasoning, or an empty string.
 */
export function reasoningFromAttemptStream(stream) {
  if (!Array.isArray(stream)) return ''
  const byIndex = new Map()
  let loose = ''
  let authoritative = ''
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    if (record.type === 'reasoning-chunks') {
      const index = typeof record.index === 'number' ? record.index : 0
      const text = Array.isArray(record.texts)
        ? record.texts.filter((part) => typeof part === 'string').join('')
        : ''
      byIndex.set(index, `${byIndex.get(index) ?? ''}${text}`)
      continue
    }
    if (record.type !== 'chunk') continue
    const chunk = record.chunk
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      loose += chunk.text
      continue
    }
    if (
      chunk.type === 'block-end' &&
      chunk.block !== null &&
      typeof chunk.block === 'object' &&
      chunk.block.type === 'reasoning' &&
      typeof chunk.block.text === 'string'
    ) {
      authoritative = chunk.block.text
    }
  }
  if (authoritative !== '') return authoritative
  const chained = [...byIndex.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, text]) => text)
    .join('')
  return chained !== '' ? chained : loose
}

function isSurfaceCurrent(surfaceOf, seq) {
  const surface = surfaceOf instanceof Map ? surfaceOf.get(seq) : undefined
  return surface === undefined || surface === 'current'
}

/**
 * Extract the chain-of-thought model from a session log.
 * @param {object} input - extraction inputs.
 * @param {object} input.session - session header.
 * @param {number} [input.inheritedEventCount] - events below this seq came from a fork parent.
 * @param {readonly object[]} input.events - the complete raw event log.
 * @param {Map<number, string>} [input.surfaceOf] - seq to `current`/`shadowed` classification.
 * @param {string} [input.title] - folded session title.
 * @param {number} input.exportedAt - epoch milliseconds of the export.
 * @param {'all'|'surface'} [input.scope] - which assistant messages to keep.
 * @param {boolean} [input.includeContext] - keep user prompts, answers and tool names.
 * @param {boolean} [input.includeFailedAttempts] - rebuild failed attempts' reasoning.
 * @returns {object} the plain-JSON chain-of-thought model.
 * @throws {Error} `COT_NO_REASONING` when the session recorded no reasoning at all.
 */
export function extractCoT(input) {
  const {
    session,
    inheritedEventCount = 0,
    events,
    surfaceOf,
    title,
    exportedAt,
    scope = 'all',
    includeContext = true,
    includeFailedAttempts = false,
    exporter,
  } = input ?? {}
  const inheritedCut = Number.isFinite(inheritedEventCount) ? /** @type {number} */ (inheritedEventCount) : 0
  const ordered = Array.isArray(events)
    ? events.slice().sort((left, right) => (left?.seq ?? 0) - (right?.seq ?? 0))
    : []

  const userTextByTurn = new Map()
  const records = new Map()
  let shadowedCount = 0
  let failedAttemptCount = 0
  let interruptedCount = 0
  /** callId → tool name, so a result can be labelled without guessing. */
  const callNameById = new Map()
  /** `turn:step` → tool results recorded for that step. */
  const toolResultsByStep = new Map()

  for (const event of ordered) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const seq = typeof event.seq === 'number' ? event.seq : 0
    const turn = Number.isInteger(data.turn) ? data.turn : undefined
    const step = Number.isInteger(data.step) ? data.step : undefined

    if (event.type === 'tool/call') {
      const callId = typeof data.callId === 'string' ? data.callId : undefined
      if (callId !== undefined && typeof data.name === 'string') callNameById.set(callId, data.name)
      continue
    }

    if (event.type === 'tool/result') {
      if (turn === undefined || step === undefined) continue
      const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined
      const text = textBlocksOf(message.content)
        .map((block) => block.text)
        .join('\n')
        .trim()
      const entry = { chars: text.length }
      if (callId !== undefined) {
        entry.call_id = callId
        const name = callNameById.get(callId)
        if (name !== undefined) entry.name = name
      }
      if (message.isError === true || data.isError === true) entry.is_error = true
      if (text.length > MAX_TOOL_RESULT_CHARS) {
        entry.text = `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…`
        entry.truncated = true
      } else {
        entry.text = text
      }
      const resultKey = `${turn}:${step}`
      const bucket = toolResultsByStep.get(resultKey)
      if (bucket === undefined) toolResultsByStep.set(resultKey, [entry])
      else bucket.push(entry)
      continue
    }

    if (event.type === 'user/message') {
      if (turn === undefined || userTextByTurn.has(turn)) continue
      const text = textBlocksOf(data.message?.content)
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text !== '') userTextByTurn.set(turn, text)
      continue
    }

    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    if (turn === undefined || step === undefined) continue

    const key = `${turn}:${step}`
    let record = records.get(key)
    if (record === undefined) {
      record = { turn, step, order: seq, committed: undefined, attempts: [], lastTime: undefined }
      records.set(key, record)
    }

    if (event.type === 'assistant/message') {
      const current = isSurfaceCurrent(surfaceOf, seq)
      if (!current) shadowedCount += 1
      const interrupted = data.interrupted === true
      if (interrupted) interruptedCount += 1
      const source = data.message?.source
      record.committed = {
        seq,
        time: typeof event.time === 'number' ? event.time : data.message?.time,
        content: data.message?.content,
        usage: data.usage,
        provider: typeof source?.provider === 'string' ? source.provider : undefined,
        model: typeof source?.model === 'string' ? source.model : undefined,
        interrupted,
        superseded: !current,
        inherited: seq < inheritedCut,
      }
      record.lastTime = typeof event.time === 'number' ? event.time : record.lastTime
      continue
    }

    failedAttemptCount += 1
    if (typeof event.time === 'number') record.lastTime = event.time
    if (includeFailedAttempts) {
      const text = reasoningFromAttemptStream(data.stream)
      if (text !== '') record.attempts.push({ time: typeof event.time === 'number' ? event.time : undefined, text })
    }
  }

  const kept = []
  for (const record of records.values()) {
    const committed = record.committed
    if (scope === 'surface' && committed === undefined) continue
    if (scope === 'surface' && committed !== undefined && committed.superseded) continue
    kept.push(record)
  }
  kept.sort((left, right) => left.turn - right.turn || left.step - right.step || left.order - right.order)

  let reasoningBlocks = 0
  let reasoningChars = 0
  let reasoningTokens = 0
  let currentSteps = 0
  let inheritedSteps = 0
  const models = []
  const turns = new Map()
  let firstAt
  let lastAt

  for (const record of kept) {
    const committed = record.committed
    const content = committed?.content
    const reasoningTexts = committed === undefined ? [] : reasoningTextsOf(content)
    const attemptTexts = record.attempts.map((attempt) => attempt.text)
    const texts = reasoningTexts.concat(attemptTexts)

    const stepModel = committed?.model
    const step = {
      step: record.step,
      time: committed?.time ?? record.attempts[0]?.time ?? record.lastTime,
      failed: committed === undefined,
    }
    if (typeof stepModel === 'string' && stepModel !== '') {
      step.model = stepModel
      if (!models.includes(stepModel)) models.push(stepModel)
    }
    if (typeof committed?.provider === 'string' && committed.provider !== '') step.provider = committed.provider
    if (committed?.interrupted === true) step.interrupted = true
    if (committed?.inherited === true) step.inherited = true
    if (committed?.superseded === true) step.superseded = true
    if (committed?.usage !== undefined) step.usage = committed.usage
    if (texts.length > 0) {
      step.reasoning = reasoningTexts.map((text, index) => ({ index, text, chars: text.length }))
      if (step.reasoning.length === 0) delete step.reasoning
      if (attemptTexts.length > 0) {
        step.attempt_reasoning = attemptTexts.map((text) => ({ text, chars: text.length }))
      }
    }
    if (includeContext && committed !== undefined) {
      const answer = textBlocksOf(content)
      if (answer.length > 0) step.answer = answer
      const calls = toolCallsOf(content)
      if (calls.length > 0) step.tool_calls = calls
    }
    if (includeContext) {
      const results = toolResultsByStep.get(`${record.turn}:${record.step}`)
      if (results !== undefined && results.length > 0) step.tool_results = results
    }
    for (const text of texts) {
      reasoningChars += text.length
    }
    reasoningBlocks += texts.length
    if (typeof committed?.usage?.reasoningTokens === 'number') reasoningTokens += committed.usage.reasoningTokens
    if (committed !== undefined && committed.superseded !== true) currentSteps += 1
    if (committed?.inherited === true) inheritedSteps += 1

    if (typeof step.time === 'number') {
      if (firstAt === undefined || step.time < firstAt) firstAt = step.time
      if (lastAt === undefined || step.time > lastAt) lastAt = step.time
    }

    let turnEntry = turns.get(record.turn)
    if (turnEntry === undefined) {
      turnEntry = { turn: record.turn, steps: [] }
      turns.set(record.turn, turnEntry)
    }
    turnEntry.steps.push(step)
  }

  if (reasoningBlocks === 0) {
    throw cotError(
      'COT_NO_REASONING',
      `session ${session?.id ?? '(unknown)'} recorded no model reasoning — reasoning effort may be off, the model may not emit chain of thought, or the selected scope (${scope}) hides every reasoning message`,
    )
  }

  const orderedTurns = [...turns.values()].sort((left, right) => left.turn - right.turn)
  for (const turnEntry of orderedTurns) {
    const userText = userTextByTurn.get(turnEntry.turn)
    if (includeContext && typeof userText === 'string') turnEntry.user_text = userText
  }

  const header = session ?? {}
  const modelSession = { id: typeof header.id === 'string' ? header.id : 'unknown' }
  if (typeof header.version === 'number') modelSession.format_version = header.version
  if (typeof title === 'string' && title.trim() !== '') modelSession.title = title.trim()
  if (typeof header.cwd === 'string' && header.cwd !== '') modelSession.cwd = header.cwd
  if (typeof header.parentSession === 'string' && header.parentSession !== '') {
    modelSession.parent_session = header.parentSession
  }
  if (typeof header.origin === 'string' && header.origin !== '') modelSession.origin = header.origin
  if (typeof header.delegationDepth === 'number') modelSession.delegation_depth = header.delegationDepth
  if (typeof header.agentPreset === 'string' && header.agentPreset !== '') modelSession.agent_preset = header.agentPreset
  if (typeof header.createdAt === 'number') modelSession.created_at = header.createdAt
  if (header.isSeeded === true) modelSession.is_seeded = true

  const stats = {
    turns: orderedTurns.length,
    steps: kept.length,
    reasoning_blocks: reasoningBlocks,
    reasoning_chars: reasoningChars,
    current_steps: currentSteps,
    superseded_steps: shadowedCount,
    inherited_steps: inheritedSteps,
    failed_attempts: failedAttemptCount,
    interrupted_steps: interruptedCount,
    models: models.slice(),
  }
  if (reasoningTokens > 0) stats.reasoning_tokens = reasoningTokens
  if (firstAt !== undefined) stats.first_at = firstAt
  if (lastAt !== undefined) stats.last_at = lastAt

  const model = { schema: SCHEMA, session: modelSession }
  // This artifact is a derived view of the session's event log, not a copy of it.
  // The built-in "Download session log" / `/export` remains the complete archive
  // (attachments, request headers, internal events).
  model.derived_from = 'dsh-session-event-log'
  if (typeof exporter === 'string' && exporter !== '') model.exporter = exporter
  model.exported_at = exportedAt ?? Date.now()
  model.scope = scope
  model.stats = stats
  model.turns = orderedTurns
  return model
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const pad2 = (value) => String(value).padStart(2, '0')

/** @param {number} ms @returns {string} `yyyy-MM-dd HH:mm:ss` in local time. */
function formatDateTime(ms) {
  const date = new Date(ms)
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  )
}

/** @param {number} ms @returns {string} `HH:mm:ss` in local time. */
function formatClock(ms) {
  const date = new Date(ms)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** @param {number} ms @returns {string} ISO 8601 with the local UTC offset. */
export function formatIsoWithOffset(ms) {
  const date = new Date(ms)
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  return `${formatDateTime(ms).replace(' ', 'T')}${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
}

/** @param {unknown} value @returns {string} one YAML-safe scalar. */
function yamlScalar(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const text = typeof value === 'string' ? value : String(value ?? '')
  if (/^[A-Za-z0-9_./-]+$/.test(text) && !/^(true|false|null|yes|no|on|off)$/i.test(text)) return text
  return JSON.stringify(text)
}

/**
 * Choose a fence long enough for the text it wraps, so reasoning that itself
 * contains backticks can never terminate the block early.
 * @param {string} text @returns {string} the opening and closing fence.
 */
function fenceFor(text) {
  let longest = 0
  const matches = String(text ?? '').match(/`+/g)
  if (matches !== null) for (const run of matches) if (run.length > longest) longest = run.length
  return '`'.repeat(Math.max(3, longest + 1))
}

function truncateInline(text, limit) {
  const collapsed = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (collapsed.length <= limit) return collapsed
  return `${collapsed.slice(0, limit - 1)}…`
}

/**
 * Render the Markdown artifact together with the line span of every turn.
 * @param {object} model - extracted model.
 * @param {{includeContext?: boolean}} [options] - render options.
 * @returns {{text: string, turnLines: {turn: number, lineFrom: number, lineTo: number, chars: number}[]}} artifact + jump table.
 */
export function renderMarkdownWithIndex(model, options = {}) {
  const includeContext = options.includeContext !== false
  const head = ['---', `schema: ${SCHEMA}`]
  head.push(`session: ${yamlScalar(model.session.id)}`)
  if (model.session.format_version !== undefined) head.push(`session_format: ${model.session.format_version}`)
  if (model.session.title !== undefined) head.push(`title: ${yamlScalar(model.session.title)}`)
  if (model.session.cwd !== undefined) head.push(`cwd: ${yamlScalar(model.session.cwd)}`)
  if (model.session.parent_session !== undefined) head.push(`parent_session: ${yamlScalar(model.session.parent_session)}`)
  if (model.session.origin !== undefined) head.push(`origin: ${yamlScalar(model.session.origin)}`)
  if (model.session.agent_preset !== undefined) head.push(`agent_preset: ${yamlScalar(model.session.agent_preset)}`)
  if (model.session.created_at !== undefined) head.push(`created_at: ${formatIsoWithOffset(model.session.created_at)}`)
  head.push(`models: [${model.stats.models.map(yamlScalar).join(', ')}]`)
  head.push(`exported_at: ${formatIsoWithOffset(model.exported_at)}`)
  if (model.exporter !== undefined) head.push(`exporter: ${yamlScalar(model.exporter)}`)
  if (model.derived_from !== undefined) head.push(`derived_from: ${yamlScalar(model.derived_from)}`)
  head.push(`scope: ${model.scope}`)
  for (const key of [
    'turns',
    'steps',
    'reasoning_blocks',
    'reasoning_chars',
    'reasoning_tokens',
    'current_steps',
    'superseded_steps',
    'inherited_steps',
    'failed_attempts',
  ]) {
    if (model.stats[key] !== undefined) head.push(`${key}: ${model.stats[key]}`)
  }
  head.push('---', '')

  const title = truncateInline(model.session.title ?? model.session.id, 200)
  head.push(`# Chain of Thought — ${title}`, '')
  const summary = [
    `- Session \`${model.session.id}\`` +
      (model.session.parent_session === undefined ? '' : ` (fork of \`${model.session.parent_session}\`)`),
    `- Workspace \`${model.session.cwd ?? '(none)'}\`` +
      (model.session.agent_preset === undefined ? '' : ` · preset \`${model.session.agent_preset}\``),
    `- ${model.stats.turns} turns · ${model.stats.steps} steps · ${model.stats.reasoning_chars} reasoning chars` +
      (model.stats.reasoning_tokens === undefined ? '' : ` · ${model.stats.reasoning_tokens} reasoning tokens`),
    `- Scope \`${model.scope}\`` +
      (model.stats.superseded_steps > 0
        ? ` · ${model.stats.superseded_steps} reasoning steps hidden from the current model context by compaction`
        : ''),
    '',
  ]
  head.push(...summary)

  const turnBlocks = []
  const turnMeta = []
  /**
   * Append verbatim text as physical lines. The turn index counts real lines of
   * the finished document, so one array entry must never carry its own newlines.
   * @param {string[]} block - lines of the block being built.
   * @param {string} text - verbatim text, possibly multi-line.
   */
  const pushVerbatim = (block, text) => {
    for (const line of String(text).split('\n')) block.push(line)
  }
  for (const turnEntry of model.turns) {
    const block = []
    const firstTime = turnEntry.steps.find((step) => typeof step.time === 'number')?.time
    block.push(`## Turn ${turnEntry.turn}${firstTime === undefined ? '' : ` — ${formatDateTime(firstTime)}`}`, '')
    if (includeContext && typeof turnEntry.user_text === 'string') {
      block.push(`> **User:** ${truncateInline(turnEntry.user_text, 400)}`, '')
    }
    let turnChars = 0
    for (const step of turnEntry.steps) {
      const heading = [`### Step ${step.step}`]
      if (step.failed === true) heading.push('(failed attempt)')
      if (typeof step.model === 'string') heading.push(`· ${step.model}`)
      if (typeof step.time === 'number') heading.push(`· ${formatClock(step.time)}`)
      block.push(heading.join(' '), '')
      if (step.superseded === true) block.push('> ⚠ superseded — hidden from the current model context by compaction', '')
      if (step.inherited === true) block.push('> ↺ inherited from the parent session', '')
      if (step.interrupted === true) block.push('> ⚠ the turn was interrupted while this step ran', '')
      const reasoning = Array.isArray(step.reasoning) ? step.reasoning : []
      if (reasoning.length > 0) {
        block.push('**Reasoning**', '')
        for (const part of reasoning) {
          const fence = fenceFor(part.text)
          block.push(fence)
          pushVerbatim(block, part.text)
          block.push(fence, '')
          turnChars += part.text.length
        }
      }
      const attempts = Array.isArray(step.attempt_reasoning) ? step.attempt_reasoning : []
      for (const attempt of attempts) {
        block.push('**Reasoning of the failed attempt**', '')
        const fence = fenceFor(attempt.text)
        block.push(fence)
        pushVerbatim(block, attempt.text)
        block.push(fence, '')
        turnChars += attempt.text.length
      }
      if (includeContext && Array.isArray(step.answer)) {
        const text = step.answer
          .map((part) => part.text)
          .join('\n\n')
          .trim()
        if (text !== '') {
          block.push('**Answer**', '')
          pushVerbatim(block, text)
          block.push('')
        }
      }
      if (includeContext && Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
        const names = [...new Set(step.tool_calls.map((call) => `\`${call.name}\``))]
        block.push(`**Tools** · ${names.join(' · ')}`, '')
      }
    }
    turnBlocks.push(block)
    turnMeta.push({ turn: turnEntry.turn, chars: turnChars })
  }

  const indexPrefix = ['## Index', '', '| Turn | Steps | CoT chars | Line |', '|---|---|---|---|']
  const rowsStart = head.length + indexPrefix.length
  const turnsStart = rowsStart + turnBlocks.length + 1
  const rows = []
  let cursor = turnsStart
  const turnLines = []
  for (let index = 0; index < turnBlocks.length; index += 1) {
    const block = turnBlocks[index]
    const meta = turnMeta[index]
    rows.push(`| ${meta.turn} | ${model.turns[index].steps.length} | ${meta.chars} | ${cursor + 1} |`)
    turnLines.push({
      turn: meta.turn,
      lineFrom: cursor + 1,
      lineTo: cursor + block.length,
      chars: meta.chars,
    })
    cursor += block.length
  }
  rows.push('')

  const lines = [...head, ...indexPrefix, ...rows]
  for (const block of turnBlocks) lines.push(...block)
  return { text: `${lines.join('\n')}\n`, turnLines }
}

/**
 * Render the extracted model in one of the supported formats.
 * @param {object} model - extracted model.
 * @param {'markdown'|'json'|'jsonl'|'text'|'html'} format - canonical format.
 * @param {{includeContext?: boolean}} [options] - render options.
 * @returns {{text: string, turnLines: object[]}} the artifact text and its Markdown jump table.
 */
export function render(model, format, options = {}) {
  switch (format) {
    case 'json':
      return { text: `${JSON.stringify(model, null, 2)}\n`, turnLines: [] }
    case 'jsonl':
      return { text: renderJsonl(model), turnLines: [] }
    case 'text':
      return { text: renderText(model, options), turnLines: [] }
    case 'html':
      return { text: renderHtml(model, options), turnLines: [] }
    default:
      return renderMarkdownWithIndex(model, options)
  }
}

/**
 * Render one JSON object per step for line-oriented tooling.
 * @param {object} model - extracted model.
 * @returns {string} the JSONL artifact text.
 */
export function renderJsonl(model) {
  const lines = []
  for (const turnEntry of model.turns) {
    for (const step of turnEntry.steps) {
      const row = {
        schema: SCHEMA,
        session_id: model.session.id,
        turn: turnEntry.turn,
        step: step.step,
        failed: step.failed === true,
        inherited: step.inherited === true,
        superseded: step.superseded === true,
        reasoning: (step.reasoning ?? []).map((part) => part.text),
      }
      if (typeof step.time === 'number') row.time = step.time
      if (step.model !== undefined) row.model = step.model
      if (step.provider !== undefined) row.provider = step.provider
      if (step.usage !== undefined) row.usage = step.usage
      if (Array.isArray(step.attempt_reasoning)) row.attempt_reasoning = step.attempt_reasoning.map((part) => part.text)
      if (Array.isArray(step.answer)) row.answer = step.answer.map((part) => part.text)
      if (Array.isArray(step.tool_calls)) row.tools = step.tool_calls.map((call) => call.name)
      lines.push(JSON.stringify(row))
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/**
 * Render a minimal plain-text artifact.
 * @param {object} model - extracted model.
 * @param {{includeContext?: boolean}} [options] - render options.
 * @returns {string} the text artifact.
 */
export function renderText(model, options = {}) {
  const includeContext = options.includeContext !== false
  const lines = [
    '=== DSH chain-of-thought export ===',
    `session: ${model.session.id}`,
    `title: ${model.session.title ?? '(untitled)'}`,
    `workspace: ${model.session.cwd ?? '(none)'}`,
    `exported: ${formatIsoWithOffset(model.exported_at)}`,
    `scope: ${model.scope}`,
    `turns: ${model.stats.turns}  steps: ${model.stats.steps}  reasoning chars: ${model.stats.reasoning_chars}`,
    '',
  ]
  for (const turnEntry of model.turns) {
    lines.push(`--- Turn ${turnEntry.turn} ---`, '')
    if (includeContext && typeof turnEntry.user_text === 'string') lines.push(`USER: ${turnEntry.user_text}`, '')
    for (const step of turnEntry.steps) {
      const flags = []
      if (step.failed === true) flags.push('failed')
      if (step.superseded === true) flags.push('superseded')
      if (step.inherited === true) flags.push('inherited')
      lines.push(
        `[Step ${step.step}]${flags.length === 0 ? '' : ` (${flags.join(', ')})`}` +
          `${typeof step.model === 'string' ? ` ${step.model}` : ''}` +
          `${typeof step.time === 'number' ? ` ${formatClock(step.time)}` : ''}`,
      )
      for (const part of step.reasoning ?? []) lines.push(part.text)
      for (const part of step.attempt_reasoning ?? []) lines.push(`(failed attempt) ${part.text}`)
      if (includeContext && Array.isArray(step.answer)) {
        const text = step.answer
          .map((part) => part.text)
          .join('\n\n')
          .trim()
        if (text !== '') lines.push(`ANSWER: ${text}`)
      }
      if (includeContext && Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
        lines.push(`TOOLS: ${[...new Set(step.tool_calls.map((call) => call.name))].join(', ')}`)
      }
      lines.push('')
    }
  }
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Self-contained HTML timeline
// ---------------------------------------------------------------------------

/** @param {unknown} value @returns {string} text safe for HTML content and attributes. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** @param {unknown} value @returns {string} a grouped count, stable across locales. */
function countText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const HTML_CSS = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--muted:#5d6673;--line:#e2e6ec;--accent:#2f6fed;--ok:#177245;--bad:#b42318;--warn:#9a6700;--code:#f3f5f8;--rail:#d7dee8}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--card:#161b22;--ink:#e6edf3;--muted:#8b98a5;--line:#243040;--accent:#6ea8fe;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--code:#0b0f14;--rail:#1f2a37}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 64px}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;justify-content:space-between;margin-bottom:18px}
h1{margin:0 0 4px;font-size:20px;line-height:1.3;font-weight:650}
.sub{margin:0;color:var(--muted);font-size:12px;word-break:break-all}
.acts{display:flex;gap:8px;flex:none}
.acts button{cursor:pointer;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:7px;padding:6px 10px;font-size:12px}
.acts button:hover{border-color:var(--accent);color:var(--accent)}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px;margin:0 0 16px}
.fact{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:9px 11px}
.fact b{display:block;font-size:17px;font-variant-numeric:tabular-nums;line-height:1.25}
.fact span{color:var(--muted);font-size:11px}
.toc{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 20px}
.toc a{color:var(--muted);text-decoration:none;font-size:11px;border:1px solid var(--line);border-radius:999px;padding:2px 8px}
.toc a:hover{color:var(--accent);border-color:var(--accent)}
.turn{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 16px 6px;margin:0 0 18px}
.turn-head{display:flex;align-items:baseline;gap:10px;border-bottom:1px solid var(--line);padding-bottom:8px;margin-bottom:12px}
.turn-no{font-weight:650;font-size:15px}
.turn-head time{color:var(--muted);font-size:12px}
.bubble{border-left:2px solid var(--rail);padding:2px 0 2px 12px;margin:0 0 14px}
.tag{display:inline-block;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin-bottom:2px}
.bubble pre{margin:0;white-space:pre-wrap;word-break:break-word;font:13px/1.55 inherit}
.step{border-left:2px solid var(--rail);padding:0 0 10px 12px;margin:0 0 14px}
.step-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:6px}
.step-no{font-weight:600;font-size:13px}
.step-head time,.step-head .model,.step-head .muted{color:var(--muted);font-size:11px}
.badge{font-size:10px;border:1px solid var(--line);border-radius:999px;padding:0 7px;color:var(--muted)}
.badge.bad{color:var(--bad);border-color:var(--bad)}
.badge.warn{color:var(--warn);border-color:var(--warn)}
.box{border:1px solid var(--line);border-radius:8px;margin:0 0 8px;background:var(--bg)}
.box>summary{cursor:pointer;padding:6px 10px;font-size:12px;font-weight:600;user-select:none}
.box[open]>summary{border-bottom:1px solid var(--line)}
.box .muted{font-weight:400;color:var(--muted)}
.box pre{margin:0;padding:10px;overflow:auto;max-height:420px;white-space:pre-wrap;word-break:break-word;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);border-radius:0 0 7px 7px}
.box pre.err{color:var(--bad)}
.tool-meta{padding:6px 10px 0;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
footer{margin-top:28px;color:var(--muted);font-size:11px;border-top:1px solid var(--line);padding-top:12px}
`

/**
 * Render a self-contained HTML timeline: turns → steps → reasoning → answer →
 * tool call with its recorded result. No external assets and no injected script
 * from the session; the only script is a fixed expand/collapse handler.
 * @param {object} model - extracted model.
 * @param {{includeContext?: boolean}} [options] - render options.
 * @returns {string} the HTML artifact.
 */
export function renderHtml(model, options = {}) {
  const includeContext = options.includeContext !== false
  const title = typeof model.session.title === 'string' && model.session.title.trim() !== '' ? model.session.title.trim() : model.session.id
  const parts = []
  parts.push('<!doctype html>')
  parts.push('<html lang="en">')
  parts.push('<head>')
  parts.push('<meta charset="utf-8">')
  parts.push('<meta name="viewport" content="width=device-width,initial-scale=1">')
  parts.push(`<meta name="generator" content="${escapeHtml(model.exporter ?? 'dsh-cot-export')}">`)
  parts.push(`<meta name="dsh-schema" content="${escapeHtml(SCHEMA)}">`)
  parts.push(`<title>${escapeHtml(`CoT timeline · ${title}`)}</title>`)
  parts.push(`<style>${HTML_CSS}</style>`)
  parts.push('</head>')
  parts.push('<body>')
  parts.push('<div class="wrap">')

  // Header
  parts.push('<header class="top">')
  parts.push('<div>')
  parts.push(`<h1>${escapeHtml(title)}</h1>`)
  const subParts = [`session ${escapeHtml(model.session.id)}`]
  if (typeof model.session.cwd === 'string') subParts.push(escapeHtml(model.session.cwd))
  if (typeof model.session.agent_preset === 'string') subParts.push(`preset ${escapeHtml(model.session.agent_preset)}`)
  if (Array.isArray(model.stats.models) && model.stats.models.length > 0) {
    subParts.push(model.stats.models.map((entry) => escapeHtml(entry)).join(', '))
  }
  parts.push(`<p class="sub">${subParts.join(' · ')}</p>`)
  parts.push('</div>')
  parts.push('<div class="acts">')
  parts.push('<button type="button" data-act="expand">Expand all</button>')
  parts.push('<button type="button" data-act="collapse">Collapse all</button>')
  parts.push('</div>')
  parts.push('</header>')

  // Facts
  const facts = [
    [countText(model.stats.turns), 'turns'],
    [countText(model.stats.steps), 'steps'],
    [countText(model.stats.reasoning_chars), 'reasoning chars'],
    [countText(model.stats.reasoning_tokens), 'reasoning tokens'],
  ]
  if (model.stats.superseded_steps > 0) facts.push([countText(model.stats.superseded_steps), 'hidden steps'])
  if (model.stats.failed_attempts > 0) facts.push([countText(model.stats.failed_attempts), 'failed attempts'])
  parts.push('<section class="facts">')
  for (const [value, label] of facts) parts.push(`<div class="fact"><b>${value}</b><span>${label}</span></div>`)
  parts.push('</section>')

  // Turn anchors
  if (model.turns.length > 1) {
    parts.push('<nav class="toc">')
    for (const turnEntry of model.turns) {
      parts.push(`<a href="#t${turnEntry.turn}">T${turnEntry.turn}</a>`)
    }
    parts.push('</nav>')
  }

  parts.push('<main>')
  for (const turnEntry of model.turns) {
    parts.push(`<section class="turn" id="t${turnEntry.turn}">`)
    const firstTime = turnEntry.steps.find((step) => typeof step.time === 'number')?.time
    parts.push('<div class="turn-head">')
    parts.push(`<span class="turn-no">Turn ${turnEntry.turn}</span>`)
    if (firstTime !== undefined) parts.push(`<time>${escapeHtml(formatDateTime(firstTime))}</time>`)
    parts.push('</div>')
    if (includeContext && typeof turnEntry.user_text === 'string' && turnEntry.user_text !== '') {
      parts.push('<div class="bubble">')
      parts.push('<span class="tag">user</span>')
      parts.push(`<pre>${escapeHtml(turnEntry.user_text)}</pre>`)
      parts.push('</div>')
    }

    for (const step of turnEntry.steps) {
      parts.push('<article class="step">')
      const badges = []
      if (step.failed === true) badges.push('<span class="badge bad">failed</span>')
      if (step.superseded === true) badges.push('<span class="badge warn">superseded</span>')
      if (step.inherited === true) badges.push('<span class="badge">inherited</span>')
      if (step.interrupted === true) badges.push('<span class="badge warn">interrupted</span>')
      parts.push('<div class="step-head">')
      parts.push(`<span class="step-no">Step ${step.step}</span>`)
      if (typeof step.model === 'string' && step.model !== '') parts.push(`<span class="model">${escapeHtml(step.model)}</span>`)
      if (typeof step.time === 'number') parts.push(`<time>${escapeHtml(formatClock(step.time))}</time>`)
      if (typeof step.usage?.reasoningTokens === 'number' && step.usage.reasoningTokens > 0) {
        parts.push(`<span class="muted">${countText(step.usage.reasoningTokens)} reasoning tok</span>`)
      }
      for (const badge of badges) parts.push(badge)
      parts.push('</div>')

      const reasoning = Array.isArray(step.reasoning) ? step.reasoning : []
      if (reasoning.length > 0) {
        const chars = reasoning.reduce((total, part) => total + part.text.length, 0)
        parts.push(`<details class="box"><summary>Reasoning <span class="muted">${countText(chars)} chars</span></summary>`)
        for (const part of reasoning) parts.push(`<pre>${escapeHtml(part.text)}</pre>`)
        parts.push('</details>')
      }

      const attempts = Array.isArray(step.attempt_reasoning) ? step.attempt_reasoning : []
      for (const attempt of attempts) {
        parts.push('<details class="box"><summary>Reasoning of the failed attempt</summary>')
        parts.push(`<pre>${escapeHtml(attempt.text)}</pre>`)
        parts.push('</details>')
      }

      if (includeContext && Array.isArray(step.answer)) {
        const text = step.answer
          .map((part) => part.text)
          .join('\n\n')
          .trim()
        if (text !== '') {
          parts.push('<details class="box"><summary>Answer</summary>')
          parts.push(`<pre>${escapeHtml(text)}</pre>`)
          parts.push('</details>')
        }
      }

      if (includeContext) {
        const calls = Array.isArray(step.tool_calls) ? step.tool_calls : []
        const results = Array.isArray(step.tool_results) ? step.tool_results : []
        const used = new Set()
        for (const call of calls) {
          const match =
            call.id === undefined
              ? undefined
              : results.find((result) => result.call_id === call.id)
          if (match !== undefined) used.add(match)
          const state = match === undefined ? 'no result' : match.is_error === true ? 'failed' : 'ok'
          parts.push(`<details class="box"><summary>${escapeHtml(call.name)} <span class="muted">${state}</span></summary>`)
          parts.push('<div class="tool-meta">arguments</div>')
          parts.push(`<pre>${escapeHtml(call.arguments)}</pre>`)
          if (match !== undefined) {
            parts.push(`<div class="tool-meta">result${match.truncated === true ? ' · truncated' : ''}</div>`)
            parts.push(`<pre${match.is_error === true ? ' class="err"' : ''}>${escapeHtml(match.text)}</pre>`)
          }
          parts.push('</details>')
        }
        for (const result of results) {
          if (used.has(result)) continue
          const label = typeof result.name === 'string' ? result.name : 'tool result'
          parts.push(`<details class="box"><summary>${escapeHtml(label)} <span class="muted">result only</span></summary>`)
          parts.push(`<pre${result.is_error === true ? ' class="err"' : ''}>${escapeHtml(result.text)}</pre>`)
          parts.push('</details>')
        }
      }

      parts.push('</article>')
    }
    parts.push('</section>')
  }
  parts.push('</main>')

  parts.push('<footer>')
  parts.push(
    `Generated by ${escapeHtml(model.exporter ?? 'dsh-cot-export')} · scope ${escapeHtml(model.scope)} · ` +
      `exported ${escapeHtml(formatIsoWithOffset(model.exported_at))} · self-contained file, no external assets.`,
  )
  parts.push(
    'Derived view of the session event log. For a complete archive of the same session — attachments, ' +
      'request headers and internal events included — use the built-in Download session log action or /export.',
  )
  parts.push('</footer>')
  parts.push('</div>')
  parts.push('<script>document.addEventListener("click",function(e){var a=e.target&&e.target.dataset&&e.target.dataset.act;if(!a)return;var open=a==="expand";var d=document.querySelectorAll("details");for(var i=0;i<d.length;i++){d[i].open=open}})</script>')
  parts.push('</body>')
  parts.push('</html>')
  return `${parts.join('\n')}\n`
}
