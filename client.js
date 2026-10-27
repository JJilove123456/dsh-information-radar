/**
 * dsh-info-radar · 客户端半
 *
 * 三块界面：
 * 1) sidebar.panellist 图标：右侧徽标（红色未读数 / 橙色感叹号待登录）
 * 2) main 面板：源列表、条目流、设置
 * 3) shell.overlay 浮层：掉登录态提示卡片
 *
 * 所有数据走本插件自己的 /api/dsh-info-radar/* 端点。
 */
window.__ModuleLoader__.load({
  id: 'dsh-info-radar',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'infoRadar'
    const PANEL_ID = 'info-radar'
    const STYLE_TAG_ID = 'dsh-info-radar/styles'
    const API = '/api/dsh-info-radar'

    const CSS = `
.ir-icon{position:static;display:inline-flex;align-items:center;justify-content:center;flex:none}
.ir-badges{position:fixed;left:0;top:0;display:flex;flex-direction:row;align-items:center;gap:2px;pointer-events:none;z-index:60}
.ir-badge{display:flex;align-items:center;justify-content:center;min-width:13px;height:13px;padding:0 3px;box-sizing:border-box;border-radius:999px;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base);font-size:8px;line-height:13px;font-weight:700;font-variant-numeric:tabular-nums}
.ir-warn{display:flex;align-items:center;justify-content:center;width:13px;height:13px;border-radius:999px;background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-bg-base);font-size:9px;line-height:13px;font-weight:700}
.ir-page{display:flex;flex-direction:column;gap:0;height:100%;box-sizing:border-box;overflow:hidden;color:var(--dsw-alias-label-primary)}
.ir-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:16px 22px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ir-title{font-size:16px;line-height:24px;margin:0;font-weight:600}
.ir-stats{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.ir-body{display:flex;flex:1;min-height:0}
.ir-side{width:280px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow-y:auto;padding:10px}
.ir-main{flex:1;min-width:0;overflow-y:auto;padding:14px 18px}
.ir-btn{font-size:12px;line-height:18px;padding:5px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
.ir-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.ir-btn:disabled{opacity:.45;cursor:default}
.ir-btn[data-kind=primary]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.ir-btn[data-kind=danger]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:transparent}
.ir-btn[data-kind=ghost]{background:transparent}
.ir-row{display:flex;flex-direction:column;gap:4px;padding:9px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.ir-row:hover{background:var(--dsw-alias-bg-layer-2)}
.ir-row[data-active]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.ir-rowhead{display:flex;align-items:center;gap:6px;min-width:0}
.ir-rowname{font-size:13px;line-height:19px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.ir-dot{width:7px;height:7px;border-radius:999px;flex:none}
.ir-dot[data-s=ok]{background:var(--dsw-alias-state-success-primary)}
.ir-dot[data-s=needs-cookie]{background:var(--dsw-alias-state-warn-primary)}
.ir-dot[data-s=paused]{background:var(--dsw-alias-state-idle-primary)}
.ir-dot[data-s=error]{background:var(--dsw-alias-state-error-primary)}
.ir-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ir-rowbadge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:999px;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base);font-size:10px;line-height:16px;font-weight:700;font-variant-numeric:tabular-nums;flex:none}
.ir-item{display:flex;flex-direction:column;gap:5px;padding:12px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);margin-bottom:10px}
.ir-item[data-unread]{border-left:3px solid var(--dsw-alias-state-error-primary)}
.ir-itemhead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.ir-itemtitle{font-size:13px;line-height:20px;font-weight:600;margin:0}
.ir-tag{font-size:10px;line-height:15px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.ir-tag[data-tone=warn]{background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-bg-base)}
.ir-summary{font-size:12px;line-height:19px;color:var(--dsw-alias-label-primary);margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.ir-link{font-size:11px;line-height:16px;color:var(--dsw-alias-brand-primary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.ir-link:hover{text-decoration:underline}
.ir-itemfoot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}
.ir-children{margin-top:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l1)}
.ir-childtoggle{display:flex;align-items:center;gap:5px;background:transparent;border:0;padding:2px 0;cursor:pointer;color:var(--dsw-alias-brand-primary);font-size:12px;line-height:18px;text-align:left;font-family:inherit}
.ir-childtoggle:hover{text-decoration:underline}
.ir-caret{font-size:10px;line-height:14px;display:inline-block;width:12px;flex:none}
.ir-childlist{display:flex;flex-direction:column;gap:10px;margin:6px 0 0 14px;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l1)}
.ir-child{display:flex;flex-direction:column;gap:3px}
.ir-childhead{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.ir-childtitle{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}
.ir-attach{color:var(--dsw-alias-label-secondary);font-style:italic}
.ir-card2{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);margin-bottom:10px}
.ir-card2title{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ir-cmd{margin:0;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);font-family:ui-monospace,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary);overflow-x:auto;white-space:pre}
.ir-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:50px 20px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;text-align:center}
.ir-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.ir-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-weight:500}
.ir-input,.ir-select,.ir-textarea{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-family:inherit;outline:none}
.ir-input:focus,.ir-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.ir-textarea{min-height:84px;resize:vertical;font-family:ui-monospace,monospace;font-size:11px}
.ir-hint{font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary);opacity:.8}
.ir-duration{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ir-duration-cell{display:flex;align-items:center;gap:4px}
.ir-duration-input{width:64px;text-align:right;padding:6px 6px}
.ir-duration-unit{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ir-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ir-status{font-size:11px;line-height:16px}
.ir-status[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}
.ir-status[data-tone=err]{color:var(--dsw-alias-state-error-primary)}
.ir-sep{height:1px;background:var(--dsw-alias-border-l1);margin:14px 0}
.ir-modal{position:fixed;inset:0;z-index:400;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}
.ir-dialog{width:min(520px,calc(100vw - 48px));max-height:calc(100vh - 80px);overflow:auto;box-sizing:border-box;padding:18px;border-radius:14px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:10px}
.ir-card{position:fixed;right:18px;bottom:18px;z-index:350;width:min(380px,calc(100vw - 36px));box-sizing:border-box;padding:14px;border-radius:12px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 10px 30px rgba(0,0,0,.22);display:flex;flex-direction:column;gap:9px}
.ir-cardtitle{font-size:13px;line-height:20px;font-weight:600;display:flex;align-items:center;gap:6px}
.ir-cardrow{display:flex;flex-direction:column;gap:5px;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.ir-cardrowname{font-size:12px;line-height:18px;font-weight:500}
.ir-cardrowmeta{font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.ir-collapse{cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px}
`

    // ── 工具 ────────────────────────────────────────────────
    function apiUrl(path) {
      const base = typeof document === 'undefined' ? undefined : document.baseURI
      if (typeof base !== 'string' || base === '') return path
      try {
        const url = new URL(base)
        if (!url.pathname.endsWith('/')) url.pathname += '/'
        return new URL(path.replace(/^\//u, ''), url.href).toString()
      } catch {
        return path
      }
    }

    async function apiJson(path, options) {
      const response = await fetch(apiUrl(path), options)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null) throw new Error(`HTTP ${response.status}`)
      if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload
    }

    const postJson = (path, body) =>
      apiJson(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })

    function formatTime(iso) {
      if (typeof iso !== 'string' || iso === '') return '从未'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      const now = Date.now()
      const diff = now - date.getTime()
      if (diff < 60 * 1000) return '刚刚'
      if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
      if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
      if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`
      return date.toLocaleDateString()
    }

    function formatInterval(minutes) {
      const value = Number(minutes)
      if (!Number.isFinite(value) || value <= 0) return '—'
      if (value < 60) return `${value} 分钟`
      if (value < 1440) return `${Math.round((value / 60) * 10) / 10} 小时`
      if (value % 1440 === 0) return `${value / 1440} 天`
      return `${Math.round((value / 1440) * 10) / 10} 天`
    }

    // ── 共享状态 ────────────────────────────────────────────
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set: (next) => {
          value = next
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch (error) {
              console.error('[info-radar] 订阅者异常:', error)
            }
          }
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    const store = createStore({ status: null, loading: true, error: '' })
    let timer = null
    let inflight = false

    async function refresh() {
      if (inflight) return
      inflight = true
      try {
        const payload = await apiJson(`${API}/status`)
        store.set({ status: payload, loading: false, error: '' })
      } catch (error) {
        store.set({ status: store.get().status, loading: false, error: String(error?.message ?? error) })
      } finally {
        inflight = false
      }
    }

    function useStatus() {
      return React.useSyncExternalStore(store.subscribe, store.get, store.get)
    }

    // ── 图标 ────────────────────────────────────────────────
    function RadarGlyph(props) {
      const size = props?.size ?? 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'currentColor',
          style: { display: 'block', flex: 'none' },
          'aria-hidden': true,
        },
        h('path', { d: 'M1.33 5.89A9.6 9.6 0 0 1 14.67 5.89L13.21 7.4A7.5 7.5 0 0 0 2.79 7.4Z' }),
        h('path', { d: 'M3.83 8.48A6 6 0 0 1 12.17 8.48L10.92 9.78A4.2 4.2 0 0 0 5.08 9.78Z' }),
        h('path', { d: 'M8 12.8L6.39 10.88A2.5 2.5 0 0 1 9.61 10.88Z' }),
      )
    }

    /** 往上找真正的那一行按钮（宿主层级：BUTTON.panelRow > SPAN.panelGlyph > 图标）。 */
    function findRowElement(from) {
      let el = from
      for (let depth = 0; depth < 6 && el !== null && el !== undefined; depth += 1) {
        if (el.tagName === 'BUTTON' && String(el.className).includes('panelRow')) return el
        el = el.parentElement
      }
      el = from
      for (let depth = 0; depth < 6 && el !== null && el !== undefined; depth += 1) {
        if (el.getBoundingClientRect().width > 60) return el
        el = el.parentElement
      }
      return null
    }

    function SidebarIcon(props) {
      const state = useStatus()
      const status = state.status
      const unread = Number(status?.unread) || 0
      const needsCookie = Number(status?.needsCookie) || 0
      const rootRef = React.useRef(null)
      const placeRef = React.useRef(null)

      // 徽标贴在整行右边缘（窄轨时行就是图标宽度，仍然贴行尾），不压图标。
      React.useEffect(() => {
        const icon = rootRef.current
        if (icon === null) return undefined
        const row = findRowElement(icon)
        if (row === null) return undefined
        let frame = 0
        const place = () => {
          const badges = icon.querySelector('.ir-badges')
          if (badges === null) return
          const rowRect = row.getBoundingClientRect()
          const width = badges.getBoundingClientRect().width || 26
          const isWide = rowRect.width > 60
          const rightEdge = rowRect.right - (isWide ? 8 : 2)
          badges.style.left = `${Math.round(rightEdge - width)}px`
          badges.style.top = `${Math.round(rowRect.top + rowRect.height / 2 - 7)}px`
        }
        placeRef.current = place
        const schedule = () => {
          if (frame !== 0) return
          frame = requestAnimationFrame(() => {
            frame = 0
            place()
          })
        }
        place()
        window.setTimeout(place, 500)
        let observer = null
        try {
          observer = new ResizeObserver(schedule)
          observer.observe(row)
        } catch {
          /* 无 ResizeObserver 时只算一次 */
        }
        window.addEventListener('resize', schedule)
        return () => {
          if (frame !== 0) cancelAnimationFrame(frame)
          if (observer !== null) observer.disconnect()
          window.removeEventListener('resize', schedule)
          placeRef.current = null
        }
      }, [])

      React.useLayoutEffect(() => {
        if (placeRef.current !== null) placeRef.current()
      }, [unread, needsCookie])

      return h(
        'span',
        {
          ref: rootRef,
          className: 'ir-icon',
          title:
            needsCookie > 0
              ? `${needsCookie} 个源需要重新登录`
              : unread > 0
                ? `${unread} 条未读`
                : '信息雷达',
        },
        h(RadarGlyph, { size: props?.size ?? 16 }),
        unread > 0 || needsCookie > 0
          ? h(
              'span',
              { className: 'ir-badges' },
              needsCookie > 0 ? h('span', { className: 'ir-warn' }, '!') : null,
              unread > 0 ? h('span', { className: 'ir-badge' }, unread > 99 ? '99+' : String(unread)) : null,
            )
          : null,
      )
    }

    // ── 主面板 ──────────────────────────────────────────────
    function SourceEditor({ source, onCancel, onSaved }) {
      const isNew = source === null || source === undefined
      const [draft, setDraft] = React.useState({
        name: source?.name ?? '',
        url: source?.url ?? '',
        selector: source?.selector ?? '',
        include: (source?.includeKeywords ?? []).join(', '),
        exclude: (source?.excludeKeywords ?? []).join(', '),
        // 新源默认继承全局间隔（用 '' 表示「跟随全局」）
        interval: source?.intervalMinutes === null || source?.intervalMinutes === undefined ? '' : String(source.intervalMinutes),
      })
      const [busy, setBusy] = React.useState(false)
      const [errors, setErrors] = React.useState({})

      /** 逐项校验，把「哪个没填」说清楚，而不是只弹一句错误。 */
      const validate = () => {
        const next = {}
        if (draft.url.trim() === '') {
          next.url = '必填：请填要抓的网址，例如 https://example.com/news'
        } else if (!/^https?:\/\/[^\s]+$/iu.test(draft.url.trim())) {
          next.url = '格式不对：必须以 http:// 或 https:// 开头'
        }
        if (draft.selector.trim() !== '' && /[\s>+~:[\]]/u.test(draft.selector.trim())) {
          next.selector = '不支持空格、>、+、~、: 和 [ ]，只能用 #id、.class 或标签名'
        }
        if (draft.interval.trim() !== '') {
          const minutes = Number(draft.interval)
          if (!Number.isFinite(minutes) || minutes <= 0) {
            next.interval = '格式不对：请填大于 0 的分钟数，或留空跟随全局'
          } else if (minutes < 1) {
            next.interval = '最短 1 分钟'
          } else if (minutes > 525600) {
            next.interval = '最长 365 天（525600 分钟）'
          }
        }
        setErrors(next)
        return Object.keys(next).length === 0
      }

      const save = async () => {
        if (!validate()) return
        setBusy(true)
        try {
          const payload = await apiJson(`${API}/status`)
          const config = payload.config
          const record = {
            ...(isNew ? { id: `src-${Date.now().toString(36)}`, enabled: true, hasHeaders: false, baselineOnly: true } : {}),
            name: draft.name.trim(),
            url: draft.url.trim(),
            selector: draft.selector.trim(),
            includeKeywords: draft.include
              .split(/[,，\n]/u)
              .map((word) => word.trim())
              .filter(Boolean),
            excludeKeywords: draft.exclude
              .split(/[,，\n]/u)
              .map((word) => word.trim())
              .filter(Boolean),
            intervalMinutes: draft.interval.trim() === '' ? null : Number(draft.interval),
          }
          // 新增时追加，编辑时替换——原来只做 map，新增会静默丢弃。
          const sources = isNew
            ? [...config.sources, record]
            : config.sources.map((entry) => (entry.id === source.id ? { ...entry, ...record } : entry))
          await postJson(`${API}/config`, { config: { ...config, sources } })
          onSaved()
        } catch (cause) {
          setErrors({ submit: String(cause?.message ?? cause) })
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'ir-modal', role: 'dialog', 'aria-modal': 'true' },
        h(
          'div',
          { className: 'ir-dialog' },
          h('h3', { className: 'ir-title' }, isNew ? '添加网址' : '编辑网址'),
          h('div', { className: 'ir-field' },
            h('span', { className: 'ir-label' }, '名称（可不填）'),
            h('input', { className: 'ir-input', value: draft.name, placeholder: '留空则用域名', onChange: (e) => setDraft({ ...draft, name: e.currentTarget.value }) })),
          h('div', { className: 'ir-field' },
            h('span', { className: 'ir-label' }, '网址（必填）'),
            h('input', { className: 'ir-input', value: draft.url, placeholder: 'https://example.com/news', onChange: (e) => setDraft({ ...draft, url: e.currentTarget.value }) }),
            errors.url !== undefined ? h('span', { className: 'ir-status', 'data-tone': 'err' }, errors.url) : null),
          h('div', { className: 'ir-field' },
            h('span', { className: 'ir-label' }, '正文选择器（可不填）'),
            h('input', { className: 'ir-input', value: draft.selector, placeholder: '#list 或 .article 或 article', onChange: (e) => setDraft({ ...draft, selector: e.currentTarget.value }) }),
            h('span', { className: 'ir-hint' }, '不用懂代码也能填：在网页上右键 →「检查」，看你想抓的那块区域最外层标签写着什么，把它的 id（#xxx）或 class（.xxx）抄过来。留空就让插件自己找正文。'),
            errors.selector !== undefined ? h('span', { className: 'ir-status', 'data-tone': 'err' }, errors.selector) : null),
          h('div', { className: 'ir-field' },
            h('span', { className: 'ir-label' }, '关注关键词（逗号分隔，留空表示全要）'),
            h('input', { className: 'ir-input', value: draft.include, placeholder: 'AI, 芯片', onChange: (e) => setDraft({ ...draft, include: e.currentTarget.value }) })),
          h('div', { className: 'ir-field' },
            h('span', { className: 'ir-label' }, '排除关键词（逗号分隔）'),
            h('input', { className: 'ir-input', value: draft.exclude, placeholder: '广告, 招聘', onChange: (e) => setDraft({ ...draft, exclude: e.currentTarget.value }) })),
          h('div', { className: 'ir-field' },
            h('span', { className: 'ir-label' }, '这个源单独的抓取间隔（可不填，跟随全局）'),
            h(DurationInput, {
              value: draft.interval === '' ? 0 : Number(draft.interval),
              onChange: (total) => setDraft({ ...draft, interval: total === 0 || total === null ? '' : String(total) }),
            }),
            h('span', { className: 'ir-hint' }, '三项都留空 = 跟随全局间隔。填了就以这里为准，最短 1 分钟。'),
            errors.interval !== undefined ? h('span', { className: 'ir-status', 'data-tone': 'err' }, errors.interval) : null),
          errors.submit !== undefined ? h('div', { className: 'ir-status', 'data-tone': 'err' }, errors.submit) : null,
          h('div', { className: 'ir-actions' },
            h('button', { type: 'button', className: 'ir-btn', 'data-kind': 'primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
            h('button', { type: 'button', className: 'ir-btn', onClick: onCancel }, '取消')),
        ),
      )
    }

    function CookieDialog({ source, onCancel, onSaved }) {
      const [cookie, setCookie] = React.useState('')
      const [userAgent, setUserAgent] = React.useState('')
      const [referer, setReferer] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      const submit = async () => {
        setError('')
        if (cookie.trim() === '') {
          setError('请粘贴 Cookie')
          return
        }
        setBusy(true)
        try {
          await postJson(`${API}/cookie`, { sourceId: source.id, cookie, userAgent, referer })
          onSaved()
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'ir-modal', role: 'dialog', 'aria-modal': 'true' },
        h(
          'div',
          { className: 'ir-dialog' },
          h('h3', { className: 'ir-title' }, `填写 Cookie · ${source.name}`),
          h('p', { className: 'ir-hint' }, '在浏览器里登录该站点，按 F12 → Network → 任意请求 → Request Headers → 复制 Cookie 整行粘贴到这里。保存后只在本机文件里，面板不再显示原值。'),
          h('div', { className: 'ir-field' },
            h('span', { className: 'ir-label' }, 'Cookie'),
            h('textarea', { className: 'ir-textarea', value: cookie, placeholder: 'SESSDATA=...; bili_jct=...;', onChange: (e) => setCookie(e.currentTarget.value) })),
          h('div', { className: 'ir-field' },
            h('span', { className: 'ir-label' }, 'User-Agent（可留空）'),
            h('input', { className: 'ir-input', value: userAgent, placeholder: '留空则用默认值', onChange: (e) => setUserAgent(e.currentTarget.value) })),
          h('div', { className: 'ir-field' },
            h('span', { className: 'ir-label' }, 'Referer（可留空）'),
            h('input', { className: 'ir-input', value: referer, placeholder: 'https://example.com/', onChange: (e) => setReferer(e.currentTarget.value) })),
          error !== '' ? h('div', { className: 'ir-status', 'data-tone': 'err' }, error) : null,
          h('div', { className: 'ir-actions' },
            h('button', { type: 'button', className: 'ir-btn', 'data-kind': 'primary', disabled: busy, onClick: submit }, busy ? '保存中…' : '确认'),
            h('button', { type: 'button', className: 'ir-btn', onClick: onCancel }, '取消')),
        ),
      )
    }

    // ── 时长输入：天 / 小时 / 分钟 三段 ─────────────────────────
    /**
     * 把总分钟数拆成 {days, hours, minutes}。
     * 用户不需要自己算分钟：填「2 天 3 小时」就是 3060 分钟。
     */
    function splitDuration(totalMinutes) {
      const total = Math.max(0, Math.round(Number(totalMinutes) || 0))
      return {
        days: Math.floor(total / 1440),
        hours: Math.floor((total % 1440) / 60),
        minutes: total % 60,
      }
    }

    /** 三段合并回分钟；非法返回 null。 */
    function joinDuration(parts) {
      const days = Number(parts.days)
      const hours = Number(parts.hours)
      const minutes = Number(parts.minutes)
      if (![days, hours, minutes].every((value) => Number.isFinite(value) && value >= 0)) return null
      return days * 1440 + hours * 60 + minutes
    }

    /**
     * 天/小时/分钟输入。三个框都可以直接敲数字，也支持上下方向键增减。
     * placeholder 明示单位，空表示 0。
     */
    function DurationInput({ value, onChange }) {
      const parts = splitDuration(value)
      const [draft, setDraft] = React.useState({
        days: parts.days === 0 ? '' : String(parts.days),
        hours: parts.hours === 0 ? '' : String(parts.hours),
        minutes: parts.minutes === 0 ? '' : String(parts.minutes),
      })

      // 只在「外部值与本地的三段合并不一致」时才回填，
      // 否则用户每敲一个数字都会触发上方重渲染，把输入框重置回旧值（表现为「改了没用」）。
      React.useEffect(() => {
        const localTotal = joinDuration({
          days: draft.days === '' ? 0 : draft.days,
          hours: draft.hours === '' ? 0 : draft.hours,
          minutes: draft.minutes === '' ? 0 : draft.minutes,
        })
        if (localTotal === Number(value)) return
        const next = splitDuration(value)
        setDraft({
          days: next.days === 0 ? '' : String(next.days),
          hours: next.hours === 0 ? '' : String(next.hours),
          minutes: next.minutes === 0 ? '' : String(next.minutes),
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [value])

      const commit = (next) => {
        setDraft(next)
        const total = joinDuration({
          days: next.days === '' ? 0 : next.days,
          hours: next.hours === '' ? 0 : next.hours,
          minutes: next.minutes === '' ? 0 : next.minutes,
        })
        onChange(total)
      }

      const field = (key, label, max) =>
        h(
          'label',
          { className: 'ir-duration-cell' },
          h('input', {
            className: 'ir-input ir-duration-input',
            type: 'number',
            min: 0,
            max,
            step: 1,
            inputMode: 'numeric',
            value: draft[key],
            placeholder: '0',
            onChange: (event) => {
              const raw = event.currentTarget.value
              // 只允许非负整数
              if (raw !== '' && !/^\d{1,6}$/u.test(raw)) return
              commit({ ...draft, [key]: raw })
            },
            onKeyDown: (event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
              event.preventDefault()
              const current = Number(draft[key] === '' ? 0 : draft[key])
              const delta = event.key === 'ArrowUp' ? 1 : -1
              const next = Math.min(max, Math.max(0, current + delta))
              commit({ ...draft, [key]: next === 0 ? '' : String(next) })
            },
          }),
          h('span', { className: 'ir-duration-unit' }, label),
        )

      return h(
        'div',
        { className: 'ir-duration' },
        field('days', '天', 365),
        field('hours', '小时', 23),
        field('minutes', '分钟', 59),
      )
    }

    /** 会话建议的稳定键：同 kind + 同路由视为同一条。 */
    function suggestionKey(suggestion) {
      return `${suggestion?.kind ?? ''}:${JSON.stringify(suggestion?.route ?? {})}`
    }

    /**
     * DSH-IM 联动面板。
     *
     * 三种状态各有各的说明，因为用户要做的动作完全不同：
     * - 没装 dsh-im     → 给出安装命令
     * - 装了但没接机器人 → 让他去「设置 → IM机器人」接一个
     * - 接好了         → 选机器人 + 选目标或会话 + 测试
     *
     * 目标下拉分两组：已保存的目标，以及 dsh-im 记录的「聊过的会话」。
     * 后者保存设置时会自动登记成目标，用户不用先去别处手动建。
     */
    function DshImPanel({ info, botId, targetId, draft, busy, onBotChange, onTargetChange, onDraftChange, onRecheck, onTest }) {
      const bots = info?.bots ?? []
      const currentBot = bots.find((bot) => bot.botId === botId)
      const targets = currentBot?.targets ?? []
      const suggestions = currentBot?.suggestions ?? []
      const draftKey = draft === null || draft === undefined ? '' : suggestionKey(draft)
      const selection = targetId !== '' ? `t:${targetId}` : (draftKey === '' ? '' : `s:${draftKey}`)

      const pick = (value) => {
        if (value.startsWith('t:')) {
          onTargetChange(value.slice(2))
          onDraftChange(null)
          return
        }
        if (value.startsWith('s:')) {
          const key = value.slice(2)
          const picked = suggestions.find((entry) => suggestionKey(entry) === key) ?? null
          onTargetChange('')
          onDraftChange(picked === null ? null : { kind: picked.kind, route: picked.route, label: picked.label })
          return
        }
        onTargetChange('')
        onDraftChange(null)
      }

      const head = h('div', { className: 'ir-card2title' }, 'DSH-IM 联动')

      if (info === null) {
        return h('div', { className: 'ir-card2' }, head, h('p', { className: 'ir-hint' }, '正在检测…'))
      }

      if (info.available !== true) {
        return h(
          'div',
          { className: 'ir-card2' },
          head,
          h('p', { className: 'ir-hint' }, '本机没有检测到 @xmanrui/dsh-im。信息雷达不打包 IM 机器人，需要你先装一个。'),
          h('p', { className: 'ir-hint' }, `检测结果：${info.error ?? '未安装'}`),
          h('p', { className: 'ir-hint' }, '在 DSH 内置终端执行下面这行，然后重启 DSH：'),
          h('pre', { className: 'ir-cmd' }, 'dsh plugin --profile desktop add -w @xmanrui/dsh-im'),
          h('div', { className: 'ir-actions' },
            h('button', { type: 'button', className: 'ir-btn', onClick: onRecheck }, '重新检测')),
        )
      }

      if (bots.length === 0) {
        return h(
          'div',
          { className: 'ir-card2' },
          head,
          h('p', { className: 'ir-hint' }, 'DSH-IM 已安装，但还没有接入任何机器人。'),
          h('p', { className: 'ir-hint' }, '请先到「设置 → IM机器人」扫码或填凭据接一个，再回来点「重新检测」。'),
          h('div', { className: 'ir-actions' },
            h('button', { type: 'button', className: 'ir-btn', onClick: onRecheck }, '重新检测')),
        )
      }

      return h(
        'div',
        { className: 'ir-card2' },
        head,
        h('p', { className: 'ir-hint' },
          `DSH-IM 已安装（${info.via === 'service' ? '同进程服务' : 'HTTP 接口'}），已接入 ${bots.length} 个机器人。`),
        h(
          'div',
          { className: 'ir-field' },
          h('span', { className: 'ir-label' }, '选择机器人'),
          h(
            'select',
            {
              className: 'ir-select',
              value: botId,
              onChange: (event) => {
                onBotChange(event.currentTarget.value)
                onTargetChange('')
                onDraftChange(null)
              },
            },
            h('option', { value: '' }, '请选择'),
            bots.map((bot) =>
              h(
                'option',
                { key: bot.botId, value: bot.botId },
                `${bot.channel === '' ? '未知渠道' : bot.channel} · ${String(bot.botId).slice(0, 16)}`,
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'ir-field' },
          h('span', { className: 'ir-label' }, '投递目标'),
          h(
            'select',
            {
              className: 'ir-select',
              value: selection,
              onChange: (event) => pick(event.currentTarget.value),
              disabled: botId === '',
            },
            h(
              'option',
              { value: '' },
              botId === ''
                ? '先选机器人'
                : (targets.length + suggestions.length === 0 ? '还没有可用会话' : '请选择'),
            ),
            targets.length > 0
              ? h('optgroup', { label: '已保存的目标' }, targets.map((target) =>
                  h(
                    'option',
                    { key: target.targetId, value: `t:${target.targetId}` },
                    `${target.name ?? target.targetId}（${target.kind ?? '目标'}）`,
                  )))
              : null,
            suggestions.length > 0
              ? h('optgroup', { label: '聊过的会话（保存时自动创建目标）' }, suggestions.map((entry) =>
                  h(
                    'option',
                    { key: suggestionKey(entry), value: `s:${suggestionKey(entry)}` },
                    entry.label ?? `${entry.kind}（未保存）`,
                  )))
              : null,
          ),
        ),
        botId !== '' && targets.length === 0 && suggestions.length === 0
          ? h('p', { className: 'ir-hint' },
              '这个机器人还没跟任何人聊过，所以没有可投递的会话。先在 QQ / 微信里给它随便发一条消息，再回来点「重新检测」，这上面就会自动列出来。')
          : null,
        selection.startsWith('s:')
          ? h('p', { className: 'ir-hint' },
              '当前选的是「聊过的会话」。点「保存设置」时会在 DSH-IM 里自动建一个名为「信息雷达」的投递目标，以后就不用再选。')
          : null,
        h(
          'div',
          { className: 'ir-actions', style: { marginTop: '8px' } },
          h('button', { type: 'button', className: 'ir-btn', disabled: busy, onClick: onTest }, '发送测试消息'),
          h('button', { type: 'button', className: 'ir-btn', 'data-kind': 'ghost', onClick: onRecheck }, '重新检测'),
        ),
      )
    }

    function SettingsPanel({ config, onSaved }) {
      const [interval, setInterval] = React.useState(String(config.globalIntervalMinutes))
      const [anchor, setAnchor] = React.useState(config.anchor)
      // 推送整体是可选开关；勾选后走已装的 DSH-IM 机器人
      const [notifyEnabled, setNotifyEnabled] = React.useState(config.notify.enabled === true)
      const [dshImBotId, setDshImBotId] = React.useState(config.notify.dshImBotId ?? '')
      const [dshImTargetId, setDshImTargetId] = React.useState(config.notify.dshImTargetId ?? '')
      // 未保存的会话：`{kind, route, label}`，保存时会被登记成真正的目标
      const [dshImDraft, setDshImDraft] = React.useState(config.notify.dshImDraft ?? null)
      const [pushHint, setPushHint] = React.useState(config.notify.pushHint ?? '')
      const [autoMarkRead, setAutoMarkRead] = React.useState(config.notify.autoMarkRead === true)
      const [imInfo, setImInfo] = React.useState(null)
      const [cleanupEnabled, setCleanupEnabled] = React.useState(config.cleanupReadEnabled === true)
      const [cleanupInterval, setCleanupInterval] = React.useState(String(config.cleanupReadIntervalMinutes ?? 10080))
      const [testMode, setTestMode] = React.useState(config.testMode === true)
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState(null)

      /** 探测本机 IM 联动能力；开启推送时自动跑一次。 */
      const checkIm = React.useCallback(async () => {
        setImInfo(null)
        try {
          const result = await apiJson(`${API}/im-status`)
          setImInfo(result)
        } catch (cause) {
          setImInfo({ available: false, bots: [], error: String(cause?.message ?? cause) })
        }
      }, [])

      React.useEffect(() => {
        if (notifyEnabled) checkIm()
      }, [notifyEnabled, checkIm])

      const testIm = async () => {
        setBusy(true)
        setStatus(null)
        try {
          const result = await postJson(`${API}/im-test`, {
            botId: dshImBotId,
            targetId: dshImTargetId,
            draft: dshImDraft,
          })
          setStatus(
            result.ok
              ? { tone: 'ok', text: '测试消息已发出' }
              : { tone: 'err', text: result.error ?? '发送失败' },
          )
        } catch (cause) {
          setStatus({ tone: 'err', text: String(cause?.message ?? cause) })
        } finally {
          setBusy(false)
        }
      }

      /**
       * 保存设置。
       *
       * 如果选的是「聊过的会话」而不是已保存目标，先把这条会话登记成
       * dsh-im 目标（`/im-target`），拿到 targetId 再存；登记失败就退回
       * 保存临时路由，推送照样能发。
       */
      const saveConfig = async () => {
        setBusy(true)
        setStatus(null)
        let targetIdToSave = dshImTargetId
        let draftToSave = dshImDraft
        let note = ''
        try {
          if (notifyEnabled && dshImBotId !== '' && targetIdToSave === '' && draftToSave !== null) {
            try {
              const created = await postJson(`${API}/im-target`, {
                botId: dshImBotId,
                draft: draftToSave,
              })
              if (created.ok && created.targetId !== '') {
                targetIdToSave = created.targetId
                draftToSave = null
              } else {
                note = `（目标没建成，先按临时会话推送：${created.error ?? '未知原因'}）`
              }
            } catch (cause) {
              note = `（目标没建成，先按临时会话推送：${String(cause?.message ?? cause)}）`
            }
          }
          await postJson(`${API}/config`, {
            config: {
              ...config,
              globalIntervalMinutes: Number(interval) || 1440,
              anchor,
              testMode,
              cleanupReadEnabled: cleanupEnabled,
              cleanupReadIntervalMinutes: Number(cleanupInterval) || 10080,
              notify: {
                enabled: notifyEnabled,
                dshImBotId,
                dshImTargetId: targetIdToSave,
                dshImDraft: draftToSave,
                pushHint,
                autoMarkRead,
              },
            },
          })
          setDshImTargetId(targetIdToSave)
          setDshImDraft(draftToSave)
          setStatus({ tone: 'ok', text: `已保存${note}` })
          onSaved()
          if (notifyEnabled) checkIm()
        } catch (cause) {
          setStatus({ tone: 'err', text: String(cause?.message ?? cause) })
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        null,
        h('h3', { className: 'ir-title', style: { marginBottom: '10px' } }, '设置'),
        h('div', { className: 'ir-field' },
          h('span', { className: 'ir-label' }, '全局抓取间隔'),
          h(DurationInput, {
            value: Number(interval) || 0,
            onChange: (total) => setInterval(String(total === null ? 0 : total)),
          }),
          h('span', { className: 'ir-hint' }, `当前 = ${formatInterval(Number(interval))}。最短 1 分钟，最长 365 天；三项都留空表示不抓。单个源可以单独覆盖。`)),
        h('div', { className: 'ir-field' },
          h('span', { className: 'ir-label' }, '计次起点（从这个时间开始按间隔分期）'),
          h('input', { className: 'ir-input', value: anchor, onChange: (e) => setAnchor(e.currentTarget.value) }),
          h('span', { className: 'ir-hint' }, 'ISO 时间格式，例如 2026-10-26T20:00:00+08:00。改这里会让所有源的期号重算。')),
        h('div', { className: 'ir-sep' }),
        h('h3', { className: 'ir-title', style: { marginBottom: '10px' } }, '推送通知（可选）'),
        h('label', { className: 'ir-actions', style: { marginBottom: '10px' } },
          h('input', {
            type: 'checkbox',
            checked: notifyEnabled,
            onChange: (e) => setNotifyEnabled(e.currentTarget.checked),
          }),
          h('span', { className: 'ir-label' }, '有新内容时推送到 IM 机器人')),
        h('p', { className: 'ir-hint', style: { marginBottom: '10px' } },
          '不勾选就只在面板里看，不往任何通讯软件发消息。勾选后通过你已装的 DSH-IM 机器人投递（微信 / QQ / 飞书 / 钉钉都行）。'),

        notifyEnabled
          ? h(React.Fragment, null,
              h(DshImPanel, {
                info: imInfo,
                botId: dshImBotId,
                targetId: dshImTargetId,
                draft: dshImDraft,
                busy,
                onBotChange: setDshImBotId,
                onTargetChange: setDshImTargetId,
                onDraftChange: setDshImDraft,
                onRecheck: checkIm,
                onTest: testIm,
              }),
              h('div', { className: 'ir-field', style: { marginTop: '12px' } },
                h('span', { className: 'ir-label' }, '推送末尾的引导语'),
                h('input', {
                  className: 'ir-input',
                  value: pushHint,
                  placeholder: '留空则不加这句',
                  onChange: (e) => setPushHint(e.currentTarget.value),
                }),
                h('span', { className: 'ir-hint' },
                  '每次推送最后都会附上这句话，你在手机上直接回一句「看不懂」就能接着问。留空则不追加。')),
              h('label', { className: 'ir-actions', style: { marginTop: '10px' } },
                h('input', {
                  type: 'checkbox',
                  checked: autoMarkRead,
                  onChange: (e) => setAutoMarkRead(e.currentTarget.checked),
                }),
                h('span', { className: 'ir-label' }, '推送出去的条目自动标记为已读')),
              h('p', { className: 'ir-hint' },
                '不勾选：推到 IM 的内容在面板里仍然算未读、照样显示红点，等你自己点开。' +
                '勾选：推送成功的同时把这些标成已读，面板里不再红点（原文链接和正文快照都还在，随时能翻回去看）。'),
            )
          : null,
        h('div', { className: 'ir-sep' }),
        h('h3', { className: 'ir-title', style: { marginBottom: '10px' } }, '测试期模式'),
        h('label', { className: 'ir-actions', style: { marginBottom: '6px' } },
          h('input', { type: 'checkbox', checked: testMode, onChange: (e) => setTestMode(e.currentTarget.checked) }),
          h('span', { className: 'ir-label' }, '跳过基线，直接抓当前页面上已有的内容')),
        h('p', { className: 'ir-hint' },
          '平时不要勾选：第一次抓取只记下网页原有内容、不显示，之后只有真正的新内容才出现在列表里。' +
          '勾选后会忽略这个规则，把页面上现有的最新内容直接抓进来，方便你立刻看到效果。测试完记得取消勾选。'),
        h('div', { className: 'ir-sep' }),
        h('h3', { className: 'ir-title', style: { marginBottom: '10px' } }, '已读内容的定期清理'),
        h('label', { className: 'ir-actions', style: { marginBottom: '10px' } },
          h('input', { type: 'checkbox', checked: cleanupEnabled, onChange: (e) => setCleanupEnabled(e.currentTarget.checked) }),
          h('span', { className: 'ir-label' }, '自动删除已读内容')),
        h('div', { className: 'ir-field' },
          h('span', { className: 'ir-label' }, '清理间隔'),
          h(DurationInput, {
            value: Number(cleanupInterval) || 0,
            onChange: (total) => setCleanupInterval(String(total === null ? 0 : total)),
          }),
          h('span', { className: 'ir-hint' }, '只删除你点开过（已读）的内容，未读的永远保留。最短 1 分钟，默认 7 天。不勾选上面的开关时，这里的数字只是保存下来备用。')),
        h('div', { className: 'ir-actions' },
          h('button', { type: 'button', className: 'ir-btn', 'data-kind': 'primary', disabled: busy, onClick: saveConfig }, busy ? '保存中…' : '保存设置'),
          status !== null ? h('span', { className: 'ir-status', 'data-tone': status.tone }, status.text) : null),
      )
    }

    /**
     * 子网页列表：默认收起，点箭头展开。
     *
     * 用户明确要求：子网页的内容不要直接铺在列表里，要点开下箭头才看到。
     * 这里递归渲染——子网页里如果还有下一层，也会以同样的折叠形式出现。
     */
    function ChildList({ item }) {
      const [open, setOpen] = React.useState(false)
      const [opened, setOpened] = React.useState({})
      const children = Array.isArray(item.children) ? item.children : []
      if (children.length === 0) return null

      return h(
        'div',
        { className: 'ir-children' },
        h(
          'button',
          {
            type: 'button',
            className: 'ir-childtoggle',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => setOpen((value) => !value),
          },
          h('span', { className: 'ir-caret' }, open ? '▾' : '▸'),
          h('span', null, `子网页内容（${children.length}）`),
        ),
        open
          ? h(
              'div',
              { className: 'ir-childlist' },
              children.map((child, index) => {
                const key = child.url ?? String(index)
                const isOpen = opened[key] === true
                const hasGrandChildren = Array.isArray(child.children) && child.children.length > 0
                return h(
                  'div',
                  { key, className: 'ir-child' },
                  h(
                    'div',
                    { className: 'ir-childhead' },
                    hasGrandChildren
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'ir-childtoggle',
                            'aria-expanded': isOpen ? 'true' : 'false',
                            onClick: () => setOpened({ ...opened, [key]: !isOpen }),
                          },
                          h('span', { className: 'ir-caret' }, isOpen ? '▾' : '▸'),
                          h('span', null, child.title),
                        )
                      : h('span', { className: 'ir-childtitle' }, child.title),
                    child.attachmentOnly === true
                      ? h('span', { className: 'ir-tag' }, child.attachmentNote || '附件')
                      : null,
                  ),
                  // 附件型只说明是什么表，不铺正文
                  child.attachmentOnly === true
                    ? h('p', { className: 'ir-summary ir-attach' }, `${child.attachmentNote || '内涵附件'}，没有可读的正文内容。`)
                    : h(
                        'p',
                        { className: 'ir-summary' },
                        isOpen || !hasGrandChildren
                          ? String(child.text ?? child.summary ?? '').slice(0, 600) || '（这一层没有正文）'
                          : String(child.text ?? '').slice(0, 160),
                      ),
                  h(
                    'a',
                    { className: 'ir-link', href: child.url, target: '_blank', rel: 'noreferrer noopener' },
                    child.url,
                  ),
                  // 孙辈沿用同一个组件递归
                  hasGrandChildren ? h(ChildList, { item: child }) : null,
                )
              }),
            )
          : null,
      )
    }

    function RadarPage() {
      const state = useStatus()
      const [tab, setTab] = React.useState('items')
      const [activeSource, setActiveSource] = React.useState(null)
      const [editing, setEditing] = React.useState(null)
      const [cookieFor, setCookieFor] = React.useState(null)
      const [adding, setAdding] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(null)

      const status = state.status
      const items = status?.items ?? []
      const sources = status?.sources ?? []
      const [summarizing, setSummarizing] = React.useState('')
      const [summarizingAll, setSummarizingAll] = React.useState(false)

      React.useEffect(() => {
        refresh()
      }, [])

      const act = async (label, fn) => {
        setBusy(label)
        setMessage(null)
        try {
          const result = await fn()
          setMessage({ tone: 'ok', text: typeof result === 'string' ? result : '完成' })
          await refresh()
        } catch (cause) {
          setMessage({ tone: 'err', text: String(cause?.message ?? cause) })
        } finally {
          setBusy('')
        }
      }

      /** 点开原文时把这一条标记为已读；失败不打扰用户，下次刷新会纠正。 */
      const markRead = (id) => {
        postJson(`${API}/read`, { id })
          .then(() => refresh())
          .catch((error) => console.error('[info-radar] 标记已读失败:', error))
      }

      /** 单条 AI 总结。用户点过总结就算已读，所以成功后一起标记。 */
      const summarizeOne = async (item) => {
        setSummarizing(item.id)
        setMessage(null)
        try {
          const result = await postJson(`${API}/summarize`, { id: item.id })
          if (typeof result.summary === 'string' && result.summary !== '') {
            setMessage({ tone: 'ok', text: '已生成摘要' })
            // 总结即已读
            await postJson(`${API}/read`, { id: item.id }).catch(() => {})
          } else {
            setMessage({ tone: 'err', text: result.error ?? '模型没有返回摘要' })
          }
          await refresh()
        } catch (cause) {
          setMessage({ tone: 'err', text: String(cause?.message ?? cause) })
        } finally {
          setSummarizing('')
        }
      }

      /** 总结全部：把所有未读且未总结的内容一次性补摘要。 */
      const summarizeAll = async () => {
        setSummarizingAll(true)
        setMessage(null)
        try {
          const result = await postJson(`${API}/summarize-all`, {})
          if (result.total === 0) {
            setMessage({ tone: 'ok', text: result.message ?? '没有需要总结的未读内容' })
          } else {
            const tail = result.failed > 0 ? `，${result.failed} 条失败` : ''
            setMessage({
              tone: result.succeeded > 0 ? 'ok' : 'err',
              text: `总结完成：成功 ${result.succeeded} 条${tail}`,
            })
            if (Array.isArray(result.errors) && result.errors.length > 0) {
              console.warn('[info-radar] 总结失败详情:', result.errors)
            }
          }
          await refresh()
        } catch (cause) {
          setMessage({ tone: 'err', text: String(cause?.message ?? cause) })
        } finally {
          setSummarizingAll(false)
        }
      }

      const filtered = activeSource === null ? items : items.filter((item) => item.sourceId === activeSource)
      /**
       * 从新到旧。
       *
       * 排序键优先级：
       * 1) publishedAt（页面上的发布时间，已统一成 YYYY-MM-DD[ HH:mm] 便于字符串比较）
       * 2) foundAt（没抓到发布时间时，用发现时间兜底）
       * 3) seq 倒序（最后手段）
       * 之前只看 publishedAt，而很多站点没抓到日期时它是空串，
       * 结果退化成按 seq 排——seq 是抓取顺序，不是时间顺序，看起来就「没倒序」。
       */
      const sortKeyOf = (item) => {
        const published = typeof item.publishedAt === 'string' ? item.publishedAt.trim() : ''
        if (published !== '') return `0:${published}`
        const found = typeof item.foundAt === 'string' ? item.foundAt : ''
        return `1:${found}`
      }
      const sorted = [...filtered].sort((a, b) => {
        const ka = sortKeyOf(a)
        const kb = sortKeyOf(b)
        if (ka !== kb) return ka < kb ? 1 : -1
        return Number(b.seq) - Number(a.seq)
      })

      const needsCookieSources = sources.filter((source) => source.status === 'needs-cookie')

      return h(
        'div',
        { className: 'ir-page' },
        h(
          'div',
          { className: 'ir-head' },
          h('h2', { className: 'ir-title' }, '信息雷达'),
          h(
            'span',
            { className: 'ir-stats' },
            `${sources.length} 个源 · ${Number(status?.unread) || 0} 条未读` +
              (needsCookieSources.length > 0 ? ` · ${needsCookieSources.length} 个待登录` : ''),
          ),
          h('span', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            className: 'ir-btn',
            'data-kind': tab === 'items' ? 'primary' : 'ghost',
            onClick: () => setTab('items'),
          }, '内容'),
          h('button', {
            type: 'button',
            className: 'ir-btn',
            'data-kind': tab === 'settings' ? 'primary' : 'ghost',
            onClick: () => setTab('settings'),
          }, '设置'),
          h('button', {
            type: 'button',
            className: 'ir-btn',
            disabled: busy !== '' || status?.running === true,
            onClick: () => act('run', () => postJson(`${API}/run`, {})),
          }, status?.running === true ? '抓取中…' : '立即抓取'),
          h('button', {
            type: 'button',
            className: 'ir-btn',
            disabled: busy !== '' || summarizingAll === true,
            title: '把所有「未读且还没总结」的内容一次性补上摘要',
            onClick: () => summarizeAll(),
          }, summarizingAll === true ? '总结中…' : '总结全部未读'),
          (status?.config?.notify?.enabled === true)
            ? h('button', {
                type: 'button',
                className: 'ir-btn',
                disabled: busy !== '' || (Number(status?.pendingPush) || 0) === 0,
                title: '把还没推送到 IM 的未读内容立刻发出去；发过的会自动跳过',
                onClick: () => act('push', async () => {
                  const result = await postJson(`${API}/push`, {})
                  if (result.ok !== true) throw new Error(result.error ?? '推送失败')
                  if (result.pushed === 0) return '没有待推送的未读内容'
                  return `已推送 ${result.pushed} 条消息，共 ${result.items} 条内容`
                }),
              }, (Number(status?.pendingPush) || 0) > 0 ? `推送未读（${Number(status.pendingPush)}）` : '推送未读')
            : null,
          h('button', {
            type: 'button',
            className: 'ir-btn',
            disabled: (Number(status?.unread) || 0) === 0,
            onClick: () => act('read', () => postJson(`${API}/read`, {})),
          }, '全部标记已读'),
        ),
        state.error !== '' ? h('div', { className: 'ir-status', 'data-tone': 'err', style: { padding: '8px 22px' } }, `读取出错：${state.error}`) : null,
        message !== null ? h('div', { className: 'ir-status', 'data-tone': message.tone, style: { padding: '6px 22px' } }, message.text) : null,
        tab === 'settings'
          ? h('div', { className: 'ir-main', style: { maxWidth: '720px' } },
              status === null ? h('div', { className: 'ir-empty' }, '读取中…') : h(SettingsPanel, { config: status.config, onSaved: refresh }))
          : h(
              'div',
              { className: 'ir-body' },
              h(
                'div',
                { className: 'ir-side' },
                h('div', { className: 'ir-actions', style: { marginBottom: '8px' } },
                  h('button', { type: 'button', className: 'ir-btn', onClick: () => { setEditing(null); setAdding(true) } }, '+ 添加网址')),
                h(
                  'div',
                  {
                    className: 'ir-row',
                    'data-active': activeSource === null ? '' : undefined,
                    onClick: () => setActiveSource(null),
                  },
                  h('div', { className: 'ir-rowhead' }, h('span', { className: 'ir-rowname' }, '全部内容')),
                  h('div', { className: 'ir-meta' }, `${items.length} 条`),
                ),
                sources.map((source) =>
                  h(
                    'div',
                    {
                      key: source.id,
                      className: 'ir-row',
                      'data-active': activeSource === source.id ? '' : undefined,
                      onClick: () => setActiveSource(source.id),
                    },
                    h(
                      'div',
                      { className: 'ir-rowhead' },
                      h('span', { className: 'ir-dot', 'data-s': source.status }),
                      h('span', { className: 'ir-rowname' }, source.name),
                      // 这个源还有多少条未读：和侧栏图标上的红点同一套样式
                      source.unreadCount > 0
                        ? h('span', { className: 'ir-rowbadge' }, source.unreadCount > 99 ? '99+' : String(source.unreadCount))
                        : null,
                      source.hasCookie ? h('span', { className: 'ir-tag' }, 'Cookie') : null,
                    ),
                    h(
                      'div',
                      { className: 'ir-meta' },
                      source.status === 'needs-cookie'
                        ? '需要重新登录'
                        : `每 ${formatInterval(source.intervalMinutes)} · 上次 ${formatTime(source.lastRunAt)}`,
                    ),
                  ),
                ),
                sources.length === 0 ? h('div', { className: 'ir-empty' }, '还没有添加网址') : null,
              ),
              h(
                'div',
                { className: 'ir-main' },
                activeSource !== null
                  ? (() => {
                      const source = sources.find((entry) => entry.id === activeSource)
                      if (source === undefined) return null
                      return h(
                        'div',
                        { style: { marginBottom: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
                        h('span', { className: 'ir-itemtitle' }, source.name),
                        h('span', { className: 'ir-meta', style: { flex: 1 } }, source.url),
                        h('button', {
                          type: 'button',
                          className: 'ir-btn',
                          disabled: busy !== '',
                          onClick: () => act('run-one', () => postJson(`${API}/run`, { sourceId: source.id })),
                        }, '立即抓取'),
                        h('button', { type: 'button', className: 'ir-btn', onClick: () => setCookieFor(source) }, source.hasCookie ? '更新 Cookie' : '填写 Cookie'),
                        h('button', { type: 'button', className: 'ir-btn', onClick: () => setEditing(source) }, '编辑'),
                        source.status === 'needs-cookie'
                          ? h('button', {
                              type: 'button',
                              className: 'ir-btn',
                              onClick: () => act('ignore', () => postJson(`${API}/source-action`, { sourceId: source.id, action: 'ignore' })),
                            }, '忽略这个网址')
                          : null,
                        source.status === 'paused'
                          ? h('button', {
                              type: 'button',
                              className: 'ir-btn',
                              onClick: () => act('resume', () => postJson(`${API}/source-action`, { sourceId: source.id, action: 'resume' })),
                            }, '恢复抓取')
                          : null,
                        source.lastError !== null
                          ? h('span', { className: 'ir-status', 'data-tone': 'err' }, source.lastError)
                          : null,
                      )
                    })()
                  : null,
                sorted.length === 0
                  ? h(
                      'div',
                      { className: 'ir-empty' },
                      h('div', null, sources.length === 0 ? '还没有添加网址' : '这个源还没有内容'),
                      sources.length === 0
                        ? h('button', { type: 'button', className: 'ir-btn', 'data-kind': 'primary', onClick: () => { setEditing(null); setAdding(true) } }, '添加第一个网址')
                        : null,
                    )
                  : sorted.map((item) => {
                      const isRead = item.read === true
                      const openDetail = (event) => {
                        if (isRead) return
                        // 点开即已读：先本地标记，再异步落盘，不阻塞跳转
                        markRead(item.id)
                      }
                      return h(
                        'div',
                        {
                          key: item.id,
                          className: 'ir-item',
                          'data-unread': isRead ? undefined : '',
                          'data-read': isRead ? '' : undefined,
                        },
                        h(
                          'div',
                          { className: 'ir-itemhead' },
                          h('h4', { className: 'ir-itemtitle' }, item.title),
                          h('span', { className: 'ir-tag' }, item.sourceName),
                          isRead ? h('span', { className: 'ir-tag' }, '已读') : null,
                          item.baseline === true ? h('span', { className: 'ir-tag' }, '基线') : null,
                          item.summarized === false && item.baseline !== true && item.attachmentOnly !== true
                            ? h('span', { className: 'ir-tag', 'data-tone': 'warn' }, '未总结')
                            : null,
                          item.attachmentOnly === true ? h('span', { className: 'ir-tag' }, item.attachmentNote || '附件') : null,
                          item.publishedAt ? h('span', { className: 'ir-meta' }, item.publishedAt) : null,
                          h('span', { className: 'ir-meta' }, formatTime(item.foundAt)),
                        ),
                        // 附件型不显示正文，只说清楚是什么表
                        item.attachmentOnly === true
                          ? h('p', { className: 'ir-summary ir-attach' }, `${item.attachmentNote || '内涵附件'}，没有可读的正文内容。原文见下方链接。`)
                          : h('p', { className: 'ir-summary' }, item.summary || '（还没有摘要，点下方「AI 总结」生成）'),
                        h('div', { className: 'ir-itemfoot' },
                          h(
                            'a',
                            {
                              className: 'ir-link',
                              href: item.url,
                              target: '_blank',
                              rel: 'noreferrer noopener',
                              onClick: openDetail,
                            },
                            item.url,
                          ),
                          item.attachmentOnly === true
                            ? null
                            : h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'ir-btn',
                                  disabled: summarizing === item.id || item.baseline === true,
                                  onClick: () => summarizeOne(item),
                                  title: item.baseline === true ? '基线内容不总结' : '用模型生成这一条的摘要',
                                },
                                summarizing === item.id ? '总结中…' : item.summarized === true ? '重新总结' : 'AI 总结',
                              ),
                        ),
                        // 子网页内容默认收起，点箭头才展开
                        Array.isArray(item.children) && item.children.length > 0
                          ? h(ChildList, { item })
                          : null,
                      )
                    }),
              ),
            ),
        adding ? h(SourceEditor, {
          source: null,
          onCancel: () => setAdding(false),
          onSaved: async () => {
            setAdding(false)
            await refresh()
          },
        }) : null,
        editing !== null ? h(SourceEditor, {
          source: editing,
          onCancel: () => setEditing(null),
          onSaved: async () => {
            setEditing(null)
            await refresh()
          },
        }) : null,
        cookieFor !== null ? h(CookieDialog, {
          source: cookieFor,
          onCancel: () => setCookieFor(null),
          onSaved: async () => {
            setCookieFor(null)
            setMessage({ tone: 'ok', text: 'Cookie 已保存，正在重新抓取' })
            await refresh()
          },
        }) : null,
      )
    }

    /** 浮层卡片：掉登录态提示，不挡输入。 */
    function CookiePrompt() {
      const state = useStatus()
      const status = state.status
      const [dismissed, setDismissed] = React.useState(false)
      const [cookieFor, setCookieFor] = React.useState(null)
      const sources = (status?.sources ?? []).filter((source) => source.status === 'needs-cookie')

      React.useEffect(() => {
        // 新的待登录源出现时重新展开
        if (sources.length > 0) setDismissed(false)
      }, [sources.length])

      if (sources.length === 0 || dismissed) return null

      return h(
        'div',
        { className: 'ir-card', role: 'status' },
        h('div', { className: 'ir-cardtitle' },
          h('span', { className: 'ir-warn' }, '!'),
          h('span', null, `${sources.length} 个网址需要重新登录`)),
        sources.slice(0, 3).map((source) =>
          h(
            'div',
            { key: source.id, className: 'ir-cardrow' },
            h('div', { className: 'ir-cardrowname' }, source.name),
            h('div', { className: 'ir-cardrowmeta' }, source.lastError ?? '疑似登录态失效'),
            h('div', { className: 'ir-actions' },
              h('button', { type: 'button', className: 'ir-btn', 'data-kind': 'primary', onClick: () => setCookieFor(source) }, '填写 Cookie'),
              h('button', {
                type: 'button',
                className: 'ir-btn',
                'data-kind': 'ghost',
                onClick: async () => {
                  try {
                    await postJson(`${API}/source-action`, { sourceId: source.id, action: 'ignore' })
                    await refresh()
                  } catch (error) {
                    console.error('[info-radar] 忽略失败:', error)
                  }
                },
              }, '忽略这个网址')),
          ),
        ),
        h('div', { className: 'ir-actions' },
          h('button', { type: 'button', className: 'ir-btn', 'data-kind': 'ghost', onClick: () => setDismissed(true) }, '稍后处理')),
        cookieFor !== null ? h(CookieDialog, {
          source: cookieFor,
          onCancel: () => setCookieFor(null),
          onSaved: async () => {
            setCookieFor(null)
            await refresh()
          },
        }) : null,
      )
    }

    // ── 词典 ────────────────────────────────────────────────
    const zh = {
      'meta.title': '信息雷达',
      'meta.description': '按网址定时抓取内容，自动总结，标红未读，并把更新推送到 QQ。',
    }
    const en = {
      'meta.title': 'Info Radar',
      'meta.description': 'Scrapes watched pages on a schedule, summarizes new items, badges unread counts, and pushes updates to QQ.',
    }

    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`)
      if (existing !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-info-radar'
      tag.dataset.pluginCss = STYLE_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(installStyles, 'dsh-info-radar: styles')
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-info-radar: dictionaries')

        // 轮询：面板打开时 10 秒一次，供图标与面板共用
        ctx.effect(() => {
          refresh()
          timer = window.setInterval(refresh, 10000)
          return () => {
            if (timer !== null) window.clearInterval(timer)
            timer = null
          }
        }, 'dsh-info-radar: polling')

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, RadarPage),
        )

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => '信息雷达' },
            SidebarIcon,
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-info-radar-prompt', order: 80 }, CookiePrompt),
        )
      },
    }
  },
})


