/**
 * Unit tests for the pure core of dsh-cot-export.
 *
 * Run with: node --test test/cot.test.mjs
 *
 * Fixtures mirror the real session-event shapes recorded by this DSH release:
 * an `assistant/message` carries the assembled message (reasoning blocks among
 * its content), while a failed attempt commits `assistant/attempt` and keeps its
 * reasoning only inside the compact timed stream.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  buildExportPath,
  cotError,
  escapeHtml,
  extensionOf,
  extractCoT,
  formatIsoWithOffset,
  mimeOf,
  parseFormat,
  parseScope,
  reasoningFromAttemptStream,
  render,
  renderHtml,
  renderJsonl,
  renderMarkdownWithIndex,
  shortSessionId,
  slugify,
  timestampSlug,
} from '../lib/cot.js'
import { planWindows } from '../lib/rubric.js'

/** Assign contiguous seq numbers the way a real log does. */
const sequence = (events) => events.map((event, index) => ({ seq: index, ...event }))

/** @param {object} input */
function assistant(input) {
  const content = []
  for (const text of input.reasoning ?? []) content.push({ type: 'reasoning', text })
  for (const text of input.text ?? []) content.push({ type: 'text', text })
  for (const call of input.tools ?? []) {
    content.push({
      type: 'tool-call',
      id: call.id ?? `call_${call.name}`,
      name: call.name,
      arguments: call.arguments ?? '{}',
    })
  }
  const data = {
    turn: input.turn,
    step: input.step,
    message: {
      role: 'assistant',
      content,
      source: { kind: 'model', provider: input.provider ?? 'deepseek-account', model: input.model ?? 'deepseek-flash' },
      id: `assistant-${input.turn}-${input.step}`,
    },
    stream: [],
  }
  if (input.usage !== undefined) data.usage = input.usage
  if (input.interrupted === true) data.interrupted = true
  return { type: 'assistant/message', time: input.time, data, surfaceOp: 'append' }
}

/** @param {object} input */
function userMessage(input) {
  return {
    type: 'user/message',
    time: input.time,
    data: {
      turn: input.turn,
      step: input.step,
      message: { role: 'user', content: [{ type: 'text', text: input.text }], source: { kind: 'user' }, id: `user-${input.turn}` },
    },
    surfaceOp: 'append',
  }
}

const session = { id: 'session-aaaa1111-bbbb-2222-cccc-333344445555', version: 4, cwd: 'D:/work' }

const baseEvents = sequence([
  { type: 'turn/start', time: 1000, data: { turn: 1 } },
  userMessage({ turn: 1, step: 1, time: 1001, text: '  fix the failing test  ' }),
  assistant({ turn: 1, step: 1, time: 1002, reasoning: ['first thought'], tools: [{ name: 'read' }] }),
  assistant({
    turn: 1,
    step: 2,
    time: 1003,
    reasoning: ['second thought', 'and more'],
    text: ['all green'],
    usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 7 },
  }),
  assistant({ turn: 2, step: 1, time: 1004, reasoning: ['turn two thought'] }),
])

test('groups committed reasoning messages by turn and step', () => {
  const model = extractCoT({ session, events: baseEvents, surfaceOf: new Map(), exportedAt: 5000 })
  assert.equal(model.schema, 'dsh-cot/v1')
  assert.equal(model.turns.length, 2)
  assert.equal(model.turns[0].steps.length, 2)
  assert.equal(model.turns[0].steps[1].reasoning.length, 2)
  assert.equal(model.turns[0].steps[1].reasoning[1].text, 'and more')
  assert.equal(model.turns[0].steps[1].answer[0].text, 'all green')
  assert.equal(model.turns[0].steps[0].tool_calls[0].name, 'read')
  assert.equal(model.turns[0].user_text, 'fix the failing test')
  assert.equal(model.stats.turns, 2)
  assert.equal(model.stats.steps, 3)
  assert.equal(model.stats.reasoning_chars, 'first thought'.length + 'second thought'.length + 'and more'.length + 'turn two thought'.length)
  assert.equal(model.stats.reasoning_tokens, 7)
  assert.deepEqual(model.stats.models, ['deepseek-flash'])
})

