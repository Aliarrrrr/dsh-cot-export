/**
 * Integration self-test for dsh-cot-export without a running Harness.
 *
 * It stubs the two bare imports (`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`),
 * builds the plugin through its real `apply()`, and drives every registered
 * entry point against a REAL session log decoded from the local profile:
 * the `cot_export` and `cot_review` tools, the `/cot` command and the
 * `GET /api/cot.export` route. Tool results are validated against their own
 * declared output schemas so a schema/value drift fails here instead of at the
 * first real tool call.
 *
 * Run: node run.mjs <path-to-session.v4.jsonl.zstd> [...more]
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { prepareRuntime } from './bootstrap.mjs'

// ---------------------------------------------------------------------------
// Minimal reader for the profile's zstd-framed JSONL session logs.
// ---------------------------------------------------------------------------

function frameEnd(buffer, offset) {
  let cursor = offset + 4
  const descriptor = buffer[cursor]
  cursor += 1
  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const checksum = (descriptor >> 2) & 1
  const dictionaryFlag = descriptor & 3
  const contentSizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][contentSizeFlag]
  const dictionaryBytes = [0, 1, 2, 4][dictionaryFlag]
  if (singleSegment === 0) cursor += 1
  cursor += dictionaryBytes + contentSizeBytes
  for (;;) {
    const header = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16)
    cursor += 3
    const last = header & 1
    const type = (header >> 1) & 3
    const size = header >> 3
    if (type === 0 || type === 2) cursor += size
    else if (type === 1) cursor += 1
    else throw new Error(`reserved block type at ${cursor - 3}`)
    if (last === 1) break
  }
  if (checksum === 1) cursor += 4
  return cursor
}

function readSessionLog(file) {
  const buffer = readFileSync(file)
  let offset = 0
  const parts = []
  while (offset < buffer.length) {
    const end = frameEnd(buffer, offset)
    if (end <= offset || end > buffer.length) throw new Error(`bad frame span ${offset}..${end}`)
    parts.push(zlib.zstdDecompressSync(buffer.subarray(offset, end)))
    offset = end
  }
  const rows = Buffer.concat(parts)
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
  const headerRow = rows.find((row) => row.type === 'session')
  if (headerRow === undefined) throw new Error('no session header row')
  const header = { ...headerRow }
  delete header.type
  const events = rows.filter((row) => typeof row.type === 'string' && row.type !== 'session' && typeof row.seq === 'number')
  return { header, events, surfaceOf: computeSurface(events) }
}

/**
 * Approximate the surface classification the Host's `listEvents` provides, from
 * the log's own replacement operations. Good enough as a fixture: it is the same
 * thing `scope: all` annotates per step.
 * @param {object[]} events
 * @returns {Map<number, string>}
 */
function computeSurface(events) {
  const shadowed = new Set()
  for (const event of events) {
    const operation = event.surfaceOp
    if (operation === null || typeof operation !== 'object' || operation.op !== 'replace') continue
    const start = Number(operation.startSeq)
    const end = Number(operation.endSeq)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    for (let seq = start; seq <= end; seq += 1) shadowed.add(seq)
  }
  const map = new Map()
  for (const event of events) map.set(event.seq, shadowed.has(event.seq) ? 'shadowed' : 'current')
  return map
}

// ---------------------------------------------------------------------------
// Output-schema validation (the enforced JSON Schema subset this plugin uses).
// ---------------------------------------------------------------------------

const TYPE_CHECK = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null,
  array: (value) => Array.isArray(value),
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
}

function validate(schema, value, where) {
  if (schema.type !== undefined) {
    const check = TYPE_CHECK[schema.type]
    assert.ok(check !== undefined, `${where}: unknown schema type ${schema.type}`)
    assert.ok(check(value), `${where}: expected ${schema.type}, got ${JSON.stringify(value)?.slice(0, 80)}`)
  }
  if (schema.type === 'object') {
    const properties = schema.properties ?? {}
    for (const [key, property] of Object.entries(properties)) {
      const present = Object.prototype.hasOwnProperty.call(value, key)
      if (property.required === true) assert.ok(present, `${where}.${key}: required but missing`)
      if (present && value[key] !== undefined) validate(property, value[key], `${where}.${key}`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(Object.prototype.hasOwnProperty.call(properties, key), `${where}.${key}: not declared in the output schema`)
      }
    }
  }
  if (schema.type === 'array' && schema.items !== undefined) {
    value.forEach((item, index) => validate(schema.items, item, `${where}[${index}]`))
  }
}

