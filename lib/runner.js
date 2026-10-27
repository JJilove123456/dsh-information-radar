/**
 * 主循环：心跳 → 判断哪些源到期 → 抓取 → 去重 → 总结 → 入库 → 推送。
 *
 * 状态约定（每个源）：
 *   lastSlot     上次抓取所属的期号（锚点周期算法的核心）
 *   status       ok | needs-cookie | paused | error
 *   lastRunAt    上次抓取完成时间
 *   lastError    上次失败原因
 *   failStreak   连续失败次数
 *   lastBodyLen  上次正文长度，用于判断掉登录态
 *   baselineDone 是否已完成首次基线（基线抓取不刷未读）
 */
import { fetchSource, filterEntries, enrichWithDetail, crawlPages } from './fetch.js'
import { summarize } from './summarize.js'
import { sortByDateDesc } from './parse.js'
import { composePushText, sendViaDshIm } from './deliver.js'
import { evaluateDue, clampIntervalMinutes } from './schedule.js'
import { contentKeyOf, pruneSeenKeys } from './store.js'

export const MAX_PARALLEL_SOURCES = 3
export const FAIL_STREAK_TO_PAUSE = 3
/** 一条推送消息最多涵盖多少条内容；超出的算「同一批已推」，避免连发好几条。 */
export const MAX_PUSH_ITEMS = 20
/** 掉登录态判定：正文长度跌幅超过这个比例，且页面出现登录提示词。 */
export const LOGIN_SHORTFALL_RATIO = 0.5
const LOGIN_HINTS = ['登录', '登陆', '请先登录', 'sign in', 'log in', 'login required', '未登录']

/** 判断这次抓取结果像不像「掉登录态」。 */
export function looksLikeLoginLost({ previousLen, currentLen, text }) {
  if (!Number.isFinite(previousLen) || previousLen < 200) return false
  if (!Number.isFinite(currentLen)) return false
  if (currentLen >= previousLen * (1 - LOGIN_SHORTFALL_RATIO)) return false
  const haystack = String(text).toLowerCase()
  return LOGIN_HINTS.some((hint) => haystack.includes(hint.toLowerCase()))
}

/** 有效间隔：源覆盖优先，否则跟随全局。 */
export function effectiveInterval(source, config) {
  const own = Number(source?.intervalMinutes)
  if (Number.isFinite(own) && own > 0) return clampIntervalMinutes(own) * 60 * 1000
  return clampIntervalMinutes(config.globalIntervalMinutes) * 60 * 1000
}

/**
 * 一条内容是否已读。
 *
 * 两种标记方式并存：
 * - readIds：逐条已读（点开过这条的详情或原文）
 * - readSeq：整体已读游标（点「全部标记已读」时用）
 * 只要命中任意一种就算已读。
 */
export function isItemRead(state, item) {
  const id = String(item?.id ?? '')
  if (id !== '' && Array.isArray(state?.readIds) && state.readIds.includes(id)) return true
  return Number(item?.seq) <= Number(state?.readSeq ?? 0)
}

export class RadarRunner {
  /**
   * @param {object} deps
   * @param {object} deps.ctx 宿主 context
   * @param {import('./store.js').Store} deps.store
   * @param {(message: string) => void} deps.log
   * @param {() => Array<{source:string, headers:Record<string,string>}>} [deps.loadHeaders] 取某源的请求头
   */
  constructor({ ctx, store, log, loadHeaders, origin }) {
    this.ctx = ctx
    this.store = store
    this.log = log
    this.loadHeaders = loadHeaders ?? (() => null)
    // Web 根地址：dsh-im 没有服务时用它走 HTTP 回退
    this.origin = typeof origin === 'string' ? origin : ''
    this.running = false
    this.rerunRequested = false
  }