test('marks compaction-superseded and fork-inherited steps', () => {
  const firstAssistantSeq = baseEvents.find((event) => event.type === 'assistant/message').seq
  const surfaceOf = new Map([[firstAssistantSeq, 'shadowed']])
  const model = extractCoT({ session, events: baseEvents, surfaceOf, inheritedEventCount: 3, exportedAt: 5000 })
  assert.equal(model.turns[0].steps[0].superseded, true)
  assert.equal(model.turns[0].steps[1].superseded, undefined)
  assert.equal(model.stats.superseded_steps, 1)
  assert.equal(model.stats.current_steps, 2)
  // The first assistant message (seq 2) sits below the fork cut at seq 3.
  assert.equal(model.turns[0].steps[0].inherited, true)
  assert.equal(model.turns[0].steps[1].inherited, undefined)
  assert.equal(model.stats.inherited_steps, 1)
})

test('scope surface drops every superseded reasoning message', () => {
  const firstAssistantSeq = baseEvents.find((event) => event.type === 'assistant/message').seq
  const surfaceOf = new Map([[firstAssistantSeq, 'shadowed']])
  const model = extractCoT({ session, events: baseEvents, surfaceOf, exportedAt: 5000, scope: 'surface' })
  assert.equal(model.stats.steps, 2)
  assert.equal(model.turns[0].steps.length, 1)
  assert.equal(model.scope, 'surface')
  // The count of hidden messages still reports the whole log.
  assert.equal(model.stats.superseded_steps, 1)
})

test('rebuilds failed-attempt reasoning from every stream shape', () => {
  assert.equal(
    reasoningFromAttemptStream([
      { type: 'reasoning-chunks', time0: 1, index: 0, dt: [0, 0], texts: ['ab', 'cd'] },
      { type: 'reasoning-chunks', time0: 2, index: 1, dt: [0], texts: ['ef'] },
    ]),
    'abcdef',
  )
  assert.equal(
    reasoningFromAttemptStream([
      { type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
      { type: 'chunk', time: 2, chunk: { type: 'reasoning-delta', index: 0, text: 'xy' } },
    ]),
    'xy',
  )
  assert.equal(
    reasoningFromAttemptStream([
      { type: 'chunk', time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'partial' } },
      { type: 'chunk', time: 2, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'final' } } },
    ]),
    'final',
  )
  assert.equal(reasoningFromAttemptStream(undefined), '')
})

test('keeps failed attempts only when asked, and attaches them to the committed step', () => {
  const events = sequence([
    userMessage({ turn: 1, step: 1, time: 10, text: 'go' }),
    {
      type: 'assistant/attempt',
      time: 11,
      data: { turn: 1, step: 1, stream: [{ type: 'reasoning-chunks', time0: 10, index: 0, dt: [0], texts: ['retry me'] }] },
    },
    assistant({ turn: 1, step: 1, time: 12, reasoning: ['the good one'] }),
  ])
  const without = extractCoT({ session, events, surfaceOf: new Map(), exportedAt: 1 })
  assert.equal(without.turns[0].steps.length, 1)
  assert.equal(without.turns[0].steps[0].attempt_reasoning, undefined)
  assert.equal(without.stats.failed_attempts, 1)

  const withAttempts = extractCoT({
    session,
    events,
    surfaceOf: new Map(),
    exportedAt: 1,
    includeFailedAttempts: true,
  })
  assert.deepEqual(withAttempts.turns[0].steps[0].attempt_reasoning.map((part) => part.text), ['retry me'])
  assert.equal(withAttempts.stats.reasoning_chars, 'the good one'.length + 'retry me'.length)
})

