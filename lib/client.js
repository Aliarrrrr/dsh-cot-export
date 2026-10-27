/**
 * Browser half of dsh-cot-export.
 *
 * One header action: export the open session's chain of thought and report
 * where the artifact landed. It renders inside the shipped
 * `conversation.session.header.actions` list as its own cell, so it sits beside
 * the host's actions instead of replacing any of them, and it styles itself with
 * host theme tokens only.
 *
 * The transport is the authenticated exact Fetch route the Host half registers
 * (`/api/cot.export`). The URL is resolved against the page's own base so a
 * reverse-proxy directory prefix or the desktop shell's `dsh-app://app/` page
 * both reach the Host.
 *
 * A host that does not mount the route (an older Host, a composition without
 * Connection, or a path collision) surfaces as an error chip telling the user to
 * use `/cot`; nothing here throws during render.
 */

window.__ModuleLoader__.load({
  id: 'dsh-cot-export',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-cot-export'
    const SLOT = 'conversation.session.header.actions'
    const RESET_MS = 12000

    const DICTIONARIES = {
      en: {
        label: 'Export CoT',
        tooltip: "Export this session's model chain-of-thought to a file",
        working: 'Exporting the chain of thought…',
        done: '{turns} turns · {chars} chars — click to copy the artifact path',
        copied: 'Artifact path copied',
        download: 'Download the artifact',
        dismiss: 'Dismiss',
        failed: 'Export failed — {message}',
        route: 'the export route is unavailable; type /cot in the composer instead',
        copyFailed: 'could not copy the path — copy it from the tooltip',
      },
      zh: {
        label: '导出 CoT',
        tooltip: '把这个会话的模型思维链导出成文件',
        working: '正在导出思维链…',
        done: '{turns} 轮 · {chars} 字符 — 点击复制文件路径',
        copied: '已复制文件路径',
        download: '下载导出文件',
        dismiss: '关闭',
        failed: '导出失败 — {message}',
        route: '导出接口不可用；请在输入框里使用 /cot',
        copyFailed: '无法复制路径；请从提示气泡里手动复制',
      },
    }

    const CSS = `
.dsh-cot-export-root{display:inline-flex;align-items:center;gap:2px;height:28px}
.dsh-cot-export-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-cot-export-button:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-cot-export-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-cot-export-button[data-busy="true"]{color:var(--dsw-alias-state-warn-primary);cursor:progress}
.dsh-cot-export-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-success-primary);font:11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;cursor:pointer}
.dsh-cot-export-chip[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.dsh-cot-export-chip[data-tone="busy"]{color:var(--dsw-alias-state-warn-primary);cursor:progress}
.dsh-cot-export-mini{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer;text-decoration:none}
.dsh-cot-export-mini:hover{background:var(--dsw-alias-bg-base)}
`

    /** @param {string} template @param {Record<string, string|number>} values */
    const format = (template, values) =>
      String(template).replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values ?? {}, key) ? String(values[key]) : match,
      )

    /** @param {string} message */
    const isTransportFailure = (message) =>
      /failed to fetch|networkerror|load failed|http 404|404|not found/i.test(String(message ?? ''))

    /**
     * Active locale id, lower-cased, without a browser global dependency.
     * @param {object} ctx - browser plugin context.
     * @returns {string} the active locale id.
     */
    const currentLocaleId = (ctx) => {
      try {
        const active = ctx.locale.getSnapshot().active
        return typeof active === 'string' ? active.toLowerCase() : ''
      } catch {
        return ''
      }
    }

    /**
     * @param {object} ctx - browser plugin context.
     * @returns {Function} the slot component.
     */
    function createAction(ctx) {
      // Created once per plugin instance, so both stay referentially stable for
      // `useSyncExternalStore`. They must not be React hooks: this runs during
      // plugin apply, outside any component render.
      const subscribe = (callback) => ctx.locale.subscribe(callback)
      const getSnapshot = () => ctx.locale.getSnapshot().active

      return function CotAction(props) {
        const active = React.useSyncExternalStore(subscribe, getSnapshot)
        const localeId = typeof active === 'string' ? active.toLowerCase() : ''
        const dictionary = localeId.startsWith('zh') ? DICTIONARIES.zh : DICTIONARIES.en
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined
        const [state, setState] = React.useState({ phase: 'idle' })
        const [copied, setCopied] = React.useState(false)
        const abortRef = React.useRef(undefined)
        const timerRef = React.useRef(undefined)

        const clearTimer = React.useCallback(() => {
          if (timerRef.current !== undefined) {
            clearTimeout(timerRef.current)
            timerRef.current = undefined
          }
        }, [])

        const scheduleReset = React.useCallback(() => {
          clearTimer()
          timerRef.current = setTimeout(() => {
            timerRef.current = undefined
            setCopied(false)
            setState({ phase: 'idle' })
          }, RESET_MS)
        }, [clearTimer])

        React.useEffect(
          () => () => {
            clearTimer()
            if (abortRef.current !== undefined) abortRef.current.abort()
          },
          [clearTimer],
        )

        if (sessionId === undefined) {
          // The header slot always supplies sessionId; render nothing rather than
          // throwing and blanking the cell.
          return null
        }

        const start = async () => {
          if (abortRef.current !== undefined) abortRef.current.abort()
          const controller = new AbortController()
          abortRef.current = controller
          clearTimer()
          setCopied(false)
          setState({ phase: 'working' })
          let url
          try {
            url = new URL('api/cot.export', document.baseURI)
          } catch (error) {
            setState({ phase: 'error', message: String(error?.message ?? error) })
            scheduleReset()
            return
          }
          url.searchParams.set('sessionId', sessionId)
          url.searchParams.set('format', 'markdown')
          try {
            const response = await fetch(url.href, {
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
              const detail =
                typeof body?.message === 'string' && body.message !== ''
                  ? body.message
                  : `${response.status} ${response.statusText}`.trim()
              throw new Error(detail)
            }
            setState({
              phase: 'done',
              turns: typeof body?.turns === 'number' ? body.turns : 0,
              chars: typeof body?.reasoning_chars === 'number' ? body.reasoning_chars : 0,
              path: typeof body?.path === 'string' ? body.path : '',
              href: url.href,
            })
            scheduleReset()
          } catch (error) {
            if (controller.signal.aborted) return
            const message = String(error?.message ?? error)
            setState({ phase: 'error', message: isTransportFailure(message) ? dictionary.route : message })
            scheduleReset()
          }
        }

        const downloadHref = () => {
          if (typeof state.path !== 'string' || state.path === '') return undefined
          try {
            const url = new URL('api/cot.export', document.baseURI)
            url.searchParams.set('sessionId', sessionId)
            url.searchParams.set('format', 'markdown')
            url.searchParams.set('download', '1')
            return url.href
          } catch {
            return undefined
          }
        }

        const onCopy = async (path) => {
          try {
            if (typeof path === 'string' && path !== '' && navigator.clipboard !== undefined) {
              await navigator.clipboard.writeText(path)
              setCopied(true)
              return
            }
            throw new Error(dictionary.copyFailed)
          } catch {
            setCopied(false)
          }
        }

        const style = h('style', { key: 'style' }, CSS)
        const icon = h(
          'svg',
          { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
          h('path', { d: 'M5.2 3.8h8.6L18.8 8.6v11.6H5.2z', key: 'doc' }),
          h('path', { d: 'M13.8 3.8v4.8h5', key: 'fold' }),
          h('circle', { cx: 8.6, cy: 12.4, r: 1.15, key: 'a' }),
          h('circle', { cx: 11.9, cy: 15.9, r: 1.15, key: 'b' }),
          h('circle', { cx: 15.3, cy: 11.9, r: 1.15, key: 'c' }),
          h('path', { d: 'M9.6 13.1l1.4 1.9M13.1 15.3l1.3-2.3', key: 'links' }),
        )

        if (state.phase === 'working') {
          return h(
            React.Fragment,
            null,
            style,
            h(
              'span',
              { className: 'dsh-cot-export-root', key: 'root' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-cot-export-button',
                  'data-busy': 'true',
                  title: dictionary.working,
                  'aria-label': dictionary.working,
                  'aria-busy': 'true',
                  disabled: true,
                },
                icon,
              ),
            ),
          )
        }

        if (state.phase === 'done') {
          const download = downloadHref()
          return h(
            React.Fragment,
            null,
            style,
            h(
              'span',
              { className: 'dsh-cot-export-root', key: 'root' },
              h(
                'span',
                {
                  className: 'dsh-cot-export-chip',
                  role: 'status',
                  title: copied
                    ? dictionary.copied
                    : `${format(dictionary.done, { turns: state.turns, chars: state.chars })}\n${state.path}`,
                  onClick: () => {
                    void onCopy(state.path)
                  },
                },
                `✓ ${state.turns}·${state.chars >= 1000 ? `${Math.round(state.chars / 1000)}k` : state.chars}`,
                download === undefined
                  ? null
                  : h(
                      'a',
                      {
                        className: 'dsh-cot-export-mini',
                        href: download,
                        download: '',
                        title: dictionary.download,
                        'aria-label': dictionary.download,
                        onClick: (event) => event.stopPropagation(),
                      },
                      '↓',
                    ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-cot-export-mini',
                    title: dictionary.dismiss,
                    'aria-label': dictionary.dismiss,
                    onClick: (event) => {
                      event.stopPropagation()
                      clearTimer()
                      setCopied(false)
                      setState({ phase: 'idle' })
                    },
                  },
                  '×',
                ),
              ),
            ),
          )
        }

        if (state.phase === 'error') {
          return h(
            React.Fragment,
            null,
            style,
            h(
              'span',
              { className: 'dsh-cot-export-root', key: 'root' },
              h(
                'span',
                {
                  className: 'dsh-cot-export-chip',
                  'data-tone': 'error',
                  role: 'status',
                  title: format(dictionary.failed, { message: state.message }),
                  onClick: () => {
                    clearTimer()
                    setState({ phase: 'idle' })
                  },
                },
                '✕ CoT',
              ),
            ),
          )
        }

        return h(
          React.Fragment,
          null,
          style,
          h(
            'span',
            { className: 'dsh-cot-export-root', key: 'root' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-cot-export-button',
                title: `${dictionary.label} — ${dictionary.tooltip}`,
                'aria-label': dictionary.label,
                onClick: () => {
                  void start()
                },
              },
              icon,
            ),
          ),
        )
      }
    }

    /** @type {{inject: string[], apply: Function}} */
    const plugin = {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', DICTIONARIES.en))
        ctx.effect(() => ctx.locale.register(NS, 'zh', DICTIONARIES.zh))
        const Action = createAction(ctx)
        ctx.effect(() =>
          ctx.slots.inject(SLOT, () =>
            ctx.slots.register(
              {
                name: SLOT,
                id: 'cot-export',
                order: 30,
                registrant: 'dsh-cot-export',
                label: () =>
                  (currentLocaleId(ctx).startsWith('zh') ? DICTIONARIES.zh : DICTIONARIES.en).label,
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