  /** 当前时刻快照，面板用。 */
  snapshot(nowMs = Date.now()) {
    const config = this.store.loadConfig()
    const state = this.store.loadState()
    const items = this.store.loadItems()
    const sources = config.sources.map((source) => {
      const run = state.sources?.[source.id] ?? {}
      const intervalMs = effectiveInterval(source, config)
      const due = evaluateDue({
        anchorMs: Date.parse(config.anchor),
        intervalMs,
        nowMs,
        lastSlot: Number.isFinite(run.lastSlot) ? run.lastSlot : null,
      })
      const sourceItems = items.filter((item) => item.sourceId === source.id)
      return {
        ...source,
        intervalMinutes: source.intervalMinutes ?? config.globalIntervalMinutes,
        status: run.status ?? (source.enabled ? 'ok' : 'paused'),
        lastRunAt: run.lastRunAt ?? null,
        lastError: run.lastError ?? null,
        failStreak: run.failStreak ?? 0,
        itemCount: sourceItems.length,
        // 这个源自己的未读数，面板上按源显示红数字
        unreadCount: sourceItems.filter((item) => !isItemRead(state, item)).length,
        nextAtMs: due.nextAtMs,
        dueReason: due.reason,
      }
    })
    return {
      config,
      sources,
      items: items
        .map((item) => ({
          ...item,
          // 逐条已读：点开过详情或原文的条目直接标记，不再靠单一游标推断
          read: isItemRead(state, item),
        }))
        // 服务端先排好「从新到旧」，面板与 QQ 推送都用这个顺序
        .sort((left, right) => {
          const keyOf = (item) => {
            const published = typeof item.publishedAt === 'string' ? item.publishedAt.trim() : ''
            if (published !== '') return `0:${published}`
            const found = typeof item.foundAt === 'string' ? item.foundAt : ''
            return `1:${found}`
          }
          const ka = keyOf(left)
          const kb = keyOf(right)
          if (ka !== kb) return ka < kb ? 1 : -1
          return Number(right.seq) - Number(left.seq)
        }),
      unread: items.filter((item) => !isItemRead(state, item)).length,
      // 「还没推出去」的条数：面板上的「推送未读」按钮用它决定能不能点
      pendingPush: items.filter(
        (item) => !isItemRead(state, item) && (typeof item.pushedAt !== 'string' || item.pushedAt === ''),
      ).length,
      needsCookie: sources.filter((source) => source.status === 'needs-cookie').length,
      readSeq: Number(state.readSeq ?? 0),
      readIds: Array.isArray(state.readIds) ? state.readIds.length : 0,
      lastCleanupAt: state.lastCleanupAt ?? null,
      running: this.running,
      dataDir: this.store.dir,
    }
  }

  /**
   * 定期清理已读条目。
   *
   * 只在「上次清理时间 + 间隔 <= 现在」时动手，避免每 30 秒心跳都扫一遍。
   * 删掉条目时顺带删对应快照，否则快照文件会越积越多。
   * @returns {{cleaned:boolean, removed?:number, reason?:string}}
   */
  cleanupReadItems(nowMs = Date.now()) {
    const config = this.store.loadConfig()
    if (config.cleanupReadEnabled !== true) return { cleaned: false, reason: 'disabled' }
    const intervalMs = Math.max(60 * 1000, Number(config.cleanupReadIntervalMinutes) * 60 * 1000)
    const state = this.store.loadState()
    const last = Date.parse(state.lastCleanupAt ?? '')
    if (Number.isFinite(last) && nowMs - last < intervalMs) return { cleaned: false, reason: 'not-due' }

    const items = this.store.loadItems()
    // 只删「已读」且不是刚刚入库的（留一点余量，避免刚点开就被清掉）
    const graceMs = 60 * 1000
    const removable = items.filter((item) => {
      if (!isItemRead(state, item)) return false
      const found = Date.parse(item.foundAt ?? '')
      return !Number.isFinite(found) || nowMs - found > graceMs
    })
    if (removable.length === 0) {
      state.lastCleanupAt = new Date(nowMs).toISOString()
      this.store.saveState(state)
      return { cleaned: true, removed: 0 }
    }

    const ids = removable.map((item) => item.id)
    const removed = this.store.removeItems(ids)
    // 同步清掉这些条目的已读标记与快照
    const dropIds = new Set(ids)
    state.readIds = (state.readIds ?? []).filter((id) => !dropIds.has(id))
    for (const item of removable) {
      if (typeof item.snapshotKey === 'string') {
        try {
          this.store.clearSnapshotsByKey(item.snapshotKey)
        } catch {
          /* 快照删不掉不影响主流程 */
        }
      }
    }
    state.lastCleanupAt = new Date(nowMs).toISOString()
    this.store.saveState(state)
    this.log(`[radar] 定期清理：删除 ${removed} 条已读内容`)
    return { cleaned: true, removed }
  }