test('renders an attempt with no committed message as a failed step', () => {
  const events = sequence([
    userMessage({ turn: 1, step: 1, time: 10, text: 'go' }),
    {
      type: 'assistant/attempt',
      time: 11,
      data: { turn: 1, step: 1, stream: [{ type: 'reasoning-chunks', time0: 10, index: 0, dt: [0], texts: ['aborted'] }] },
    },
  ])
  const model = extractCoT({ session, events, surfaceOf: new Map(), exportedAt: 1, includeFailedAttempts: true })
  assert.equal(model.turns[0].steps[0].failed, true)
  assert.equal(model.turns[0].steps[0].reasoning, undefined)
  assert.equal(model.turns[0].steps[0].attempt_reasoning[0].text, 'aborted')
  const markdown = renderMarkdownWithIndex(model).text
  assert.match(markdown, /### Step 1 \(failed attempt\)/)
  assert.match(markdown, /\*\*Reasoning of the failed attempt\*\*/)
})

test('adapts the fence to reasoning that contains backticks', () => {
  const events = sequence([
    userMessage({ turn: 1, step: 1, time: 10, text: 'go' }),
    assistant({ turn: 1, step: 1, time: 11, reasoning: ['before ```js\nconst a = 1\n``` after'] }),
  ])
  const model = extractCoT({ session, events, surfaceOf: new Map(), exportedAt: 1 })
  const markdown = renderMarkdownWithIndex(model).text
  // The inner three-backtick run must be fenced by at least four.
  assert.match(markdown, /\n````\nbefore ```js/)
  assert.match(markdown, /``` after\n````\n/)
})

test('the Markdown index points at the turn headings it lists', () => {
  const model = extractCoT({ session, events: baseEvents, surfaceOf: new Map(), exportedAt: 1 })
  const { text, turnLines } = renderMarkdownWithIndex(model)
  const lines = text.split('\n')
  assert.equal(turnLines.length, model.turns.length)
  for (const entry of turnLines) {
    assert.match(lines[entry.lineFrom - 1], new RegExp(`^## Turn ${entry.turn}\\b`), `turn ${entry.turn} at line ${entry.lineFrom}`)
    assert.ok(entry.lineTo >= entry.lineFrom)
  }
  assert.match(text, /^---\nschema: dsh-cot\/v1\n/)
  assert.match(text, /\| Turn \| Steps \| CoT chars \| Line \|/)
  assert.match(text, /exported_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/)
  assert.match(text, /^derived_from: dsh-session-event-log$/m, 'the artifact says it is a derived view')
})

test('the index stays correct when reasoning and answers contain newlines', () => {
  const events = sequence([
    userMessage({ turn: 1, step: 1, time: 10, text: 'one' }),
    assistant({ turn: 1, step: 1, time: 11, reasoning: ['line a\nline b\nline c'] }),
    assistant({ turn: 2, step: 1, time: 12, reasoning: ['two\nlines'], text: ['answer\nwith\nnewlines'] }),
    assistant({ turn: 3, step: 1, time: 13, reasoning: ['single'] }),
  ])
  const model = extractCoT({ session, events, surfaceOf: new Map(), exportedAt: 1 })
  const { text, turnLines } = renderMarkdownWithIndex(model)
  const lines = text.split('\n')
  for (const entry of turnLines) {
    assert.match(lines[entry.lineFrom - 1], new RegExp(`^## Turn ${entry.turn}\\b`), `turn ${entry.turn}`)
    assert.ok(entry.lineTo <= lines.length)
  }
  // The review windows address the same physical lines.
  for (const window of planWindows(turnLines, 1)) {
    assert.match(lines[window.line_from - 1], new RegExp(`^## Turn ${window.turn_from}\\b`))
  }
})

test('Markdown carries the superseded marker and the session summary', () => {
  const firstAssistantSeq = baseEvents.find((event) => event.type === 'assistant/message').seq
  const model = extractCoT({
    session: { ...session, agentPreset: 'standard' },
    events: baseEvents,
    surfaceOf: new Map([[firstAssistantSeq, 'shadowed']]),
    title: 'Fix the failing test',
    exportedAt: 1,
  })
  const { text } = renderMarkdownWithIndex(model)
  assert.match(text, /# Chain of Thought — Fix the failing test/)
  assert.match(text, /> ⚠ superseded — hidden from the current model context by compaction/)
  assert.match(text, /agent_preset: standard/)
})

test('JSONL emits one parseable row per step', () => {
  const model = extractCoT({ session, events: baseEvents, surfaceOf: new Map(), exportedAt: 1 })
  const rows = renderJsonl(model)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(rows.length, model.stats.steps)
  assert.equal(rows[0].turn, 1)
  assert.equal(rows[0].step, 1)
  assert.deepEqual(rows[1].reasoning, ['second thought', 'and more'])
  assert.equal(rows[1].usage.reasoningTokens, 7)
})

test('the format dispatcher returns a trailing newline for every format', () => {
  const model = extractCoT({ session, events: baseEvents, surfaceOf: new Map(), exportedAt: 1 })
  for (const format of ['markdown', 'json', 'jsonl', 'text', 'html']) {
    const rendered = render(model, format)
    assert.ok(rendered.text.endsWith('\n'), format)
    assert.ok(rendered.text.length > 40, format)
  }
  assert.equal(JSON.parse(render(model, 'json').text).schema, 'dsh-cot/v1')
  assert.match(render(model, 'text').text, /^=== DSH chain-of-thought export ===/)
})

test('a session with no reasoning fails with a stable code', () => {
  const events = sequence([
    userMessage({ turn: 1, step: 1, time: 10, text: 'go' }),
    assistant({ turn: 1, step: 1, time: 11, text: ['done, no reasoning'] }),
  ])
  assert.throws(
    () => extractCoT({ session, events, surfaceOf: new Map(), exportedAt: 1 }),
    (error) => error instanceof Error && error.code === 'COT_NO_REASONING',
  )
})

test('parsers reject unknown formats and scopes with COT_INVALID_ARGUMENT', () => {
  assert.equal(parseFormat('md'), 'markdown')
  assert.equal(parseFormat(' NDJSON '), 'jsonl')
  assert.equal(parseFormat('txt'), 'text')
  assert.equal(parseScope('SURFACE'), 'surface')
  assert.equal(parseScope('all'), 'all')
  for (const bad of ['yaml', '', null, 3]) {
    assert.throws(
      () => parseFormat(bad),
      (error) => error.code === 'COT_INVALID_ARGUMENT',
    )
  }
  assert.throws(
    () => parseScope('partial'),
    (error) => error.code === 'COT_INVALID_ARGUMENT',
  )
  assert.equal(cotError('COT_X', 'boom').message, 'COT_X: boom')
})

test('path helpers stay inside the requested directory', () => {
  assert.equal(extensionOf('markdown'), '.md')
  assert.equal(extensionOf('jsonl'), '.jsonl')
  assert.match(mimeOf('jsonl'), /^application\/x-ndjson/)
  const iso = formatIsoWithOffset(Date.UTC(2026, 9, 27, 13, 17, 59))
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  assert.equal(new Date(iso).getTime(), Date.UTC(2026, 9, 27, 13, 17, 59))
  assert.equal(slugify('Fix: a/b?'), 'Fix-a-b')
  assert.equal(slugify('   '), 'session')
  assert.equal(slugify('x'.repeat(200)).length, 48)
  assert.match(timestampSlug(Date.UTC(2026, 9, 27, 13, 17, 59)), /^\d{8}-\d{6}$/)
  assert.equal(shortSessionId('session-aaaa1111-bbbb-2222-cccc-333344445555'), 'aaaa1111')

  const built = buildExportPath({
    baseDir: 'D:/work',
    outputDir: 'cot-exports',
    format: 'markdown',
    sessionId: session.id,
    title: 'Fix the failing test',
    exportedAt: Date.UTC(2026, 9, 27, 13, 17, 59),
  })
  assert.equal(path.dirname(built), path.resolve('D:/work', 'cot-exports'))
  assert.match(path.basename(built), /^Fix-the-failing-test-aaaa1111-\d{8}-\d{6}\.md$/)

  const explicit = buildExportPath({
    baseDir: 'D:/work',
    outputDir: 'cot-exports',
    format: 'json',
    sessionId: session.id,
    exportedAt: 1,
    outPath: 'manual/export',
  })
  assert.equal(explicit, path.resolve('D:/work', 'manual/export.json'))
})

test('review windows cover every turn line range', () => {
  const model = extractCoT({ session, events: baseEvents, surfaceOf: new Map(), exportedAt: 1 })
  const { turnLines } = renderMarkdownWithIndex(model)
  const windows = planWindows(turnLines, 1)
  assert.equal(windows.length, turnLines.length)
  assert.deepEqual(
    windows.map((window) => [window.turn_from, window.turn_to]),
    [
      [1, 1],
      [2, 2],
    ],
  )
  const single = planWindows(turnLines, 0)
  assert.equal(single.length, 1)
  assert.equal(single[0].turn_from, 1)
  assert.equal(single[0].turn_to, 2)
  assert.equal(single[0].line_from, turnLines[0].lineFrom)
  assert.equal(single[0].line_to, turnLines[turnLines.length - 1].lineTo)
  assert.equal(single[0].chars, windows.reduce((total, window) => total + window.chars, 0))
})

test('pairs every tool call with its recorded result and truncates long results', () => {
  const long = 'x'.repeat(5000)
  const events = sequence([
    userMessage({ turn: 1, step: 1, time: 10, text: 'go' }),
    { type: 'tool/call', time: 11, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a"}' } },
    {
      type: 'tool/result',
      time: 12,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: long }] },
      },
    },
    { type: 'tool/call', time: 13, data: { turn: 1, step: 1, callId: 'c2', name: 'pwsh', arguments: '{}' } },
    {
      type: 'tool/result',
      time: 14,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'tool', toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'boom' }] },
      },
    },
    assistant({
      turn: 1,
      step: 1,
      time: 15,
      reasoning: ['think'],
      tools: [
        { id: 'c1', name: 'read', arguments: '{"path":"a"}' },
        { id: 'c2', name: 'pwsh', arguments: '{}' },
      ],
    }),
  ])
  const model = extractCoT({ session, events, surfaceOf: new Map(), exportedAt: 1 })
  const step = model.turns[0].steps[0]
  assert.equal(step.tool_calls.length, 2)
  assert.equal(step.tool_calls[0].id, 'c1', 'the call keeps the id that pairs it with the result')
  assert.equal(step.tool_results.length, 2)
  const [first, second] = step.tool_results
  assert.equal(first.call_id, 'c1')
  assert.equal(first.name, 'read')
  assert.equal(first.chars, 5000)
  assert.equal(first.truncated, true)
  assert.equal(first.text.length, 4001, 'truncated text keeps the cap plus an ellipsis')
  assert.equal(second.name, 'pwsh')
  assert.equal(second.is_error, true)
  assert.equal(second.text, 'boom')

  const html = renderHtml(model)
  assert.match(html, /read <span class="muted">ok<\/span>/)
  assert.match(html, /pwsh <span class="muted">failed<\/span>/)
  assert.match(html, /result · truncated/)
  assert.match(html, /<pre class="err">boom<\/pre>/)
})

