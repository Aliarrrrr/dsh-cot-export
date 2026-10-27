/**
 * Browser half of dsh-cot-export.
 *
 * One header action: export the open session's chain of thought and report the
 * artifact in an anchored panel. It renders inside the shipped
 * `conversation.session.header.actions` list as its own cell, so it sits beside
 * the host's actions instead of replacing any of them, and it styles itself with
 * host theme tokens only (`--dsw-font-*`, `--dsw-radius-*`,
 * `--dsw-shadow-*`, `--dsw-alias-*`) so it follows the active theme.
 *
 * Flow: one click exports with the selected format and opens the panel. Inside
 * the panel the format is an explicit segmented control — picking another format
 * re-exports immediately and updates the same panel — and the save location can
 * be changed with the host's own directory picker. The download button uses the
 * browser's save-file picker when the shell provides one, so the user chooses
 * where the file lands.
 *
 * The transport is the authenticated exact Fetch route the Host half registers
 * (`/api/cot.export`), resolved against the page's own base so a reverse-proxy
 * directory prefix or the desktop shell's `dsh-app://app/` page both reach the
 * Host. A Host that does not mount the route becomes an error with a hint to use
 * `/cot`; nothing here throws during render.
 */

window.__ModuleLoader__.load({
  id: 'dsh-cot-export',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const SLOT = 'conversation.session.header.actions'
    const ROUTE = 'api/cot.export'
    const PANEL_WIDTH = 340
    const PANEL_ESTIMATE_HEIGHT = 300
    const STORAGE_FORMAT = 'dsh-cot-export.format'
    const STORAGE_DIR = 'dsh-cot-export.dir'

    const FORMATS = [
      { id: 'markdown', label: 'Markdown', extension: '.md', mime: 'text/markdown' },
      { id: 'json', label: 'JSON', extension: '.json', mime: 'application/json' },
      { id: 'jsonl', label: 'JSONL', extension: '.jsonl', mime: 'application/x-ndjson' },
      { id: 'text', label: 'Text', extension: '.txt', mime: 'text/plain' },
    ]

    const DICTIONARIES = {
      en: {
        label: 'Export CoT',
        tooltip: 'Export this session’s model chain-of-thought',
        busyExport: 'Exporting the chain of thought…',
        busyReview: 'Building the review package…',
        exportedTitle: 'Chain of thought exported',
        reviewTitle: 'Review package ready',
        errorTitle: 'Export failed',
        scopeAll: 'complete log',
        scopeSurface: 'current context',
        statTurns: 'turns',
        statSteps: 'steps',
        statChars: 'CoT chars',
        statTokens: 'reasoning tokens',
        formatLabel: 'Format',
        locationLabel: 'Save to',
        locationDefault: 'default (workspace)',
        change: 'Change',
        reset: 'Default',
        pathHint: 'Click the path to copy it',
        copyPath: 'Copied',
        copy: 'Copy path',
        copyFailed: 'Copy failed',
        download: 'Download',
        downloaded: 'Downloaded',
        preparing: 'Preparing…',
        saveAs: 'Save as…',
        alreadyOnDisk: 'already on disk: ',
        transferFailed: 'Transfer failed: {message}',
        saved: 'Saved',
        review: 'Review package',
        close: 'Close',
        retry: 'Retry',
        reviewHint: '{count} window(s) · rubric and window plan',
        copyPrompt: 'Copy delegation prompt',
        promptCopied: 'Prompt copied',
        routeHint: 'the export route is unavailable; type /cot in the composer instead',
        noReasoningHint: 'this session recorded no model reasoning to export',
        unauthorizedHint: 'that session is outside this workspace',
        pickerUnavailable: 'this shell has no directory picker; the export uses the default folder',
      },
      zh: {
        label: '导出 CoT',
        tooltip: '把这个会话的模型思维链导出成文件',
        busyExport: '正在导出思维链…',
        busyReview: '正在生成复盘包…',
        exportedTitle: '思维链已导出',
        reviewTitle: '复盘包已生成',
        errorTitle: '导出失败',
        scopeAll: '完整日志',
        scopeSurface: '当前上下文',
        statTurns: '轮',
        statSteps: '步',
        statChars: '推理字符',
        statTokens: '推理 token',
        formatLabel: '格式',
        locationLabel: '保存到',
        locationDefault: '默认（工作区）',
        change: '更改',
        reset: '默认',
        pathHint: '点击路径即可复制',
        copyPath: '已复制',
        copy: '复制路径',
        copyFailed: '复制失败',
        download: '下载',
        downloaded: '已下载',
        preparing: '准备中…',
        saveAs: '另存为…',
        alreadyOnDisk: '文件已写在：',
        transferFailed: '传输失败：{message}',
        saved: '已保存',
        review: '复盘包',
        close: '关闭',
        retry: '重试',
        reviewHint: '{count} 个窗口 · 评分规则与窗口计划',
        copyPrompt: '复制委派提示词',
        promptCopied: '提示词已复制',
        routeHint: '导出接口不可用；请在输入框里使用 /cot',
        noReasoningHint: '这个会话没有记录到模型推理，无法导出',
        unauthorizedHint: '该会话不在当前工作区',
        pickerUnavailable: '当前外壳没有目录选择器，将使用默认目录',
      },
    }

    const CSS = `
.dsh-cot-export-root{display:inline-flex;align-items:center;gap:2px;height:28px;position:relative}
.dsh-cot-export-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .12s ease,color .12s ease}
.dsh-cot-export-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-cot-export-button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color)}
.dsh-cot-export-button[data-busy="true"]{color:var(--dsw-alias-state-warn-primary);cursor:progress}
.dsh-cot-export-button[data-error="true"]{color:var(--dsw-alias-state-error-primary)}
.dsh-cot-export-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-button-info-fill,var(--dsw-alias-brand-primary));margin-left:1px;align-self:flex-start;margin-top:3px}
.dsh-cot-export-panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;width:340px;max-width:calc(100vw - 16px);max-height:min(70vh,560px);overflow:auto;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}
.dsh-cot-export-panel::-webkit-scrollbar{width:8px}
.dsh-cot-export-panel::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:4px}
.dsh-cot-export-panel::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2)}
.dsh-cot-export-head{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-cot-export-head-icon{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary)}
.dsh-cot-export-title{flex:1;min-width:0;font:var(--dsw-font-xxs-strong-12);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-cot-export-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-s-14);line-height:1}
.dsh-cot-export-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-cot-export-close:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color)}
.dsh-cot-export-meta{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));margin-top:-4px}
.dsh-cot-export-formats{display:flex;gap:2px;padding:2px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2)}
.dsh-cot-export-format{flex:1 1 0;min-width:0;height:24px;padding:0 4px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-strong-11);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-cot-export-format:hover{color:var(--dsw-alias-label-primary)}
.dsh-cot-export-format[data-active="true"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv2)}
.dsh-cot-export-format:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color)}
.dsh-cot-export-format[disabled]{cursor:progress;opacity:.55}
.dsh-cot-export-progress{height:2px;border-radius:2px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.dsh-cot-export-progress i{display:block;width:38%;height:100%;border-radius:2px;background:var(--dsw-alias-button-info-fill,var(--dsw-alias-brand-primary));animation:dsh-cot-export-slide 1.1s ease-in-out infinite}
@keyframes dsh-cot-export-slide{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
.dsh-cot-export-stats{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.dsh-cot-export-stat{display:flex;flex-direction:column;gap:1px;padding:6px 8px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2)}
.dsh-cot-export-stat-value{font:var(--dsw-font-s-strong-14);font-variant-numeric:tabular-nums}
.dsh-cot-export-stat-label{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-cot-export-file{display:flex;flex-direction:column;gap:3px;padding:8px 9px;border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2);cursor:pointer;text-align:left}
.dsh-cot-export-file:hover{border-color:var(--dsw-alias-border-l2)}
.dsh-cot-export-file:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color)}
.dsh-cot-export-file-name{display:flex;align-items:center;gap:6px;min-width:0;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-primary)}
.dsh-cot-export-file-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-cot-export-file-copy{flex:none;margin-left:auto;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}
.dsh-cot-export-file-dir{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;line-height:1.4;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.dsh-cot-export-row{display:flex;align-items:center;gap:6px;min-width:0}
.dsh-cot-export-row-label{flex:none;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}
.dsh-cot-export-row-value{flex:1;min-width:0;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.dsh-cot-export-actions{display:flex;flex-wrap:wrap;gap:6px}
.dsh-cot-export-btn{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 11px;border:1px solid var(--dsw-alias-hairline,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxxs-strong-11);cursor:pointer;white-space:nowrap;text-decoration:none}
.dsh-cot-export-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-cot-export-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color)}
.dsh-cot-export-btn[data-tone="primary"]{border-color:transparent;background:var(--dsw-alias-button-info-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-button-info-label,var(--dsw-alias-accent-ink))}
.dsh-cot-export-btn[data-tone="primary"]:hover{background:var(--dsw-alias-button-info-hover,var(--dsw-alias-button-info-fill))}
.dsh-cot-export-btn[data-size="mini"]{height:22px;padding:0 8px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary)}
.dsh-cot-export-btn[disabled]{opacity:.4;cursor:default}
.dsh-cot-export-error{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-state-error-primary);word-break:break-word}
.dsh-cot-export-hint{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}
.dsh-cot-export-live{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
`

    /** @param {string} template @param {Record<string, string|number>} values */
    const fill = (template, values) =>
      String(template).replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values ?? {}, key) ? String(values[key]) : match,
      )

    /** @param {number} value @returns {string} a compact count. */
    const compact = (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value < 1000) return String(value)
      if (value < 10000) return `${(value / 1000).toFixed(1)}k`
      if (value < 1000000) return `${(value / 1000).toFixed(0)}k`
      return `${(value / 1000000).toFixed(1)}m`
    }

    /** @param {string} value @returns {string} the trailing path segment. */
    const baseName = (value) => {
      const parts = String(value ?? '').split(/[\\/]+/)
      return parts[parts.length - 1] || ''
    }

    /** @param {string} key @returns {string|undefined} */
    const readStorage = (key) => {
      try {
        const value = window.localStorage.getItem(key)
        return typeof value === 'string' && value !== '' ? value : undefined
      } catch {
        return undefined
      }
    }

    /** @param {string} key @param {string|undefined} value */
    const writeStorage = (key, value) => {
      try {
        if (typeof value === 'string' && value !== '') window.localStorage.setItem(key, value)
        else window.localStorage.removeItem(key)
      } catch {
        // A shell without storage simply forgets the preference.
      }
    }

    /** @param {unknown} message @returns {boolean} */
    const isTransportFailure = (message) =>
      /failed to fetch|networkerror|load failed|http 404|not found/i.test(String(message ?? ''))

    /**
     * @param {object} ctx - browser plugin context.
     * @returns {Function} the slot component.
     */
    function createAction(ctx) {
      // Created once per plugin instance so both stay referentially stable for
      // `useSyncExternalStore`. They must not be hooks: this runs during plugin
      // apply, outside any component render.
      const subscribe = (callback) => ctx.locale.subscribe(callback)
      const getSnapshot = () => ctx.locale.getSnapshot().active

      return function CotAction(props) {
        const active = React.useSyncExternalStore(subscribe, getSnapshot)
        const dictionary =
          (typeof active === 'string' ? active.toLowerCase() : '').startsWith('zh')
            ? DICTIONARIES.zh
            : DICTIONARIES.en
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined

        // Read at render/click time, not at apply time: the workspace service may
        // be composed after this plugin's client half loads, and the picker must
        // degrade per render instead of being disabled forever.
        const workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
        const canPickDirectory = workspace !== undefined && typeof workspace?.pickDirectory === 'function'

        const [state, setState] = React.useState({ phase: 'idle' })
        const [format, setFormat] = React.useState(() => readStorage(STORAGE_FORMAT) ?? '')
        const [saveDir, setSaveDir] = React.useState(() => readStorage(STORAGE_DIR) ?? '')
        const [copied, setCopied] = React.useState('')
        const [position, setPosition] = React.useState(undefined)
        const [pending, setPending] = React.useState('')
        const [transferError, setTransferError] = React.useState('')
        const abortRef = React.useRef(undefined)
        const buttonRef = React.useRef(undefined)
        const panelRef = React.useRef(undefined)

        const close = React.useCallback(() => {
          if (abortRef.current !== undefined) abortRef.current.abort()
          setCopied('')
          setPosition(undefined)
          setState({ phase: 'idle' })
        }, [])

        const place = React.useCallback(() => {
          const button = buttonRef.current
          if (button === null || button === undefined || typeof button.getBoundingClientRect !== 'function') return
          const rect = button.getBoundingClientRect()
          const viewport =
            typeof window === 'undefined'
              ? { width: 1280, height: 800 }
              : { width: window.innerWidth, height: window.innerHeight }
          const left = Math.max(8, Math.min(viewport.width - 8 - PANEL_WIDTH, rect.right - PANEL_WIDTH))
          const fitsBelow = rect.bottom + PANEL_ESTIMATE_HEIGHT < viewport.height
          const top = fitsBelow ? rect.bottom + 6 : Math.max(8, rect.top - PANEL_ESTIMATE_HEIGHT - 6)
          setPosition({ top: `${Math.round(top)}px`, left: `${Math.round(left)}px` })
        }, [])

        const panelOpen = state.phase !== 'idle'

        // Position before the browser paints, so the panel never flashes at its
        // fallback coordinates before settling under the button.
        const useBeforePaint = React.useLayoutEffect ?? React.useEffect
        useBeforePaint(() => {
          if (panelOpen) place()
        }, [panelOpen, state.phase, place])

        React.useEffect(() => {
          if (!panelOpen) return undefined
          const onPointer = (event) => {
            const target = event.target
            if (panelRef.current?.contains?.(target) === true) return
            if (buttonRef.current?.contains?.(target) === true) return
            close()
          }
          const onKey = (event) => {
            if (event.key === 'Escape') close()
          }
          const onMove = () => place()
          document.addEventListener('mousedown', onPointer, true)
          document.addEventListener('keydown', onKey)
          window.addEventListener('resize', onMove)
          window.addEventListener('scroll', onMove, true)
          return () => {
            document.removeEventListener('mousedown', onPointer, true)
            document.removeEventListener('keydown', onKey)
            window.removeEventListener('resize', onMove)
            window.removeEventListener('scroll', onMove, true)
          }
        }, [panelOpen, close, place])

        React.useEffect(
          () => () => {
            if (abortRef.current !== undefined) abortRef.current.abort()
          },
          [],
        )

        if (sessionId === undefined) return null

        /** @param {Record<string, string|undefined>} query @returns {string|undefined} */
        const routeUrl = (query) => {
          try {
            const url = new URL(ROUTE, document.baseURI)
            url.searchParams.set('sessionId', sessionId)
            for (const [key, value] of Object.entries(query)) {
              if (typeof value === 'string' && value !== '') url.searchParams.set(key, value)
            }
            return url.href
          } catch {
            return undefined
          }
        }

        /**
         * Run one request against the Host and fold the result into the panel.
         * `dir` is passed explicitly rather than read from state, so a folder the
         * picker just returned is used by the very export that follows it.
         * @param {{mode?: 'export'|'review', format?: string, dir?: string}} options
         */
        const run = async (options) => {
          const mode = options.mode === 'review' ? 'review' : 'export'
          const dir = typeof options.dir === 'string' && options.dir !== '' ? options.dir : undefined
          setCopied('')
          setState((current) =>
            current.phase === 'idle'
              ? { phase: 'working', mode, previous: undefined }
              : { phase: 'working', mode, previous: current.phase === 'error' ? undefined : current },
          )
          try {
            const href = routeUrl({
              mode: mode === 'review' ? 'review' : undefined,
              format: mode === 'review' ? undefined : options.format ?? format ?? undefined,
              dir,
            })
            if (href === undefined) throw new Error(dictionary.routeHint)
            if (abortRef.current !== undefined) abortRef.current.abort()
            const controller = new AbortController()
            abortRef.current = controller
            const response = await fetch(href, {
              method: 'GET',
              credentials: 'same-origin',
              signal: controller.signal,
              headers: { accept: 'application/json' },
            })
            let body
            try {
              body = await response.json()
            } catch {
              body = undefined
            }
            if (response.ok !== true) {
              const code = typeof body?.error === 'string' ? body.error : ''
              const detail =
                typeof body?.message === 'string' && body.message !== ''
                  ? body.message
                  : `${response.status} ${response.statusText}`.trim()
              throw Object.assign(new Error(detail), { code })
            }
            const data = body ?? {}
            if (mode === 'export' && typeof data.format === 'string' && data.format !== '') {
              setFormat(data.format)
              writeStorage(STORAGE_FORMAT, data.format)
            }
            setState({ phase: mode === 'review' ? 'review' : 'done', data, mode })
          } catch (error) {
            if (error?.name === 'AbortError') return
            const message = String(error?.message ?? error)
            const code = typeof error?.code === 'string' ? error.code : ''
            const hint =
              code === 'COT_NO_REASONING'
                ? dictionary.noReasoningHint
                : code === 'COT_UNAUTHORIZED'
                  ? dictionary.unauthorizedHint
                  : isTransportFailure(message)
                    ? dictionary.routeHint
                    : ''
            setState({ phase: 'error', message, hint, mode })
          }
        }

        /** @param {string} key @param {string} text */
        const copy = async (key, text) => {
          try {
            if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && text !== '') {
              await navigator.clipboard.writeText(text)
              setCopied(key)
              return
            }
            throw new Error(dictionary.copyFailed)
          } catch {
            setCopied('')
          }
        }

        /**
         * Ask the host shell for a folder and export there from now on.
         * Falls back to the configured directory when the shell has no picker.
         */
        const changeDirectory = async () => {
          if (!canPickDirectory) {
            setCopied('picker')
            return
          }
          try {
            const picked = await workspace.pickDirectory()
            if (typeof picked !== 'string' || picked.trim() === '') return
            const directory = picked.trim()
            setSaveDir(directory)
            writeStorage(STORAGE_DIR, directory)
            void run({ mode: state.phase === 'review' ? 'review' : 'export', dir: directory })
          } catch {
            setCopied('')
          }
        }

        const resetDirectory = () => {
          setSaveDir('')
          writeStorage(STORAGE_DIR, undefined)
          void run({ mode: state.phase === 'review' ? 'review' : 'export', dir: undefined })
        }

        /**
         * Fetch the bytes of an artifact that is already on disk (`inline=1`).
         * Fetching keeps the transfer off the navigation path: the shell never
         * sees a document URL for a Markdown/JSON artifact, so it cannot open the
         * artifact as a page or raise its own download prompt.
         * @param {object} data - route payload.
         * @returns {Promise<{blob: Blob, name: string, chosen: object}>}
         */
        const fetchArtifact = async (data) => {
          const chosen = FORMATS.find((entry) => entry.id === (data.format ?? format)) ?? FORMATS[0]
          const name = baseName(data.path) || `cot-export${chosen.extension}`
          const href = routeUrl({ format: String(data.format ?? chosen.id), inline: '1', dir: saveDir })
          if (href === undefined) throw new Error(dictionary.routeHint)
          const response = await fetch(href, { credentials: 'same-origin' })
          if (response.ok !== true) throw new Error(`${response.status} ${response.statusText}`.trim())
          return { blob: await response.blob(), name, chosen }
        }

        /** @param {unknown} error @param {object} data */
        const reportTransferError = (error, data) => {
          const message = String(error?.message ?? error)
          const written = typeof data?.path === 'string' ? data.path : ''
          const base = fill(dictionary.transferFailed, { message })
          setTransferError(written === '' ? base : `${base} · ${dictionary.alreadyOnDisk}${written}`)
        }

        /**
         * Plain download: no picker, no navigation. A detached anchor with a blob
         * URL hands the bytes to the shell's ordinary download flow with the exact
         * artifact name.
         * @param {object} data - route payload.
         */
        const downloadArtifact = async (data) => {
          setTransferError('')
          setPending('download')
          try {
            const { blob, name } = await fetchArtifact(data)
            const url = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = name
            anchor.rel = 'noopener'
            anchor.click()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
            setCopied('downloaded')
          } catch (error) {
            if (error?.name === 'AbortError') return
            reportTransferError(error, data)
          } finally {
            setPending('')
          }
        }

        /**
         * Save-as: ask the shell where to put the file, then write the same bytes
         * there. Offered only when the shell implements the save picker.
         * @param {object} data - route payload.
         */
        const saveArtifactAs = async (data) => {
          const picker = typeof window === 'undefined' ? undefined : window.showSaveFilePicker
          if (typeof picker !== 'function') return
          setTransferError('')
          setPending('saveas')
          try {
            const { blob, name, chosen } = await fetchArtifact(data)
            const handle = await picker.call(window, {
              suggestedName: name,
              types: [{ description: 'Chain of thought export', accept: { [chosen.mime]: [chosen.extension] } }],
            })
            const writable = await handle.createWritable()
            await writable.write(blob)
            await writable.close()
            setCopied('saved')
          } catch (error) {
            if (error?.name === 'AbortError') return
            reportTransferError(error, data)
          } finally {
            setPending('')
          }
        }

        const documentIcon = h(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: 16,
            height: 16,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
          },
          h('path', { d: 'M5.2 3.8h8.6L18.8 8.6v11.6H5.2z', key: 'doc' }),
          h('path', { d: 'M13.8 3.8v4.8h5', key: 'fold' }),
          h('circle', { cx: 8.6, cy: 12.4, r: 1.15, key: 'a' }),
          h('circle', { cx: 11.9, cy: 15.9, r: 1.15, key: 'b' }),
          h('circle', { cx: 15.3, cy: 11.9, r: 1.15, key: 'c' }),
          h('path', { d: 'M9.6 13.1l1.4 1.9M13.1 15.3l1.3-2.3', key: 'links' }),
        )

        const busy = state.phase === 'working' || state.phase === 'reviewing'
        const isError = state.phase === 'error'
        const data = state.data ?? {}
        const reviewing = state.phase === 'review'
        const previous = state.previous

        const closeButton = h(
          'button',
          {
            key: 'close',
            type: 'button',
            className: 'dsh-cot-export-close',
            title: dictionary.close,
            'aria-label': dictionary.close,
            onClick: close,
          },
          '×',
        )

        /** @param {string} text @param {string} key @param {object} [options] */
        const button = (text, key, options = {}) =>
          h(
            'button',
            {
              key,
              type: 'button',
              className: 'dsh-cot-export-btn',
              'data-tone': options.tone,
              'data-size': options.size,
              'data-action': options.action ?? key,
              disabled: options.disabled === true,
              title: options.title,
              onClick: options.onClick,
            },
            text,
          )

        const formats = h(
          'div',
          { className: 'dsh-cot-export-formats', key: 'formats' },
          ...FORMATS.map((entry) =>
            h(
              'button',
              {
                key: entry.id,
                type: 'button',
                className: 'dsh-cot-export-format',
                'data-active': (data.format ?? format ?? 'markdown') === entry.id ? 'true' : 'false',
                'aria-pressed': (data.format ?? format ?? 'markdown') === entry.id ? 'true' : 'false',
                disabled: busy || reviewing,
                onClick: () => void run({ mode: 'export', format: entry.id, dir: saveDir }),
              },
              entry.label,
            ),
          ),
        )

        const locationRow = h(
          'div',
          { className: 'dsh-cot-export-row', key: 'location' },
          h('span', { className: 'dsh-cot-export-row-label' }, dictionary.locationLabel),
          h(
            'span',
            { className: 'dsh-cot-export-row-value', title: data.output_dir ?? (saveDir || dictionary.locationDefault) },
            data.output_dir ?? (saveDir || dictionary.locationDefault),
          ),
          button(dictionary.change, 'change', {
            size: 'mini',
            disabled: busy,
            title: canPickDirectory ? dictionary.change : dictionary.pickerUnavailable,
            onClick: () => void changeDirectory(),
          }),
          saveDir === '' || busy ? null : button(dictionary.reset, 'reset', { size: 'mini', onClick: resetDirectory }),
        )

        const stats = h(
          'div',
          { className: 'dsh-cot-export-stats', key: 'stats' },
          ...[
            [compact(data.turns), dictionary.statTurns],
            [compact(data.steps), dictionary.statSteps],
            [compact(data.reasoning_chars), dictionary.statChars],
            [compact(data.reasoning_tokens), dictionary.statTokens],
          ].map(([value, label], index) =>
            h(
              'div',
              { className: 'dsh-cot-export-stat', key: `stat-${index}` },
              h('span', { className: 'dsh-cot-export-stat-value' }, String(value)),
              h('span', { className: 'dsh-cot-export-stat-label' }, label),
            ),
          ),
        )

        /** @param {object} current */
        const renderPanel = (current) => {
          const children = []
          const working = current.phase === 'working' || current.phase === 'reviewing'
          const reviewingNow = current.phase === 'review' || current.mode === 'review'
          const shown = current.data ?? previous?.data ?? {}
          const title = working
            ? current.mode === 'review'
              ? dictionary.busyReview
              : dictionary.busyExport
            : current.phase === 'error'
              ? dictionary.errorTitle
              : current.phase === 'review'
                ? dictionary.reviewTitle
                : dictionary.exportedTitle

          children.push(
            h(
              'div',
              { className: 'dsh-cot-export-head', key: 'head' },
              h('span', { className: 'dsh-cot-export-head-icon', key: 'icon' }, documentIcon),
              h('span', { className: 'dsh-cot-export-title' }, title),
              closeButton,
            ),
          )

          if (working) {
            children.push(h('div', { className: 'dsh-cot-export-progress', key: 'progress' }, h('i', null)))
          }

          if (current.phase === 'error') {
            children.push(
              h('div', { className: 'dsh-cot-export-error', key: 'message' }, String(current.message ?? '')),
            )
            if (typeof current.hint === 'string' && current.hint !== '') {
              children.push(h('div', { className: 'dsh-cot-export-hint', key: 'hint' }, current.hint))
            }
            children.push(
              h(
                'div',
                { className: 'dsh-cot-export-actions', key: 'actions' },
                button(dictionary.retry, 'retry', {
                  tone: 'primary',
                  onClick: () => void run({ mode: current.mode === 'review' ? 'review' : 'export', dir: saveDir }),
                }),
                button(dictionary.close, 'dismiss', { onClick: close }),
              ),
            )
          } else {
            if (typeof shown.format === 'string' || format !== '') {
              children.push(
                h(
                  'div',
                  { className: 'dsh-cot-export-meta', key: 'meta' },
                  `${String(shown.format ?? format ?? 'markdown')} · ${
                    shown.scope === 'surface' ? dictionary.scopeSurface : dictionary.scopeAll
                  }`,
                ),
              )
            }
            if (!reviewingNow) children.push(formats)
            children.push(stats)

            const primaryPath = reviewingNow ? shown.review_path : shown.path
            if (typeof primaryPath === 'string' && primaryPath !== '' && !working) {
              children.push(
                h(
                  'div',
                  {
                    className: 'dsh-cot-export-file',
                    key: 'file',
                    role: 'button',
                    tabIndex: 0,
                    title: `${primaryPath}\n${dictionary.pathHint}`,
                    onClick: () => void copy('path', primaryPath),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        void copy('path', primaryPath)
                      }
                    },
                  },
                  h(
                    'div',
                    { className: 'dsh-cot-export-file-name' },
                    h('span', null, baseName(primaryPath)),
                    h(
                      'span',
                      { className: 'dsh-cot-export-file-copy' },
                      copied === 'path' ? dictionary.copyPath : dictionary.copy,
                    ),
                  ),
                  h('div', { className: 'dsh-cot-export-file-dir', title: primaryPath }, primaryPath),
                ),
              )
            }

            if (!reviewingNow) children.push(locationRow)

            if (reviewingNow && typeof shown.cot_path === 'string' && !working) {
              children.push(
                h(
                  'div',
                  { className: 'dsh-cot-export-hint', key: 'review-hint' },
                  `${baseName(shown.review_path ?? 'REVIEW.md')} · ${fill(dictionary.reviewHint, {
                    count: shown.windows ?? 0,
                  })}`,
                ),
              )
            }

            const actions = []
            if (working) {
              actions.push(button(dictionary.close, 'dismiss', { disabled: true, onClick: () => {} }))
            } else if (reviewingNow) {
              actions.push(
                button(
                  copied === 'prompt' ? dictionary.promptCopied : dictionary.copyPrompt,
                  'prompt',
                  { tone: 'primary', onClick: () => void copy('prompt', String(shown.delegation_prompt ?? '')) },
                ),
                button(dictionary.close, 'dismiss', { onClick: close }),
              )
            } else {
              const transferring = pending !== ''
              const saveAsAvailable = typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
              actions.push(
                button(
                  copied === 'downloaded' ? dictionary.downloaded : pending === 'download' ? dictionary.preparing : dictionary.download,
                  'download',
                  {
                    tone: 'primary',
                    disabled: transferring,
                    onClick: () => void downloadArtifact(shown),
                  },
                ),
                saveAsAvailable
                  ? button(pending === 'saveas' ? dictionary.preparing : dictionary.saveAs, 'saveas', {
                      disabled: transferring,
                      onClick: () => void saveArtifactAs(shown),
                    })
                  : null,
                button(dictionary.review, 'review', {
                  disabled: transferring,
                  onClick: () => void run({ mode: 'review', dir: saveDir }),
                }),
              )
              if (transferError !== '') {
                children.push(h('div', { className: 'dsh-cot-export-error', key: 'transfer-error' }, transferError))
              }
            }
            children.push(h('div', { className: 'dsh-cot-export-actions', key: 'actions' }, ...actions))
          }

          return h(
            'div',
            {
              ref: panelRef,
              key: 'panel',
              className: 'dsh-cot-export-panel',
              role: 'dialog',
              'aria-busy': working ? 'true' : 'false',
              'aria-label': title,
              style: position ?? { top: '72px', right: '16px' },
              onClick: (event) => event.stopPropagation(),
            },
            ...children,
          )
        }

        return h(
          React.Fragment,
          null,
          h('style', { key: 'style' }, CSS),
          h(
            'span',
            { className: 'dsh-cot-export-root', key: 'root' },
            h(
              'button',
              {
                ref: buttonRef,
                type: 'button',
                className: 'dsh-cot-export-button',
                'data-busy': busy ? 'true' : 'false',
                'data-error': isError ? 'true' : 'false',
                title: busy
                  ? state.mode === 'review'
                    ? dictionary.busyReview
                    : dictionary.busyExport
                  : `${dictionary.label} — ${dictionary.tooltip}`,
                'aria-label': dictionary.label,
                'aria-busy': busy ? 'true' : 'false',
                disabled: busy,
                onClick: () => void run({ mode: 'export', dir: saveDir }),
              },
              documentIcon,
              panelOpen && !isError && !busy ? h('span', { className: 'dsh-cot-export-dot', key: 'dot' }) : null,
            ),
          ),
          panelOpen ? renderPanel(state) : null,
          panelOpen
            ? h(
                'span',
                { key: 'live', className: 'dsh-cot-export-live', role: 'status', 'aria-live': 'polite' },
                isError ? dictionary.errorTitle : dictionary.exportedTitle,
              )
            : null,
        )
      }
    }

    /** @type {{inject: string[], apply: Function}} */
    const plugin = {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('dsh-cot-export', 'en', DICTIONARIES.en))
        ctx.effect(() => ctx.locale.register('dsh-cot-export', 'zh', DICTIONARIES.zh))
        const Action = createAction(ctx)
        ctx.effect(() =>
          ctx.slots.inject(SLOT, () =>
            ctx.slots.register(
              {
                name: SLOT,
                id: 'cot-export',
                order: 30,
                registrant: 'dsh-cot-export',
                label: () => {
                  let id = ''
                  try {
                    const snapshot = ctx.locale.getSnapshot().active
                    id = typeof snapshot === 'string' ? snapshot.toLowerCase() : ''
                  } catch {
                    id = ''
                  }
                  return (id.startsWith('zh') ? DICTIONARIES.zh : DICTIONARIES.en).label
                },
              },
              Action,
            ),
          ),
        )
      },
    }

    return plugin
  },
})