  /**
   * 心跳入口：挑出到期且可抓的源并发跑；抓完再补推一次未读积压。
   *
   * 补推必须放在「没有源到期」的情况下也执行，否则推送开关后开、
   * 或者中途一直失败时，积压的未读永远不会发出去。
   */
  async tick(nowMs = Date.now()) {
    if (this.running) return { skipped: 'already-running' }
    const config = this.store.loadConfig()
    if (config.paused) return { skipped: 'paused' }
    const state = this.store.loadState()
    const anchorMs = Date.parse(config.anchor)

    const due = []
    for (const source of config.sources) {
      if (!source.enabled) continue
      const run = state.sources?.[source.id] ?? {}
      if (run.status === 'needs-cookie' || run.status === 'paused') continue
      const intervalMs = effectiveInterval(source, config)
      const verdict = evaluateDue({
        anchorMs,
        intervalMs,
        nowMs,
        lastSlot: Number.isFinite(run.lastSlot) ? run.lastSlot : null,
      })
      if (verdict.due) due.push({ source, verdict })
    }

    this.running = true
    try {
      const results = []
      for (let index = 0; index < due.length; index += MAX_PARALLEL_SOURCES) {
        const batch = due.slice(index, index + MAX_PARALLEL_SOURCES)
        const settled = await Promise.all(batch.map((entry) => this.runOne(entry.source, entry.verdict, nowMs)))
        results.push(...settled)
      }
      // 抓取阶段各自推过一轮；这里只兜「没到期源但还有积压」的情况，
      // 有到期源时 pushSource 已经处理过，再调也不会重复发。
      let flushed = null
      if (config.notify?.enabled === true) {
        try {
          flushed = await this.flushPendingPushes({ maxMessages: 2 })
        } catch (error) {
          this.log(`[radar] 补推未读失败：${String(error?.message ?? error)}`)
        }
      }
      if (results.length === 0 && (flushed === null || flushed.messages.length === 0)) {
        return { skipped: 'nothing-due' }
      }
      return { ran: results.length, results, flushed }
    } finally {
      this.running = false
    }
  }

  /** 手动抓一个源，忽略期号判断。 */
  async runOneNow(sourceId) {
    const config = this.store.loadConfig()
    const source = config.sources.find((entry) => entry.id === sourceId)
    if (source === undefined) return { ok: false, error: '找不到这个源' }
    if (this.running) return { ok: false, error: '已经有一轮在跑，等它结束' }
    this.running = true
    try {
      const anchorMs = Date.parse(config.anchor)
      const intervalMs = effectiveInterval(source, config)
      const slot = Math.floor((Date.now() - anchorMs) / intervalMs)
      return await this.runOne(source, { slot, due: true }, Date.now(), true)
    } finally {
      this.running = false
    }
  }

