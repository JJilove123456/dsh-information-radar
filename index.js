/**
 * dsh-info-radar · 宿主半
 *
 * 职责：
 * - 起 30 秒心跳，按锚点周期判断哪些源到期（关机跨期只补一次，靠内容键去重补内容）
 * - 抓取 → 关键词/选择器过滤 → 模型总结 → 入库 → 可选 QQ 推送
 * - 对外提供面板要用的 JSON 端点
 *
 * 数据落在 <DSH_HOME>/info-radar/，卸载插件不删。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Store, resolveDataDir, normalizeConfig, normalizeDraftTarget } from './lib/store.js'
import { RadarRunner, isItemRead } from './lib/runner.js'
import { detectDshIm, listDshImTargets, listDshImSuggestions, createDshImTarget, sendViaDshIm, readOwnerSuggestion } from './lib/deliver.js'
import { summarize } from './lib/summarize.js'
import { HEARTBEAT_MS } from './lib/schedule.js'
import { validateUrl } from './lib/fetch.js'

const LOG = '[info-radar]'
const API = '/api/dsh-info-radar'
const MAX_BODY_BYTES = 512 * 1024

/** 统一的 JSON 应答。 */
function respond(response, statusCode, value) {
  const body = JSON.stringify(value)
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed
}

function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? ''
  return address === '' || address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address === '::ffff:127.0.0.1'
}

/** 渠道中文名，只用于界面展示。 */
const CHANNEL_LABELS = {
  qq: 'QQ',
  weixin: '微信',
  feishu: '飞书',
  dingtalk: '钉钉',
  wecom: '企业微信',
  'wecom-app': '企业微信',
  telegram: 'Telegram',
  slack: 'Slack',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  imessage: 'iMessage',
  matrix: 'Matrix',
  email: '邮箱',
}

/** 平台 ID 只露后 6 位，够用户认出来，又不用把长 openid 铺在界面上。 */
function maskRouteId(route) {
  const values = Object.values(route ?? {}).filter((value) => typeof value === 'string' || typeof value === 'number')
  const first = values.length === 0 ? '' : String(values[0])
  if (first === '') return ''
  return first.length <= 8 ? first : `…${first.slice(-6)}`
}

/** 把一条投递建议写成「QQ · 私聊（…ab12cd）」这种人能读的标签。 */
function describeSuggestion(channel, suggestion) {
  const channelName = CHANNEL_LABELS[channel] ?? (channel === '' ? 'IM' : channel)
  const kind = suggestion?.kind
  const kindLabel = kind === 'user' || kind === 'dm'
    ? '私聊'
    : kind === 'group'
      ? '群聊'
      : kind === 'topic' || kind === 'thread'
        ? '话题'
        : kind === 'room' || kind === 'channel' || kind === 'conversation'
          ? '频道'
          : '会话'
  const masked = maskRouteId(suggestion?.route)
  return `${channelName} · ${kindLabel}${masked === '' ? '' : `（${masked}）`}`
}

