/**
 * Client-half wiring test for dsh-cot-export.
 *
 * Loads the real `lib/client.js` against a minimal React runtime, then drives the
 * real component through idle → working → done → format switch → review → save →
 * error and asserts what it renders and what it requests. This is a logic/wiring
 * test: it proves the component does not crash and issues the right requests. It
 * is NOT visual verification — layout, colour and placement must be checked in
 * the running GUI.
 *
 * Run: node client-test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// --- Minimal React runtime --------------------------------------------------
const hookState = { values: [], refs: [], effects: [], callbacks: [] }
let cursor = 0
let component
let props
let tree
let rendering = false
let pending = false
let scheduled = false

const RECT = { top: 40, bottom: 68, left: 272, right: 300, width: 28, height: 28 }
const nodeStub = {
  getBoundingClientRect: () => RECT,
  contains: () => false,
  addEventListener() {},
  removeEventListener() {},
}

const React = {
  Fragment: 'Fragment',
  createElement(type, config, ...children) {
    const element = { type, props: { ...(config ?? {}), children: children.length <= 1 ? children[0] : children } }
    if (element.props.ref !== undefined && element.props.ref !== null) {
      element.props.ref.current = type === 'style' ? undefined : nodeStub
    }
    return element
  },
  useState(initial) {
    const index = cursor++
    if (!(index in hookState.values)) {
      hookState.values[index] = typeof initial === 'function' ? initial() : initial
    }
    const set = (next) => {
      const resolved = typeof next === 'function' ? next(hookState.values[index]) : next
      if (Object.is(resolved, hookState.values[index])) return
      hookState.values[index] = resolved
      schedule()
    }
    return [hookState.values[index], set]
  },
  useRef(initial) {
    const index = cursor++
    if (!(index in hookState.refs)) hookState.refs[index] = { current: initial }
    return hookState.refs[index]
  },
  useCallback(fn, deps) {
    const index = cursor++
    if (!(index in hookState.callbacks)) {
      hookState.callbacks[index] = { fn, deps }
      return fn
    }
    const previous = hookState.callbacks[index]
    const changed =
      deps === undefined ||
      previous.deps === undefined ||
      deps.length !== previous.deps.length ||
      deps.some((value, position) => value !== previous.deps[position])
    if (changed) hookState.callbacks[index] = { fn, deps }
    return hookState.callbacks[index].fn
  },
  useEffect(fn, deps) {
    const index = cursor++
    const previous = hookState.effects[index]
    const changed =
      previous === undefined ||
      deps === undefined ||
      deps.length !== previous.length ||
      deps.some((value, position) => value !== previous[position])
    if (!changed) return
    hookState.effects[index] = deps
    fn()
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    cursor += 1
    return getSnapshot()
  },
}

function renderNow() {
  if (component === undefined) return
  if (rendering) {
    pending = true
    return
  }
  rendering = true
  try {
    let passes = 0
    do {
      if (passes++ > 50) throw new Error('render loop: more than 50 passes without settling')
      pending = false
      cursor = 0
      tree = component(props)
    } while (pending)
  } finally {
    rendering = false
  }
}

function schedule() {
  if (scheduled) return
  scheduled = true
  renderNow()
  scheduled = false
}

/** Let queued promise callbacks run, then re-render. */
async function tick(count = 5) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  renderNow()
}

// --- Browser stubs ----------------------------------------------------------
let activeLocale = 'zh-CN'
const storage = new Map()
const fetchCalls = []
let pickerResult = 'D:\\MyExports'
let savePickerCalls = []
let savePickerShouldFail = false

const ARTIFACT = 'D:\\CVEreproduction\\cot-exports\\demo-ddf6c584-20261027-220000.md'

globalThis.document = {
  baseURI: 'http://127.0.0.1:1486/',
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = {
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener() {},
  removeEventListener() {},
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  showSaveFilePicker: async (options) => {
    savePickerCalls.push(options)
    if (savePickerShouldFail) throw new Error('picker unavailable')
    return {
      createWritable: async () => ({
        write: async () => {},
        close: async () => {},
      }),
    }
  },
}
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
})