// ---------------------------------------------------------------------------
// Fake Harness context.
// ---------------------------------------------------------------------------

function createHarness(log) {
  const state = { tools: [], commands: [], skills: [], routes: [], warnings: [], effects: [] }

  const services = {
    logger: { warn: (message) => state.warnings.push(String(message)) },
    tools: {
      register: (definition) => {
        state.tools.push(definition)
        return () => {}
      },
    },
    commands: {
      register: (definition) => {
        state.commands.push(definition)
        return () => {}
      },
    },
    skills: {
      register: (skill) => {
        state.skills.push(skill)
        return () => {}
      },
    },
    connection: {
      fetch: {
        register: (route) => {
          state.routes.push(route)
          return async () => {}
        },
      },
    },
    sessionQuery: {
      listSessions: async () => [{ header: log.header, live: true, persisted: true }],
      readSession: async (sessionId) => {
        if (sessionId !== log.header.id) throw new Error(`unknown session ${sessionId}`)
        return { session: log.header, inheritedEventCount: 0, events: log.events }
      },
      listEvents: async () =>
        log.events.map((event) => ({
          seq: event.seq,
          type: event.type,
          surface: log.surfaceOf.get(event.seq) ?? 'current',
        })),
      readTitleSnapshot: async () => ({ session: log.header, title: { title: 'Self-test session' } }),
      traceSession: async () => ({ target: { header: log.header }, ancestors: [], descendants: [], complete: true }),
    },
  }

  const effect = (callback) => {
    const disposer = callback()
    state.effects.push(disposer)
    return () => {}
  }

  const ctx = {
    ...services,
    effect,
    get: () => undefined,
    inject: (names, callback) => {
      const derived = { ...services, effect, get: ctx.get, inject: ctx.inject }
      for (const name of names) derived[name] = services[name]
      callback(derived)
      return () => {}
    },
  }
  return { ctx, state }
}

// ---------------------------------------------------------------------------
// Scenarios.
// ---------------------------------------------------------------------------