export function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config?.dataDir)
  const store = new Store(dataDir)
  const cookiePath = join(dataDir, 'cookies.json')

  const log = (message) => {
    if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') ctx.logger.info(message)
    else console.log(message)
  }
  const warn = (message) => {
    if (ctx.logger !== undefined && typeof ctx.logger.warn === 'function') ctx.logger.warn(message)
    else console.warn(message)
  }

  log(`${LOG} 数据目录 ${dataDir}`)

  // Cookie 与自定义请求头：单独文件，面板不回显原值。
  const readHeadersStore = () => {
    try {
      const parsed = JSON.parse(readFileSync(cookiePath, 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  const writeHeadersStore = (value) => {
    mkdirSync(dataDir, { recursive: true })
    const payload = `${JSON.stringify(value, null, 2)}\n`
    const temp = `${cookiePath}.tmp-${process.pid}`
    writeFileSync(temp, payload, 'utf8')
    try {
      renameSync(temp, cookiePath)
    } catch {
      // Windows 上目标被占用时 rename 会失败，退回直接写
      writeFileSync(cookiePath, payload, 'utf8')
    }
  }

  const runner = new RadarRunner({
    ctx,
    store,
    log,
    origin: typeof config?.origin === 'string' ? config.origin : '',
    loadHeaders: (sourceId) => {
      const all = readHeadersStore()
      const entry = all[sourceId]
      return entry !== null && typeof entry === 'object' ? entry : null
    },
  })

  // 首次运行时确保有配置骨架
  if (!existsSync(join(dataDir, 'config.json'))) {
    store.saveConfig(normalizeConfig({
      globalIntervalMinutes: Number(config?.defaultIntervalMinutes) > 0 ? Number(config.defaultIntervalMinutes) : 1440,
      anchor: new Date().toISOString(),
      sources: [],
    }))
  }

  // 心跳：每 30 秒看一次有没有源到期。
  // 定时器必须在 effect 的清理函数里 clearInterval，否则插件卸载后进程仍被这个 timer 挂住。
  ctx.effect(() => {
    const timer = setInterval(() => {
      runner.tick().catch((error) => warn(`${LOG} 心跳异常: ${String(error?.message ?? error)}`))
      // 已读条目的定期清理跟着心跳走，内部自己判断到没到时间
      try {
        runner.cleanupReadItems()
      } catch (error) {
        warn(`${LOG} 清理已读失败: ${String(error?.message ?? error)}`)
      }
    }, HEARTBEAT_MS)
    // 启动后先跑一次，避免重启后要等半个心跳；启动抓取也要能取消。
    const kickoff = setTimeout(() => {
      runner.tick().catch((error) => warn(`${LOG} 启动抓取异常: ${String(error?.message ?? error)}`))
    }, 3000)
    return () => {
      clearInterval(timer)
      clearTimeout(kickoff)
    }
  }, 'dsh-info-radar: heartbeat')

  // webServer 是可选服务：Cordis 里它可能比本插件晚就绪，
  // 所以不能直接 ctx.get 判空后就 return（那样一条路由都注册不上，
  // 面板会一直报 404）。用 ctx.inject 等它就绪，回调执行时再注册。
  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') {
      warn(`${LOG} webServer 不可用，面板无法读取数据`)
      return
    }
    log(`${LOG} webServer 就绪，开始注册 ${API}/* 端点`)
    registerRoutes(scope, webServer)
  })

  /** 端点注册体：放在 inject 回调里，保证 webServer 已存在。 */
  function registerRoutes(scope, webServer) {
    const guard = (handler) => async (request, response) => {
      try {
        if (!isLoopback(request)) {
          respond(response, 403, { ok: false, error: '仅允许本机访问' })
          return
        }
        await handler(request, response)
      } catch (error) {
        warn(`${LOG} 请求失败: ${String(error?.stack ?? error?.message ?? error)}`)
        try {
          respond(response, 500, { ok: false, error: String(error?.message ?? error) })
        } catch {
          /* 已发出 */
        }
      }
    }

  /** GET /status：面板主数据 */
  scope.effect(() => webServer.register({
    kind: 'exact',
    path: `${API}/status`,
    handler: guard(async (request, response) => {
      if ((request.method ?? 'GET').toUpperCase() !== 'GET') {
        respond(response, 405, { ok: false, error: '只接受 GET' })
        return
      }
      const snapshot = runner.snapshot()
      const headersStore = readHeadersStore()
      respond(response, 200, {
        ok: true,
        ...snapshot,
        // 只告诉前端「配没配」，不回传 Cookie 原值
        sources: snapshot.sources.map((source) => ({
          ...source,
          hasCookie: headersStore[source.id] !== undefined,
        })),
      })
    }),
  }), 'dsh-info-radar: status')

  /** GET|POST /config：读写全局设置与源列表 */
  scope.effect(() => webServer.register({
    kind: 'exact',
    path: `${API}/config`,
    handler: guard(async (request, response) => {
      const method = (request.method ?? 'GET').toUpperCase()
      if (method === 'GET') {
        respond(response, 200, { ok: true, config: store.loadConfig() })
        return
      }
      if (method !== 'POST') {
        respond(response, 405, { ok: false, error: '只接受 GET 与 POST' })
        return
      }
      const body = await readJsonBody(request)
      const incoming = body.config !== null && typeof body.config === 'object' ? body.config : {}
      for (const source of Array.isArray(incoming.sources) ? incoming.sources : []) {
        const invalid = validateUrl(source?.url)
        if (invalid !== null) {
          respond(response, 400, { ok: false, error: `${source?.name ?? '未命名'}：${invalid}` })
          return
        }
      }
      const saved = store.saveConfig(incoming)
      log(`${LOG} 配置已保存：${saved.sources.length} 个源`)
      respond(response, 200, { ok: true, config: saved })
    }),
  }), 'dsh-info-radar: config')

  /** POST /run：立即抓取（全部到期源，或指定一个源） */
  scope.effect(() => webServer.register({
    kind: 'exact',
    path: `${API}/run`,
    handler: guard(async (request, response) => {
      if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
        respond(response, 405, { ok: false, error: '只接受 POST' })
        return
      }
      const body = await readJsonBody(request)
      const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
      const result = sourceId !== ''
        ? await runner.runOneNow(sourceId)
        : await forceRunAll(runner, store)
      respond(response, 200, { ok: true, result })
    }),
  }), 'dsh-info-radar: run')

  /** POST /read：标记已读（单条 id 或整体游标） */
  scope.effect(() => webServer.register({
    kind: 'exact',
    path: `${API}/read`,
    handler: guard(async (request, response) => {
      if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
        respond(response, 405, { ok: false, error: '只接受 POST' })
        return
      }
      const body = await readJsonBody(request)
      const state = store.loadState()

      // 单条已读：点开详情或原文时调用，只影响这一条
      if (typeof body.id === 'string' && body.id !== '') {
        const ids = new Set(state.readIds ?? [])
        ids.add(body.id)
        state.readIds = [...ids]
        const readAt = state.readAt ?? {}
        readAt[body.id] = new Date().toISOString()
        state.readAt = readAt
        store.saveState(state)
        respond(response, 200, { ok: true, readIds: state.readIds.length })
        return
      }

      // 整体已读：把所有当前条目标为已读
      const items = store.loadItems()
      const maxSeq = items.reduce((max, item) => Math.max(max, Number(item.seq) || 0), 0)
      const target = Number(body.seq)
      state.readSeq = Number.isFinite(target) && target >= 0 ? Math.min(target, maxSeq) : maxSeq
      store.saveState(state)
      respond(response, 200, { ok: true, readSeq: state.readSeq })
    }),
  }), 'dsh-info-radar: read')

  /** POST /summarize：对单条内容重新做 AI 总结 */
  scope.effect(() => webServer.register({
    kind: 'exact',
    path: `${API}/summarize`,
    handler: guard(async (request, response) => {
      if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
        respond(response, 405, { ok: false, error: '只接受 POST' })
        return
      }
      const body = await readJsonBody(request)
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') {
        respond(response, 400, { ok: false, error: '缺少条目 id' })
        return
      }
      const items = store.loadItems()
      const item = items.find((entry) => entry.id === id)
      if (item === undefined) {
        respond(response, 404, { ok: false, error: '找不到这条内容' })
        return
      }
      if (item.baseline === true) {
        respond(response, 200, { ok: false, error: '基线内容不总结（它只是首次抓取的存量）' })
        return
      }

      // 优先用抓取时存的正文快照，没有就退回摘要文本
      const text = store.readSnapshot(item.snapshotKey) ?? item.summary ?? ''
      if (String(text).trim() === '') {
        respond(response, 200, { ok: false, error: '这条内容没有可用的正文' })
        return
      }
      // 附件型（报名表之类）没有实质内容可总结
      if (item.attachmentOnly === true) {
        respond(response, 200, { ok: false, error: item.attachmentNote || '这条内容只有附件，没有可总结的正文' })
        return
      }

      const summary = await summarize({ ctx, text })
      if (summary === null || summary === summarize.NO_CONTENT) {
        respond(response, 200, { ok: false, error: summarize.lastError ?? '模型判定这条没有有效内容' })
        return
      }

      // 写回条目文件
      const updated = items.map((entry) =>
        entry.id === id ? { ...entry, summary, summarized: true, summaryError: null } : entry,
      )
      store.rewriteItems(updated)
      // 用过总结就算已读（用户明确要求）。
      // 传 keepUnread 的调用（例如提示词修好后重新生成旧摘要）不改变已读状态。
      if (body.keepUnread !== true) {
        const readState = store.loadState()
        const readIds = new Set(readState.readIds ?? [])
        readIds.add(id)
        readState.readIds = [...readIds]
        const readAt = readState.readAt ?? {}
        readAt[id] = new Date().toISOString()
        readState.readAt = readAt
        store.saveState(readState)
      }
      respond(response, 200, { ok: true, summary })
    }),
  }), 'dsh-info-radar: summarize')

  /**
   * POST /summarize-all：总结所有「未读且未总结」的内容。
   *
   * 用户明确要的批量入口：一次把没读过、也没摘要的都补上。
   * 逐条串行执行，单条失败不影响其他条，最后汇报成功/失败数量。
   */
  scope.effect(() => webServer.register({
    kind: 'exact',
    path: `${API}/summarize-all`,
    handler: guard(async (request, response) => {
      if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
        respond(response, 405, { ok: false, error: '只接受 POST' })
        return
      }
      const items = store.loadItems()
      const state = store.loadState()
      const targets = items.filter(
        (item) =>
          item.baseline !== true &&
          item.attachmentOnly !== true &&
          item.summarized !== true &&
          !isItemRead(state, item),
      )
      if (targets.length === 0) {
        respond(response, 200, { ok: true, total: 0, succeeded: 0, failed: 0, message: '没有需要总结的未读内容' })
        return
      }

      let succeeded = 0
      let failed = 0
      const errors = []
      const byId = new Map(items.map((item) => [item.id, item]))
      // 总结成功后要写回已读标记
      const readState = store.loadState()
      for (const target of targets.slice(0, 50)) {
        const text = store.readSnapshot(target.snapshotKey) ?? target.summary ?? ''
        if (String(text).trim() === '') {
          failed += 1
          errors.push(`${target.title}：没有正文`)
          continue
        }
        const summary = await summarize({ ctx, text })
        if (summary === null || summary === summarize.NO_CONTENT) {
          failed += 1
          errors.push(`${target.title}：${summarize.lastError ?? '模型未返回摘要'}`)
          continue
        }
        const record = byId.get(target.id)
        if (record !== undefined) {
          record.summary = summary
          record.summarized = true
          record.summaryError = null
        }
        // 总结即已读（用户明确要求）
        const summaryReadIds = new Set(readState.readIds ?? [])
        summaryReadIds.add(target.id)
        readState.readIds = [...summaryReadIds]
        readState.readAt = { ...(readState.readAt ?? {}), [target.id]: new Date().toISOString() }
        succeeded += 1
      }
      store.rewriteItems([...byId.values()])
      store.saveState(readState)
      respond(response, 200, {
        ok: true,
        total: targets.length,
        succeeded,
        failed,
        errors: errors.slice(0, 5),
      })
    }),
  }), 'dsh-info-radar: summarize-all')

  /** POST /cookie：写入或清除某个源的请求头 */
  scope.effect(() => webServer.register({
    kind: 'exact',
    path: `${API}/cookie`,
    handler: guard(async (request, response) => {
      if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
        respond(response, 405, { ok: false, error: '只接受 POST' })
        return
      }
      const body = await readJsonBody(request)
      const sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim() : ''
      if (sourceId === '') {
        respond(response, 400, { ok: false, error: '缺少 sourceId' })
        return
      }
      const all = readHeadersStore()
      const clear = body.clear === true
      if (clear) {
        delete all[sourceId]
        writeHeadersStore(all)
        // 清掉 Cookie 就把源从「待登录」放回正常
        const state = store.loadState()
        const run = state.sources?.[sourceId]
        if (run !== undefined && run.status === 'needs-cookie') {
          run.status = 'ok'
          run.lastError = null
          run.failStreak = 0
          state.sources = { ...state.sources, [sourceId]: run }
          store.saveState(state)
        }
        respond(response, 200, { ok: true, hasCookie: false })
        return
      }

      const cookie = typeof body.cookie === 'string' ? body.cookie.trim() : ''
      if (cookie === '') {
        respond(response, 400, { ok: false, error: 'Cookie 为空' })
        return
      }
      if (cookie.length > 16 * 1024) {
        respond(response, 400, { ok: false, error: 'Cookie 过长（上限 16KB）' })
        return
      }
      const headers = { cookie }
      for (const name of ['user-agent', 'referer']) {
        const value = typeof body[name === 'user-agent' ? 'userAgent' : 'referer'] === 'string'
          ? body[name === 'user-agent' ? 'userAgent' : 'referer'].trim()
          : ''
        if (value !== '') headers[name] = value.slice(0, 1024)
      }
      all[sourceId] = headers
      writeHeadersStore(all)

      // 写回后把源恢复成 ok，并触发一次基线抓取
      const state = store.loadState()
      const run = { ...(state.sources?.[sourceId] ?? {}) }
      run.status = 'ok'
      run.lastError = null
      run.failStreak = 0
      run.baselineDone = false
      delete run.lastSlot
      state.sources = { ...state.sources, [sourceId]: run }
      store.saveState(state)

      const cfg = store.loadConfig()
      const source = cfg.sources.find((entry) => entry.id === sourceId)
      if (source !== undefined) {
        source.hasHeaders = true
        store.saveConfig(cfg)
        runner.runOneNow(sourceId).catch((error) => warn(`${LOG} 恢复抓取失败: ${String(error?.message ?? error)}`))
      }
      respond(response, 200, { ok: true, hasCookie: true })
    }),
  }), 'dsh-info-radar: cookie')

  /** POST /source-action：暂停 / 恢复 / 忽略某个源 */
  scope.effect(() => webServer.register({
    kind: 'exact',
    path: `${API}/source-action`,
    handler: guard(async (request, response) => {
      if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
        respond(response, 405, { ok: false, error: '只接受 POST' })
        return
      }
      const body = await readJsonBody(request)
      const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
      const action = typeof body.action === 'string' ? body.action : ''
      const state = store.loadState()
      const run = { ...(state.sources?.[sourceId] ?? {}) }
      if (action === 'ignore') {
        run.status = 'paused'
        run.lastError = '已忽略，需要重新填写 Cookie 才恢复'
      } else if (action === 'resume') {
        run.status = 'ok'
        run.lastError = null
        run.failStreak = 0
        delete run.lastSlot
      } else if (action === 'reset') {
        delete state.sources?.[sourceId]
      } else {
        respond(response, 400, { ok: false, error: '未知操作' })
        return
      }
      if (action !== 'reset') state.sources = { ...state.sources, [sourceId]: run }
      store.saveState(state)
      respond(response, 200, { ok: true })
    }),
  }), 'dsh-info-radar: source-action')

  /**
   * POST /im-status：探测 IM 联动可用性。
   *
   * 三种情况要分清楚，因为界面上要给用户不同的话：
   * - available=true  → 已装 dsh-im，可以联动（可能已经有配置好的机器人）
   * - available=false + reason=not-installed → 没装，需要先装
   * - available=true 但 bots=[] → 装了但还没接任何机器人，需要先扫码/配凭据
   */
  scope.effect(() => webServer.register({
    kind: 'exact',
    path: `${API}/im-status`,
    handler: guard(async (request, response) => {
      if ((request.method ?? 'GET').toUpperCase() !== 'GET') {
        respond(response, 405, { ok: false, error: '只接受 GET' })
        return
      }
      const origin = config?.origin ?? webServer.getOrigin?.() ?? ''
      const info = await detectDshIm(ctx, origin)
      // 每个机器人顺带列出已配置目标和「可投递的会话」，
      // 这样用户没手动建目标时下拉框里也有东西可选。
      const bots = []
      for (const bot of Array.isArray(info.bots) ? info.bots : []) {
        const targets = await listDshImTargets(ctx, bot.botId)
        const targetList = Array.isArray(targets.targets?.targets)
          ? targets.targets.targets
          : (Array.isArray(targets.targets) ? targets.targets : [])
        const suggestionResult = await listDshImSuggestions(ctx, bot.botId)
        const collected = []
        const seenSuggestion = new Set()
        const pushSuggestion = (entry) => {
          const key = `${entry?.kind ?? ''}:${JSON.stringify(entry?.route ?? {})}`
          if (seenSuggestion.has(key)) return
          seenSuggestion.add(key)
          collected.push({
            kind: entry.kind,
            route: entry.route,
            label: describeSuggestion(bot.channel ?? '', entry),
          })
        }
        for (const entry of suggestionResult.suggestions) pushSuggestion(entry)
        // dsh-im 5.x 的公开服务没有 listSuggestions，退一步读它自己记的
        // 「机器人主人」平台 id；用户还没建过目标时，这条就是最可能的收件人。
        if (collected.length === 0) {
          for (const entry of readOwnerSuggestion(bot.channel ?? '', bot.botId)) {
            pushSuggestion(entry)
            if (collected.length > 0) collected[collected.length - 1].label += ' · 机器人主人'
          }
        }
        bots.push({
          botId: bot.botId,
          channel: bot.channel ?? '',
          targets: targetList,
          suggestions: collected,
        })
      }
      respond(response, 200, {
        ok: true,
        available: info.available,
        via: info.via,
        error: info.error,
        bots,
      })
    }),
  }), 'dsh-info-radar: im-status')

  /** POST /im-test：用当前配置的 dsh-im 参数发一条测试消息 */
  scope.effect(() => webServer.register({
    kind: 'exact',
    path: `${API}/im-test`,
    handler: guard(async (request, response) => {
      if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
        respond(response, 405, { ok: false, error: '只接受 POST' })
        return
      }
      const body = await readJsonBody(request)
      const cfg = store.loadConfig()
      const botId = typeof body.botId === 'string' && body.botId !== '' ? body.botId : cfg.notify.dshImBotId
      const targetId = typeof body.targetId === 'string' && body.targetId !== '' ? body.targetId : cfg.notify.dshImTargetId
      const draft = normalizeDraftTarget(body.draft) ?? cfg.notify.dshImDraft
      if (botId === '' || (targetId === '' && draft === null)) {
        respond(response, 200, { ok: false, error: '还没选机器人或投递目标' })
        return
      }
      const origin = config?.origin ?? webServer.getOrigin?.() ?? ''
      const result = await sendViaDshIm({
        ctx,
        origin,
        botId,
        targetId,
        draft,
        text: '【信息雷达】测试消息：IM 通道可用。',
      })
      respond(response, 200, { ok: result.ok, error: result.error, via: result.via })
    }),
  }), 'dsh-info-radar: im-test')

  /**
   * POST /im-target：把界面上选中的会话登记成真正的投递目标。
   *
   * dsh-im 的目标列表为空时，用户没法在设置页里选；这里直接用
   * `listSuggestions` 给出的路由调 `createTarget`，自动生成 `info-radar`
   * 这样的目标 id，之后推送就用这个稳定 id。
   */
  scope.effect(() => webServer.register({
    kind: 'exact',
    path: `${API}/im-target`,
    handler: guard(async (request, response) => {
      if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
        respond(response, 405, { ok: false, error: '只接受 POST' })
        return
      }
      const body = await readJsonBody(request)
      const cfg = store.loadConfig()
      const botId = typeof body.botId === 'string' && body.botId !== '' ? body.botId : cfg.notify.dshImBotId
      const draft = normalizeDraftTarget(body.draft ?? body)
      if (botId === '') {
        respond(response, 400, { ok: false, error: '缺少机器人 id' })
        return
      }
      if (draft === null) {
        respond(response, 400, { ok: false, error: '缺少目标类型或平台路由' })
        return
      }
      const result = await createDshImTarget(ctx, botId, {
        kind: draft.kind,
        route: draft.route,
        name: '信息雷达',
      })
      respond(response, 200, { ok: result.ok, targetId: result.targetId ?? '', error: result.error ?? null })
    }),
  }), 'dsh-info-radar: im-target')

  /**
   * POST /push：把当前「未读且没推过」的积压立刻推出去。
   *
   * 推送开关是后开的、或者之前一直失败时，用户不用等下一个心跳，
   * 点一下这个按钮就能补发；发过的条目会带 pushedAt 标记，不会重复发。
   */
  scope.effect(() => webServer.register({
    kind: 'exact',
    path: `${API}/push`,
    handler: guard(async (request, response) => {
      if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
        respond(response, 405, { ok: false, error: '只接受 POST' })
        return
      }
      const body = await readJsonBody(request)
      const cfg = store.loadConfig()
      if (cfg.notify?.enabled !== true) {
        respond(response, 200, { ok: false, error: '推送还没开启：先到设置里勾选「有新内容时推送到 IM 机器人」并保存' })
        return
      }
      const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
      const result = await runner.flushPendingPushes({ sourceId, maxMessages: 10 })
      const messages = Array.isArray(result.messages) ? result.messages : []
      const failed = messages.filter((entry) => entry.ok !== true)
      if (messages.length === 0) {
        respond(response, 200, { ok: true, pushed: 0, message: '没有待推送的未读内容' })
        return
      }
      respond(response, 200, {
        ok: failed.length === 0,
        pushed: messages.filter((entry) => entry.ok === true).length,
        items: messages.reduce((total, entry) => total + (entry.ok === true ? Number(entry.count) || 0 : 0), 0),
        error: failed.length === 0 ? null : (failed[0].error ?? '推送失败'),
        messages,
      })
    }),
  }), 'dsh-info-radar: push')

  /** POST /clear：清空条目与状态（不动配置） */
  scope.effect(() => webServer.register({
    kind: 'exact',
    path: `${API}/clear`,
    handler: guard(async (request, response) => {
      if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
        respond(response, 405, { ok: false, error: '只接受 POST' })
        return
      }
      const body = await readJsonBody(request)
      if (body.confirm !== true) {
        respond(response, 400, { ok: false, error: '缺少确认标记' })
        return
      }
      const state = store.loadState()
      // 重置运行状态
      store.saveState({ version: state.version, readSeq: 0, sources: {}, seenKeys: [], lastPushSlot: {} })
      // 真的清掉条目与快照——之前只重置了 state，条目文件还留着，
      // 表现为「点了清空但列表还是满的」。
      store.clearItems()
      store.clearSnapshots()
      respond(response, 200, { ok: true })
    }),
  }), 'dsh-info-radar: clear')
  }
}

/** 忽略期号判断，把当前所有启用的源都抓一遍。 */
async function forceRunAll(runner, store) {
  const cfg = store.loadConfig()
  const results = []
  for (const source of cfg.sources) {
    if (!source.enabled) continue
    results.push(await runner.runOneNow(source.id))
  }
  return results
}