  /** 抓一个源并落库。 */
  async runOne(source, verdict, nowMs, manual = false) {
    const config = this.store.loadConfig()
    const state = this.store.loadState()
    const run = { ...(state.sources?.[source.id] ?? {}) }
    const startedAt = Date.now()

    let headers = null
    if (source.hasHeaders) {
      try {
        headers = this.loadHeaders(source.id)
      } catch {
        headers = null
      }
    }

    let result
    try {
      result = await fetchSource({ web: this.ctx.get?.('web'), source, headers })
    } catch (error) {
      result = { ok: false, error: String(error?.message ?? error) }
    }

    if (!result.ok) {
      run.status = 'error'
      run.lastError = result.error ?? '未知错误'
      run.failStreak = Number(run.failStreak ?? 0) + 1
      run.lastRunAt = startedAt
      if (run.failStreak >= FAIL_STREAK_TO_PAUSE) {
        run.status = 'paused'
        run.lastError = `${run.lastError}（连续失败 ${run.failStreak} 次，已暂停）`
      }
      // 失败也记下当期号，避免每 30 秒重试同一个坏源
      run.lastSlot = verdict.slot
      state.sources = { ...state.sources, [source.id]: run }
      this.store.saveState(state)
      this.log(`[radar] ${source.name} 抓取失败：${run.lastError}`)
      return { ok: false, sourceId: source.id, error: run.lastError }
    }

    const allEntries = result.entries ?? []
    const fullText = result.kind === 'feed'
      ? allEntries.map((entry) => entry.text).join('\n')
      : (result.blocks ?? []).join('\n')

    // 掉登录态检测：正文骤减 + 出现登录提示词
    if (looksLikeLoginLost({ previousLen: Number(run.lastBodyLen), currentLen: fullText.length, text: fullText })) {
      run.status = 'needs-cookie'
      run.lastError = '疑似登录态失效，需要重新填写 Cookie'
      run.lastRunAt = startedAt
      run.lastSlot = verdict.slot
      run.lastBodyLen = fullText.length
      state.sources = { ...state.sources, [source.id]: run }
      this.store.saveState(state)
      this.log(`[radar] ${source.name} 疑似掉登录态`)
      return { ok: false, sourceId: source.id, error: run.lastError, needsCookie: true }
    }

    const filtered = filterEntries(allEntries, source)
    // 测试期模式跳过基线：直接把当前页面上的内容抓进来
    const isBaseline = config.testMode === true ? false : source.baselineOnly && run.baselineDone !== true

    // 列表页只有标题，先按 key 去重（key 用 url + 标题，不依赖正文），
    // 再对「这一轮真要入库」的条目补抓子页面正文——否则会白白抓一遍已见过的页面。
    const seen = new Set((state.seenKeys ?? []).map((entry) => entry[0]))
    const fresh = []
    for (const entry of filtered) {
      const identity = entry.url ?? source.url
      const key = await contentKeyOf(identity, entry.title ?? entry.text)
      if (seen.has(key)) continue
      seen.add(key)
      fresh.push({ ...entry, key })
    }

    // 翻页：第一页没抓到任何新内容时，说明连首页都还是老样子，没必要再翻；
    // 抓到新内容就继续往后翻，直到某一页全是旧的（时间线追上）为止。
    if (!isBaseline && source.followPages !== false && result.kind === 'list') {
      try {
        const pageNew = await crawlPages({
          web: this.ctx.get?.('web'),
          headers,
          startUrl: result.pageUrl ?? source.url,
          startHtml: result.raw,
          maxPages: Number(source.maxPages ?? 5),
          source,
          countNew: async (pageEntries) => {
            let count = 0
            for (const entry of pageEntries) {
              const key = await contentKeyOf(entry.url, entry.title ?? entry.text)
              if (seen.has(key)) continue
              seen.add(key)
              fresh.push({ ...entry, key })
              count += 1
            }
            return count
          },
        })
        if (pageNew.length > 0) {
          this.log(`[radar] ${source.name} 翻页补充 ${pageNew.length} 条更早内容`)
        }
      } catch (error) {
        this.log(`[radar] ${source.name} 翻页失败，仅用首页：${String(error?.message ?? error)}`)
      }
    }

    // 基线：网页上原本就有的内容只登记、不入库、不显示。
    // 用户要的是「只有更新的内容才抓得到」，所以首次抓取只把 key 记进 seen，
    // 让这些旧条目在后续轮次里也被判定为「已见过」。
    if (isBaseline) {
      const baselineKeys = [...(state.seenKeys ?? []), ...fresh.map((entry) => [entry.key, startedAt])]
      run.status = 'ok'
      run.lastError = null
      run.failStreak = 0
      run.lastRunAt = startedAt
      run.lastSlot = verdict.slot
      run.lastBodyLen = fullText.length
      run.baselineDone = true
      run.baselineCount = fresh.length
      run.summaryError = null
      run.summarizedCount = 0
      state.sources = { ...state.sources, [source.id]: run }
      state.seenKeys = pruneSeenKeys(baselineKeys, startedAt)
      this.store.saveState(state)
      this.log(`[radar] ${source.name} 建立基线：登记 ${fresh.length} 条存量内容（不显示）`)
      return {
        ok: true,
        sourceId: source.id,
        created: 0,
        baseline: true,
        baselineCount: fresh.length,
        truncated: 0,
        pushed: null,
        summarized: 0,
        noContent: 0,
        summaryError: null,
        finishedAt: new Date(startedAt).toISOString(),
      }
    }

    // 按日期从新到旧（日期相同的保持页面顺序），避免「最新内容被截断丢掉」
    const ordered = sortByDateDesc(fresh)

    let created = 0
    const maxPerRun = Number(config.maxEntriesPerRun ?? 19)
    const toStore = ordered.slice(0, maxPerRun)

    // 只为要入库的条目抓详情页；抓不到的保留列表页标题。
    // depth=2 表示「详情页 → 子网页 → 子网页的子网页」三层都跟进。
    try {
      await enrichWithDetail({
        web: this.ctx.get?.('web'),
        entries: toStore,
        source,
        headers,
        limit: maxPerRun,
        depth: Number.isFinite(Number(source.depth)) ? Math.max(0, Math.min(3, Number(source.depth))) : 2,
      })
    } catch (error) {
      this.log(`[radar] ${source.name} 补抓子页面失败，仅用列表页标题：${String(error?.message ?? error)}`)
    }

    let nextSeq = this.store.loadItems().reduce((max, item) => Math.max(max, Number(item.seq) || 0), 0)
    const lastSummaryError = null
    const summarizedCount = 0
    const skippedCount = 0
    // 总结改成纯手动：抓取只负责入库和保存正文快照，摘要留空等用户点按钮。
    for (const entry of toStore) {
      nextSeq += 1
      this.store.saveSnapshot(entry.key, entry.text)
      const record = {
        id: entry.key,
        seq: nextSeq,
        sourceId: source.id,
        sourceName: source.name,
        title: entry.title,
        // 摘要留空、标记未总结，等用户手动点「AI 总结」或「总结全部」
        summary: '',
        summarized: false,
        summaryError: null,
        // 附件型内容（报名表之类）没有实质信息，单独标记，界面上只显示说明和链接
        attachmentOnly: entry.attachmentOnly === true,
        attachmentNote: entry.attachmentNote ?? '',
        // 子网页（含子网页的子网页）以可展开结构存下来
        children: Array.isArray(entry.children) ? entry.children : [],
        url: entry.url ?? source.url,
        publishedAt: entry.publishedAt ?? '',
        foundAt: new Date(startedAt).toISOString(),
        baseline: isBaseline,
        snapshotKey: entry.key,
      }
      this.store.appendItem(record)
      created += 1
    }

    const truncated = fresh.length - toStore.length
    const nowIso = new Date().toISOString()
    const seenKeys = pruneSeenKeys(
      [...(state.seenKeys ?? []), ...fresh.map((entry) => [entry.key, startedAt])],
      startedAt,
    )

    run.status = 'ok'
    run.lastError = null
    run.failStreak = 0
    run.lastRunAt = startedAt
    run.lastSlot = verdict.slot
    run.lastBodyLen = fullText.length
    run.baselineDone = true
    // 把「为什么没总结」带到面板，而不是静默降级
    run.summaryError = lastSummaryError
    run.summarizedCount = summarizedCount
    state.sources = { ...state.sources, [source.id]: run }
    state.seenKeys = seenKeys
    this.store.saveState(state)
    this.store.pruneSnapshots()

    // 推送：基线不推，手动抓取也推（用户点了就想看）。
    // 这里不再只看「本轮新增」，而是把所有「未读且没推过」的都带上，
    // 免得推送开关打开之前攒下的未读永远发不出去。
    const pushed = await this.pushSource(source)

    this.log(
      `[radar] ${source.name} 抓到 ${filtered.length} 条，新增 ${created} 条${truncated > 0 ? `，另 ${truncated} 条超出本轮上限` : ''}${isBaseline ? '（基线，不计未读）' : ''}`,
    )
    return {
      ok: true,
      sourceId: source.id,
      created,
      baseline: isBaseline,
      truncated,
      pushed,
      summarized: summarizedCount,
      noContent: skippedCount,
      summaryError: lastSummaryError,
      finishedAt: nowIso,
    }
  }