// Blob-download stubs: the component must hand bytes to a detached anchor with
// a blob URL rather than navigating the shell to the export route.
const downloads = []
URL.createObjectURL = () => `blob:mock-${downloads.length + 1}`
URL.revokeObjectURL = () => {}
globalThis.document.createElement = (tag) => {
  const element = {
    tag,
    href: '',
    download: '',
    rel: '',
    click() {
      downloads.push({ href: element.href, download: element.download })
    },
  }
  return element
}

const payloadFor = (href) => {
  const url = new URL(href)
  const mode = url.searchParams.get('mode')
  const format = url.searchParams.get('format') ?? 'markdown'
  if (mode === 'review') {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        mode: 'review',
        exporter: 'dsh-cot-export@test',
        session_id: 'session-demo',
        cot_path: ARTIFACT,
        review_path: 'D:\\CVEreproduction\\cot-exports\\REVIEW.md',
        output_dir: 'D:\\CVEreproduction\\cot-exports',
        turns: 5,
        steps: 231,
        reasoning_chars: 664826,
        windows: 3,
        format: 'markdown',
        scope: 'all',
        delegation_prompt: 'Review the model chain of thought … REVIEW.md …',
      }),
    }
  }
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      session_id: 'session-demo',
      exporter: 'dsh-cot-export@test',
      format,
      scope: 'all',
      path: ARTIFACT.replace('.md', format === 'markdown' ? '.md' : `.${format}`),
      output_dir: 'D:\\CVEreproduction\\cot-exports',
      bytes: 711667,
      turns: 5,
      steps: 231,
      reasoning_blocks: 231,
      reasoning_chars: 664826,
      current_steps: 231,
      superseded_steps: 0,
      reasoning_tokens: 142100,
    }),
  }
}

globalThis.fetch = async (href) => {
  fetchCalls.push(String(href))
  const response = payloadFor(String(href))
  return { ...response, blob: async () => ({ size: 711667 }) }
}

// --- Load the real bundle ---------------------------------------------------
let loaded
globalThis.window.__ModuleLoader__ = { load: (definition) => (loaded = definition) }
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
new Function('window', source)(globalThis.window)