async function exerciseSession(logFile, outputDir, runtime) {
  const log = readSessionLog(logFile)
  const { ctx, state } = createHarness(log)
  const { apply, inject, name } = await import(runtime.pluginUrl)

  assert.equal(name, 'dsh-cot-export')
  assert.deepEqual(inject, ['tools', 'sessionQuery'])
  apply(ctx, { outputDir, defaultFormat: 'markdown' })
  assert.equal(state.tools.length, 2, 'two tools registered')
  assert.equal(state.commands.length, 1, 'the /cot command registered')
  assert.equal(state.skills.length, 1, 'the cot-review skill registered')
  assert.equal(state.routes.length, 1, 'the export route registered')
  assert.deepEqual(state.routes[0].methods, ['GET', 'HEAD'])
  assert.equal(state.routes[0].path, '/api/cot.export')
  assert.equal(state.skills[0].name, 'cot-review')
  assert.equal(state.commands[0].name, 'cot')
  assert.equal(state.warnings.length, 0, `no warnings expected: ${state.warnings.join(' | ')}`)

  const caller = { agent: { id: log.header.id }, signal: new AbortController().signal }
  const exportTool = state.tools.find((tool) => tool.name === 'cot_export')
  const reviewTool = state.tools.find((tool) => tool.name === 'cot_review')

  for (const tool of state.tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 120, `${tool.name} description is long enough to guide a model`)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }

  // --- markdown export through the tool -------------------------------------
  const value = await exportTool.execute({ session_id: log.header.id }, caller)
  validate(exportTool.output.schema, value, 'cot_export')
  assert.equal(value.session_id, log.header.id)
  assert.equal(value.format, 'markdown')
  assert.equal(value.scope, 'all')
  assert.ok(value.turns > 0 && value.steps > 0 && value.reasoning_chars > 0)
  const markdown = await readFile(value.path, 'utf8')
  assert.match(markdown, /^---\nschema: dsh-cot\/v1\n/)
  assert.match(markdown, /## Index/)
  assert.match(markdown, /^derived_from: dsh-session-event-log$/m, 'the artifact marks itself as a derived view')
  // Every index row's line really is that turn's heading.
  const lines = markdown.split('\n')
  const rows = [...markdown.matchAll(/^\| (\d+) \| (\d+) \| (\d+) \| (\d+) \|$/gm)]
  assert.ok(rows.length >= 1, 'the turn index has rows')
  for (const row of rows) {
    assert.match(lines[Number(row[4]) - 1], new RegExp(`^## Turn ${row[1]}\\b`))
  }
  const rendered = exportTool.output.render({}, value)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /CoT exported \(/)
  assert.match(rendered[0].text, /cot_review/)

  // --- every format writes a distinct artifact ------------------------------
  for (const format of ['json', 'jsonl', 'text', 'html']) {
    const other = await exportTool.execute({ session_id: log.header.id, format }, caller)
    validate(exportTool.output.schema, other, `cot_export[${format}]`)
    const text = await readFile(other.path, 'utf8')
    if (format === 'json') {
      const parsed = JSON.parse(text)
      assert.equal(parsed.schema, 'dsh-cot/v1')
      assert.equal(parsed.stats.steps, other.steps)
      const withResults = parsed.turns.flatMap((turn) => turn.steps).filter((step) => Array.isArray(step.tool_results))
      if (withResults.length > 0) {
        const sample = withResults[0].tool_results[0]
        assert.equal(typeof sample.text, 'string', 'a result keeps its text')
        assert.equal(typeof sample.chars, 'number')
      }
    } else if (format === 'jsonl') {
      const jsonlRows = text.trim().split('\n')
      assert.equal(jsonlRows.length, other.steps)
      jsonlRows.forEach((line) => JSON.parse(line))
    } else if (format === 'html') {
      assert.match(text, /^<!doctype html>/)
      assert.match(text, /<meta name="generator" content="dsh-cot-export/)
      assert.match(text, /<section class="turn" id="t1">/)
      assert.match(text, /data-act="expand"/)
      assert.match(text, /Derived view of the session event log\./, 'the footer points at the built-in archive')
      assert.equal((text.match(/<script>/g) ?? []).length, 1, 'only the fixed expand handler is scripted')
      assert.doesNotMatch(text, /<script>alert/, 'session text is never injected as markup')
      assert.ok(other.path.endsWith('.html'))
    } else {
      assert.match(text, /^=== DSH chain-of-thought export ===/)
    }
    assert.ok(!other.path.endsWith('.md'), 'a non-markdown format must not reuse the .md name')
  }

  // --- review package ------------------------------------------------------
  const review = await reviewTool.execute({ session_id: log.header.id, focus: 'wasted effort', window_turns: 1 }, caller)
  validate(reviewTool.output.schema, review, 'cot_review')
  // cot_review re-exports so the package is self-contained; it never reuses or
  // overwrites an artifact another call produced.
  assert.ok(review.cot_path.startsWith(outputDir))
  assert.notEqual(review.review_path, review.cot_path)
  const reviewDoc = await readFile(review.review_path, 'utf8')
  assert.match(reviewDoc, /^# CoT review plan/)
  assert.match(reviewDoc, /## Rubric/)
  assert.match(reviewDoc, /wasted effort/)
  assert.match(review.delegation_prompt, new RegExp(review.cot_path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const cotLines = (await readFile(review.cot_path, 'utf8')).split('\n')
  assert.ok(review.windows.length >= 1)
  for (const window of review.windows) {
    assert.match(cotLines[window.line_from - 1], new RegExp(`^## Turn ${window.turn_from}\\b`))
    assert.ok(window.line_to >= window.line_from && window.line_to <= cotLines.length)
  }
  const reviewRender = reviewTool.output.render({}, review)
  assert.match(reviewRender[0].text, /Pass this prompt to the reviewer/)

  // --- route: JSON and download -------------------------------------------
  const route = state.routes[0]
  const base = `http://127.0.0.1:9${route.path}`
  const jsonResponse = await route.fetch(new Request(`${base}?sessionId=${encodeURIComponent(log.header.id)}`))
  assert.equal(jsonResponse.status, 200)
  const payload = await jsonResponse.json()
  assert.equal(payload.session_id, log.header.id)
  assert.ok(typeof payload.path === 'string' && payload.path.length > 0)
  const download = await route.fetch(
    new Request(`${base}?sessionId=${encodeURIComponent(log.header.id)}&format=jsonl&download=1`),
  )
  assert.equal(download.status, 200)
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment; filename="/)
  assert.match(download.headers.get('content-type') ?? '', /ndjson/)
  const body = await download.text()
  assert.ok(body.trim().split('\n').every((line) => JSON.parse(line).schema === 'dsh-cot/v1'))
  const head = await route.fetch(new Request(base, { method: 'HEAD' }))
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('x-cot-export-route'), '/api/cot.export')
  assert.match(head.headers.get('x-cot-export-formats') ?? '', /markdown/)

  // --- route: inline bytes never publish a second artifact ----------------
  const filesBefore = readdirSync(outputDir).length
  const inlineResponse = await route.fetch(
    new Request(`${base}?sessionId=${encodeURIComponent(log.header.id)}&format=markdown&inline=1`),
  )
  assert.equal(inlineResponse.status, 200)
  assert.match(inlineResponse.headers.get('content-disposition') ?? '', /^attachment; filename="/)
  assert.match(await inlineResponse.text(), /^---\nschema: dsh-cot\/v1/)
  assert.equal(readdirSync(outputDir).length, filesBefore, 'an inline download must not write another artifact')

  // --- route: the chosen save directory wins ------------------------------
  const chosenDir = path.join(outputDir, 'chosen-location')
  const dirResponse = await route.fetch(
    new Request(`${base}?sessionId=${encodeURIComponent(log.header.id)}&dir=${encodeURIComponent(chosenDir)}`),
  )
  assert.equal(dirResponse.status, 200)
  const dirPayload = await dirResponse.json()
  assert.equal(dirPayload.output_dir, chosenDir, 'the payload reports where it wrote')
  assert.equal(path.dirname(dirPayload.path), chosenDir)
  assert.ok(readdirSync(chosenDir).length >= 1, 'the artifact landed in the chosen directory')

  // --- route: the header action's review button (mode=review) --------------
  const reviewResponse = await route.fetch(
    new Request(`${base}?sessionId=${encodeURIComponent(log.header.id)}&mode=review`),
  )
  assert.equal(reviewResponse.status, 200)
  const reviewPayload = await reviewResponse.json()
  assert.equal(reviewPayload.mode, 'review')
  assert.ok(typeof reviewPayload.cot_path === 'string' && reviewPayload.cot_path.length > 0)
  assert.ok(typeof reviewPayload.review_path === 'string' && reviewPayload.review_path.length > 0)
  assert.ok(Number.isInteger(reviewPayload.windows) && reviewPayload.windows >= 1)
  assert.match(reviewPayload.delegation_prompt, /REVIEW/)
  assert.ok(reviewPayload.cot_path.startsWith(outputDir))
  const routeReviewDoc = await readFile(reviewPayload.review_path, 'utf8')
  assert.match(routeReviewDoc, /## Rubric/)

  const missingParam = await route.fetch(new Request(base))
  assert.equal(missingParam.status, 400)
  const unknown = await route.fetch(new Request(`${base}?sessionId=session-does-not-exist`))
  assert.equal(unknown.status, 404)
  const unknownBody = await unknown.json()
  assert.match(unknownBody.message, /no session matches/)

  // --- command -------------------------------------------------------------
  const command = state.commands[0]
  const ok = await command.handler({ agent: { id: log.header.id }, rawInput: 'json' })
  assert.equal(ok.kind, 'success')
  assert.match(ok.text, /CoT exported/)
  const reviewCommand = await command.handler({ agent: { id: log.header.id }, rawInput: 'review direction' })
  assert.equal(reviewCommand.kind, 'success')
  assert.match(reviewCommand.text, /Review:/)
  const usage = await command.handler({ agent: { id: log.header.id }, rawInput: 'json banana extra' })
  assert.equal(usage.kind, 'error')
  assert.match(usage.text, /usage:/)
  const badFormat = await command.handler({ agent: { id: log.header.id }, rawInput: 'latest' })
  assert.equal(badFormat.kind, 'error', 'latest without another session must fail cleanly')

  return { log, value, review }
}

// ---------------------------------------------------------------------------

async function main() {
  const files = process.argv.slice(2)
  assert.ok(files.length > 0, 'pass at least one session log path')
  const runtime = await prepareRuntime()
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'cot-selftest-'))
  let totalSteps = 0
  let totalChars = 0
  for (const file of files) {
    const startedAt = Date.now()
    const { log, value, review } = await exerciseSession(file, outputDir, runtime)
    totalSteps += value.steps
    totalChars += value.reasoning_chars
    console.log(
      `OK ${path.basename(path.dirname(file)).slice(-24)} turns=${value.turns} steps=${value.steps} ` +
        `chars=${value.reasoning_chars} tokens=${value.reasoning_tokens ?? 0} superseded=${value.superseded_steps} ` +
        `inherited=${value.inherited_steps ?? 0} windows=${review.windows.length} ` +
        `bytes=${value.bytes} ms=${Date.now() - startedAt}`,
    )
    assert.ok(log.events.length > 0)
  }
  console.log(`ALL OK sessions=${files.length} steps=${totalSteps} reasoningChars=${totalChars} out=${outputDir}`)
}

await main()