  /**
   * 推送前补摘要。
   *
   * 面板里的总结是手动的，但推送必须带摘要；这里只对「要推的这几条」
   * 逐条调用模型，成功与否都不阻塞推送，补出来的摘要顺手写回条目。
   */
  async ensureSummaries(items) {
    const pending = items.filter(
      (item) => item.summarized !== true && item.attachmentOnly !== true && typeof item.id === 'string',
    )
    if (pending.length === 0) return
    for (const item of pending) {
      try {
        const text = this.store.readSnapshot(item.snapshotKey) ?? ''
        if (String(text).trim() === '') continue
        const outcome = await summarize({ ctx: this.ctx, text })
        if (outcome === null) {
          this.log(`[radar] 推送前补摘要失败：${summarize.lastError ?? '未知原因'}（这条先按无摘要推送）`)
          continue
        }
        if (outcome === summarize.NO_CONTENT) continue
        item.summary = outcome
        item.summarized = true
      } catch {
        /* 单条失败不阻塞推送 */
      }
    }
    const byId = new Map(this.store.loadItems().map((entry) => [entry.id, entry]))
    let changed = false
    for (const item of pending) {
      if (item.summarized !== true) continue
      const record = byId.get(item.id)
      if (record === undefined) continue
      record.summary = item.summary
      record.summarized = true
      record.summaryError = null
      changed = true
    }
    if (changed) this.store.rewriteItems([...byId.values()])
  }