assert.equal(loaded.id, 'dsh-cot-export', 'the module id equals the package name')
const plugin = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected module request: ${name}`)
})
assert.ok(plugin.inject.includes('slots') && plugin.inject.includes('locale'))

// --- Apply against a fake client context ------------------------------------
const registrations = []
const dictionaries = []
const workspace = {
  async pickDirectory() {
    return pickerResult
  },
}
const ctx = {
  effect(callback) {
    callback()
    return () => {}
  },
  get(name) {
    return name === 'uiWorkspace' ? workspace : undefined
  },
  locale: {
    register(namespaceName, locale, dictionary) {
      dictionaries.push({ namespaceName, locale, dictionary })
      return () => {}
    },
    getSnapshot: () => ({ active: activeLocale }),
    subscribe: () => () => {},
  },
  slots: {
    inject(_key, callback) {
      callback()
      return () => {}
    },
    register(options, componentFunction) {
      registrations.push({ options, component: componentFunction })
      return () => {}
    },
  },
}
plugin.apply(ctx)

assert.equal(registrations.length, 1)
const registration = registrations[0]
assert.equal(registration.options.name, 'conversation.session.header.actions')
assert.equal(registration.options.id, 'cot-export')
assert.equal(registration.options.order, 30)
assert.equal(registration.options.registrant, 'dsh-cot-export')
assert.equal(registration.options.label(), '导出 CoT')
assert.equal(dictionaries.length, 2)

// --- Render helpers ---------------------------------------------------------
const collect = (root) => {
  const nodes = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (typeof node !== 'object') return
    nodes.push(node)
    walk(node.props?.children)
  }
  walk(root)
  return nodes
}
const textOf = (root) => {
  const parts = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node))
      return
    }
    walk(node.props?.children)
  }
  walk(root)
  return parts.join(' ')
}
const byClass = (root, className) => collect(root).filter((node) => node.props?.className === className)
const byText = (root, text) =>
  collect(root).filter((node) => (node.type === 'button' || node.type === 'a') && textOf(node) === text)
const byAction = (root, action) => collect(root).find((node) => node.props?.['data-action'] === action)
const formatButtons = (root) =>
  collect(root).filter((node) => node.type === 'button' && node.props?.className === 'dsh-cot-export-format')

function mount(sessionId, { keepHooks = false } = {}) {
  if (!keepHooks) {
    hookState.values.length = 0
    hookState.refs.length = 0
    hookState.effects.length = 0
    hookState.callbacks.length = 0
  }
  component = registration.component
  props = sessionId === undefined ? {} : { sessionId }
  tree = undefined
  renderNow()
  return tree
}

// --- 1. no session id renders nothing --------------------------------------
assert.equal(mount(undefined), null, 'no session id must render nothing')

// --- 2. idle: one accessible button, theme-token styles --------------------
const sessionId = 'session-demo'
let view = mount(sessionId)
let buttons = collect(view).filter((node) => node.type === 'button')
assert.equal(buttons.length, 1, 'idle renders exactly one button')
assert.equal(buttons[0].props['aria-label'], '导出 CoT')
assert.equal(buttons[0].props.disabled, false)
const styleNode = collect(view).find((node) => node.type === 'style')
assert.ok(styleNode !== undefined, 'the component carries its own stylesheet')
const styleText = String(styleNode.props.children ?? '')
for (const token of [
  '--dsw-alias-label-primary',
  '--dsw-alias-bg-layer-1',
  '--dsw-radius-md',
  '--dsw-elevation-prominent',
  '--dsw-font-xxs-12',
  '--dsw-alias-button-info-fill',
  '--dsw-focus-ring-color',
]) {
  assert.match(styleText, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `uses host token ${token}`)
}
assert.doesNotMatch(styleText, /#[0-9a-fA-F]{3,6}\b/, 'chrome must not use literal colours')
assert.doesNotMatch(styleText, /rgba?\(/, 'no literal colour functions in the chrome')

// --- 3. first export opens the panel with the format control ---------------
collect(view)
  .find((node) => node.type === 'button')
  .props.onClick()
await tick()
view = tree
const panel = byClass(view, 'dsh-cot-export-panel')[0]
assert.ok(panel !== undefined, 'the result panel opens')
assert.equal(panel.props.role, 'dialog')
const panelText = textOf(panel)
assert.match(panelText, /思维链已导出/)
assert.match(panelText, /665k/, 'reasoning chars are compacted')
assert.match(panelText, /142k/, 'reasoning tokens are compacted')
assert.match(panelText, /demo-ddf6c584-20261027-220000\.md/, 'the file name is shown')
assert.match(panelText, /保存到/)
const formats = formatButtons(panel)
assert.deepEqual(
  formats.map((node) => textOf(node)),
  ['Markdown', 'JSON', 'JSONL', 'Text'],
  'an explicit format control is visible',
)
assert.equal(formats.filter((node) => node.props['data-active'] === 'true').length, 1, 'exactly one active format')
assert.equal(textOf(formats[0]), 'Markdown')
assert.equal(fetchCalls.length, 1)
assert.match(fetchCalls[0], /\/api\/cot\.export\?sessionId=session-demo/)

// --- 4. switching format re-exports that format, panel stays open ----------
formatButtons(tree)
  .find((node) => textOf(node) === 'JSON')
  .props.onClick()
await tick()
view = tree
assert.equal(fetchCalls.length, 2)
assert.match(fetchCalls[1], /format=json/)
const afterSwitch = byClass(view, 'dsh-cot-export-panel')[0]
assert.ok(afterSwitch !== undefined, 'the panel stays open while re-exporting')
assert.equal(
  textOf(formatButtons(afterSwitch).find((node) => node.props['data-active'] === 'true')),
  'JSON',
  'the active format follows the result',
)
assert.match(textOf(afterSwitch), /\.json/, 'the shown file name follows the format')
assert.equal(storage.get('dsh-cot-export.format'), 'json', 'the choice is remembered')

// --- 5. save location: the host directory picker changes the target -------
byAction(afterSwitch, 'change').props.onClick()
await tick(8)
assert.match(fetchCalls[fetchCalls.length - 1], /dir=D%3A%5CMyExports/, 'the picked folder is sent to the host')
const afterDir = byClass(tree, 'dsh-cot-export-panel')[0]
assert.match(textOf(afterDir), /保存到/)

// --- 6. plain download: bytes only, never a navigation to the route ------
downloads.length = 0
const panelBeforeDownload = byClass(tree, 'dsh-cot-export-panel')[0]
assert.equal(
  collect(panelBeforeDownload).filter((node) => node.type === 'a').length,
  0,
  'the panel holds no anchor that navigates to the export route',
)
byAction(panelBeforeDownload, 'download').props.onClick()
await tick(8)
assert.equal(downloads.length, 1, 'the click triggers a blob download')
assert.match(downloads[0].download, /\.json$/, 'the download keeps the artifact name')
assert.match(downloads[0].href, /^blob:/, 'the download uses a blob URL, not the route URL')
assert.match(fetchCalls[fetchCalls.length - 1], /inline=1/, 'the bytes come from the inline response')
assert.doesNotMatch(fetchCalls[fetchCalls.length - 1], /download=1/)
assert.ok(!fetchCalls.some((href) => /download=1/.test(href)), 'no request ever navigates the shell to a document')

// --- 7. save as… uses the shell picker with the same bytes ----------------
savePickerCalls = []
byAction(byClass(tree, 'dsh-cot-export-panel')[0], 'saveas').props.onClick()
await tick(8)
assert.equal(savePickerCalls.length, 1, 'save-as asks the shell where to put the file')
assert.match(savePickerCalls[0].suggestedName, /\.json$/, 'the suggested name keeps the artifact extension')
assert.equal(
  savePickerCalls[0].types[0].accept['application/json'][0],
  '.json',
  'the picker filters to the artifact type',
)

// --- 7b. a shell without a save picker simply omits save-as --------------
const picker = window.showSaveFilePicker
delete window.showSaveFilePicker
mount(sessionId)
collect(tree)
  .find((node) => node.type === 'button')
  .props.onClick()
await tick(8)
const noPickerPanel = byClass(tree, 'dsh-cot-export-panel')[0]
assert.ok(noPickerPanel !== undefined, 'the panel still opens')
assert.equal(byAction(noPickerPanel, 'saveas'), undefined, 'save-as is hidden without a picker')
assert.ok(byAction(noPickerPanel, 'download') !== undefined, 'plain download stays available')
downloads.length = 0
byAction(noPickerPanel, 'download').props.onClick()
await tick(8)
assert.equal(downloads.length, 1, 'plain download still works through the blob path')
window.showSaveFilePicker = picker

// --- 8. review package ----------------------------------------------------
byAction(byClass(tree, 'dsh-cot-export-panel')[0], 'review').props.onClick()
await tick()
view = tree
const reviewPanel = byClass(view, 'dsh-cot-export-panel')[0]
const reviewText = textOf(reviewPanel)
assert.match(reviewText, /复盘包已生成/)
assert.match(reviewText, /REVIEW\.md/)
assert.match(reviewText, /3 个窗口/)
assert.equal(byText(reviewPanel, '复制委派提示词').length, 1)
assert.match(fetchCalls[fetchCalls.length - 1], /mode=review/)

// --- 9. error flow --------------------------------------------------------
const realFetch = globalThis.fetch
globalThis.fetch = async () => ({
  ok: false,
  status: 409,
  statusText: 'Conflict',
  json: async () => ({ error: 'COT_NO_REASONING', message: 'session x recorded no model reasoning' }),
})
byText(reviewPanel, '关闭')[0].props.onClick()
renderNow()
collect(tree)
  .find((node) => node.type === 'button')
  .props.onClick()
await tick()
view = tree
const errorPanel = byClass(view, 'dsh-cot-export-panel')[0]
assert.ok(errorPanel !== undefined, 'the error panel opens')
assert.match(textOf(errorPanel), /导出失败/)
assert.match(textOf(errorPanel), /没有记录到模型推理/, 'a known code maps to actionable copy')
globalThis.fetch = realFetch

// --- 10. English dictionary and remembered preferences --------------------
activeLocale = 'en-US'
mount(sessionId)
assert.equal(collect(tree).find((node) => node.type === 'button').props['aria-label'], 'Export CoT')
activeLocale = 'zh-CN'

console.log(
  `CLIENT OK cell=${registration.options.id} formats=${formats.length} requests=${fetchCalls.length} ` +
    `picker=yes savePicker=yes locales=${dictionaries.length}`,
)