test('the HTML timeline is self-contained, anchorable and escaped', () => {
  const events = sequence([
    userMessage({ turn: 1, step: 1, time: 10, text: 'hi <b>there</b>' }),
    assistant({
      turn: 1,
      step: 1,
      time: 11,
      reasoning: ['plan <script>alert(1)</script>', '</details><img src=x onerror=alert(2)>'],
      text: ['done <hr>'],
    }),
  ])
  const model = extractCoT({ session, events, surfaceOf: new Map(), exportedAt: 1 })
  const html = renderHtml(model)

  assert.match(html, /^<!doctype html>\n<html lang="en">/)
  assert.match(html, /<meta name="generator" content="dsh-cot-export">/)
  assert.match(html, /<title>CoT timeline · /)
  assert.match(html, /<section class="turn" id="t1">/)
  assert.match(html, /<details class="box">/)
  assert.match(html, /data-act="expand"/)
  assert.match(html, /Derived view of the session event log\./, 'the footer names the derived-view boundary')
  assert.match(html, /Download session log action or \/export/)

  // Session text is escaped, never markup.
  assert.ok(!html.includes('<script>alert(1)</script>'), 'reasoning must not inject script tags')
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(!html.includes('<img src=x'), 'attribute injection must be escaped')
  assert.ok(html.includes('&lt;/details&gt;&lt;img src=x onerror=alert(2)&gt;'))
  assert.ok(html.includes('hi &lt;b&gt;there&lt;/b&gt;'))
  assert.equal((html.match(/<script>/g) ?? []).length, 1, 'the only script is the fixed expand handler')
  assert.match(html, /document\.addEventListener\("click"/)

  // Escaping helper behaviour that the renderer relies on.
  assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;')
  assert.equal(extensionOf('html'), '.html')
  assert.match(mimeOf('html'), /^text\/html/)
  assert.equal(parseFormat('htm'), 'html')
  assert.equal(parseFormat('replay'), 'html')
})