  /**
   * 把某个源「未读且没推过」的内容推一条出去。
   *
   * 发送成功后给每条打 `pushedAt` 标记——这就是「发过了就别再发」的凭据，
   * 标记写在条目里，面板不显示。一批最多 MAX_PUSH_ITEMS 条：正文只展开前 3 条，
   * 其余写成「请在面板查看」，同时整批都算已推送，避免连着发好几条消息。
   *
   * @returns {Promise<null | {ok:boolean, count?:number, total?:number, error?:string}>}
   */
  async pushSource(source) {
    const config = this.store.loadConfig()
    const notify = config.notify ?? {}
    if (notify.enabled !== true) return null
    const hasTarget = notify.dshImTargetId !== '' || (notify.dshImDraft !== null && notify.dshImDraft !== undefined)
    if (notify.dshImBotId === '' || !hasTarget) {
      this.log('[radar] 已开启推送，但还没选机器人或投递目标，跳过')
      return { ok: false, error: '还没选机器人或投递目标' }
    }
    const state = this.store.loadState()
    const candidates = this.store
      .loadItems()
      .filter((item) => item.sourceId === source.id)
      .filter((item) => typeof item.pushedAt !== 'string' || item.pushedAt === '')
      .filter((item) => !isItemRead(state, item))
      .sort((left, right) => Number(left.seq) - Number(right.seq))
    if (candidates.length === 0) return null

    const batch = candidates.slice(0, MAX_PUSH_ITEMS)
    await this.ensureSummaries(batch)

    const text = composePushText({
      sourceName: source.name,
      items: batch,
      totalCount: candidates.length,
      // 全部展开，不做「其余 N 条」折叠——用户要看到每一条
      maxEntries: batch.length,
      // 末尾引导语，可配置；默认给一句「有什么看不懂的可以问我」
      hint: typeof notify.pushHint === 'string' ? notify.pushHint : undefined,
    })

    const result = await sendViaDshIm({
      ctx: this.ctx,
      origin: this.origin,
      botId: notify.dshImBotId,
      targetId: notify.dshImTargetId,
      draft: notify.dshImDraft ?? null,
      text,
    })
    if (!result.ok) {
      this.log(`[radar] 推送失败（dsh-im）：${result.error}`)
      return { ok: false, error: result.error }
    }

    // 发送成功才打标记；失败下轮还会重试
    const pushedAt = new Date().toISOString()
    const ids = new Set(batch.map((item) => item.id))
    const records = this.store.loadItems()
    for (const record of records) {
      if (ids.has(record.id)) record.pushedAt = pushedAt
    }
    this.store.rewriteItems(records)

    // 推送即已读：可选。开启后刚推出去的条目在面板里不再算未读。
    let markedRead = 0
    if (notify.autoMarkRead === true) {
      const readIds = new Set(state.readIds ?? [])
      for (const id of ids) {
        readIds.add(id)
        markedRead += 1
      }
      state.readIds = [...readIds]
      this.store.saveState(state)
    }
    return { ok: true, count: batch.length, total: candidates.length, markedRead }
  }

  /**
   * 把当前所有「未读且没推过」的积压推出去（每个源一条消息）。
   *
   * 心跳每次抓完都会调它，所以就算推送开关是后开的、或者之前一直在失败，
   * 积压也会在下一个心跳补发；面板上的「推送未读」按钮走的也是这里。
   */
  async flushPendingPushes({ sourceId = '', maxMessages = 3 } = {}) {
    const config = this.store.loadConfig()
    if (config.notify?.enabled !== true) return { skipped: 'disabled', messages: [] }
    const sources = config.sources.filter(
      (source) => source.enabled && (sourceId === '' || source.id === sourceId),
    )
    const messages = []
    for (const source of sources) {
      if (messages.length >= maxMessages) break
      const result = await this.pushSource(source)
      if (result === null) continue
      messages.push({ sourceId: source.id, sourceName: source.name, ...result })
      // 失败了就停，别拿同一个坏目标把剩下几个源都试一遍
      if (result.ok !== true) break
    }
    return { messages }
  }
}
