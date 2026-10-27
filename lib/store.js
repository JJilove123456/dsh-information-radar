/**
 * 持久化：配置、条目、已读状态、快照。
 *
 * 布局（默认在 ~/.dsh/info-radar/）：
 *   config.json    源列表与全局设置
 *   items.jsonl    命中条目，追加写
 *   state.json     未读游标、每个源的 lastSlot / 状态
 *   snapshots/     正文快照，按内容键命名
 *
 * 写入全部走「临时文件 + rename」，避免半截 JSON。
 * 任何读取失败都退化为空结构，不让一个坏文件把整个面板打挂。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export const CONFIG_VERSION = 1
export const STATE_VERSION = 1
export const MAX_ITEMS = 500
export const MAX_SEEN_KEYS = 5000
export const SEEN_RETENTION_DAYS = 90
export const MAX_SNAPSHOT_BYTES = 200 * 1024
export const MAX_SNAPSHOT_TOTAL_BYTES = 500 * 1024 * 1024
/** 推送消息末尾的默认引导语。 */
export const DEFAULT_PUSH_HINT = '有什么看不懂的可以问我'

/** 原子写 JSON。 */
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

function readJsonSafe(path, fallback) {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

/** 数据目录。 */
export function resolveDataDir(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  return join(home, 'info-radar')
}

/** 归一化一个源对象；字段缺失或类型不对时用安全默认值。 */
export function normalizeSource(raw, index) {
  const now = Date.now()
  const id = typeof raw?.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(raw.id) ? raw.id : `src-${index + 1}-${now.toString(36)}`
  const url = typeof raw?.url === 'string' ? raw.url.trim() : ''
  const intervalRaw = Number(raw?.intervalMinutes)
  return {
    id,
    name: typeof raw?.name === 'string' && raw.name.trim() !== '' ? raw.name.trim().slice(0, 80) : url.replace(/^https?:\/\//u, '').slice(0, 80),
    url,
    enabled: raw?.enabled !== false,
    intervalMinutes: Number.isFinite(intervalRaw) && intervalRaw > 0 ? Math.round(intervalRaw) : null,
    selector: typeof raw?.selector === 'string' ? raw.selector.trim().slice(0, 200) : '',
    includeKeywords: Array.isArray(raw?.includeKeywords)
      ? raw.includeKeywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 30)
      : [],
    excludeKeywords: Array.isArray(raw?.excludeKeywords)
      ? raw.excludeKeywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 30)
      : [],
    hasHeaders: raw?.hasHeaders === true,
    baselineOnly: raw?.baselineOnly !== false,
    // 翻页：默认开启，最多翻 5 页；追上已读时间线就停
    followPages: raw?.followPages !== false,
    maxPages: Number.isFinite(Number(raw?.maxPages)) ? Math.max(1, Math.min(20, Number(raw.maxPages))) : 5,
    // 递归深度：详情页 → 子网页 → 孙网页，默认 2 层
    depth: Number.isFinite(Number(raw?.depth)) ? Math.max(0, Math.min(3, Number(raw.depth))) : 2,
    // 允许私网地址：仅供本机测试站使用，默认关闭
    allowPrivate: raw?.allowPrivate === true,
  }
}

/** 归一化一个「临时投递目标」：`{kind, route}`，route 只保留字符串/数字字段。 */
export function normalizeDraftTarget(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const kind = typeof raw.kind === 'string' ? raw.kind.trim().slice(0, 32) : ''
  if (kind === '') return null
  const route = raw.route !== null && typeof raw.route === 'object' ? raw.route : null
  if (route === null) return null
  const clean = {}
  for (const [key, value] of Object.entries(route)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/u.test(key)) continue
    if (Object.keys(clean).length >= 4) break
    if (typeof value === 'string' && value.trim() !== '' && value.length <= 512) clean[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value
  }
  if (Object.keys(clean).length === 0) return null
  return {
    kind,
    route: clean,
    label: typeof raw.label === 'string' ? raw.label.trim().slice(0, 120) : '',
  }
}

/** 归一化配置。 */
export function normalizeConfig(raw) {
  const intervalRaw = Number(raw?.globalIntervalMinutes)
  const cleanupRaw = Number(raw?.cleanupReadIntervalMinutes)
  return {
    version: CONFIG_VERSION,
    globalIntervalMinutes: Number.isFinite(intervalRaw) && intervalRaw > 0 ? Math.round(intervalRaw) : 1440,
    anchor: typeof raw?.anchor === 'string' ? raw.anchor : new Date().toISOString(),
    paused: raw?.paused === true,
    maxEntriesPerRun: Number.isFinite(Number(raw?.maxEntriesPerRun)) ? Math.max(1, Math.min(50, Number(raw.maxEntriesPerRun))) : 19,
    // 已读条目的定期清理：0 表示不清理
    cleanupReadEnabled: raw?.cleanupReadEnabled === true,
    cleanupReadIntervalMinutes: Number.isFinite(cleanupRaw) && cleanupRaw > 0 ? Math.round(cleanupRaw) : 10080,
    /**
     * 测试期模式。
     *
     * 平时（false）：首次抓取只建基线，原有内容不入库，只有真正更新才出现。
     * 测试期（true）：跳过基线，直接把当前页面上的内容抓进来，方便立刻看到效果。
     * 用户「测试完了」之后应改回 false。
     */
    testMode: raw?.testMode === true,
    notify: {
      // 推送整体是可选项，默认关闭
      enabled: raw?.notify?.enabled === true,
      // 通过已装的 DSH-IM 机器人投递：机器人 id + 投递目标 id
      dshImBotId: typeof raw?.notify?.dshImBotId === 'string' ? raw.notify.dshImBotId.trim() : '',
      dshImTargetId: typeof raw?.notify?.dshImTargetId === 'string' ? raw.notify.dshImTargetId.trim() : '',
      // 没有保存目标时的兜底：直接用一条会话路由投递（kind + route）
      dshImDraft: normalizeDraftTarget(raw?.notify?.dshImDraft),
      // 推送末尾的引导语；空字符串表示不加
      pushHint: typeof raw?.notify?.pushHint === 'string' ? raw.notify.pushHint.slice(0, 200) : DEFAULT_PUSH_HINT,
      // 推送出去的条目是否自动标为已读（默认否：推了也留在面板里等用户点开）
      autoMarkRead: raw?.notify?.autoMarkRead === true,
    },
    sources: Array.isArray(raw?.sources) ? raw.sources.map(normalizeSource) : [],
  }
}

export class Store {
  constructor(dir) {
    this.dir = dir
    this.configPath = join(dir, 'config.json')
    this.itemsPath = join(dir, 'items.jsonl')
    this.statePath = join(dir, 'state.json')
    this.snapshotDir = join(dir, 'snapshots')
    mkdirSync(this.snapshotDir, { recursive: true })
  }

  loadConfig() {
    return normalizeConfig(readJsonSafe(this.configPath, {}))
  }

  saveConfig(config) {
    const normalized = normalizeConfig(config)
    writeJsonAtomic(this.configPath, normalized)
    return normalized
  }

  /** 已读游标 + 每个源的运行状态。 */
  loadState() {
    const raw = readJsonSafe(this.statePath, {})
    return {
      version: STATE_VERSION,
      readSeq: Number.isFinite(Number(raw?.readSeq)) ? Number(raw.readSeq) : 0,
      // 逐条已读：点开过详情或原文的条目 id
      readIds: Array.isArray(raw?.readIds) ? raw.readIds.filter((id) => typeof id === 'string') : [],
      readAt: raw?.readAt !== null && typeof raw?.readAt === 'object' ? raw.readAt : {},
      sources: raw?.sources !== null && typeof raw?.sources === 'object' ? raw.sources : {},
      seenKeys: Array.isArray(raw?.seenKeys) ? raw.seenKeys.filter((entry) => Array.isArray(entry)) : [],
      lastPushSlot: raw?.lastPushSlot !== null && typeof raw?.lastPushSlot === 'object' ? raw.lastPushSlot : {},
      lastCleanupAt: typeof raw?.lastCleanupAt === 'string' ? raw.lastCleanupAt : null,
    }
  }

  saveState(state) {
    writeJsonAtomic(this.statePath, state)
    return state
  }

  /** 读条目；坏行跳过，不因为一行损坏丢掉整个列表。 */
  loadItems() {
    if (!existsSync(this.itemsPath)) return []
    let raw
    try {
      raw = readFileSync(this.itemsPath, 'utf8')
    } catch {
      return []
    }
    const items = []
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.id === 'string') items.push(parsed)
      } catch {
        /* 坏行跳过 */
      }
    }
    return items
  }

  /** 追加一条；超过上限时重写成最近 MAX_ITEMS 条。 */
  appendItem(item) {
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(this.itemsPath, `${JSON.stringify(item)}\n`, 'utf8')
    const items = this.loadItems()
    if (items.length > MAX_ITEMS) {
      const kept = items.slice(-MAX_ITEMS)
      const temp = `${this.itemsPath}.tmp-${process.pid}`
      writeFileSync(temp, kept.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
      renameSync(temp, this.itemsPath)
      return kept
    }
    return items
  }

  /** 正文快照：按内容键存，单条上限 200KB。 */
  saveSnapshot(key, text) {
    const safeKey = String(key).replace(/[^A-Za-z0-9_-]/gu, '')
    if (safeKey.length < 8) return null
    const body = String(text).slice(0, MAX_SNAPSHOT_BYTES)
    const path = join(this.snapshotDir, `${safeKey}.txt`)
    try {
      mkdirSync(this.snapshotDir, { recursive: true })
      writeFileSync(path, body, 'utf8')
      return path
    } catch {
      return null
    }
  }

  readSnapshot(key) {
    const safeKey = String(key).replace(/[^A-Za-z0-9_-]/gu, '')
    try {
      return readFileSync(join(this.snapshotDir, `${safeKey}.txt`), 'utf8')
    } catch {
      return null
    }
  }

  /** 快照总量超限时按最旧淘汰。 */
  pruneSnapshots(limitBytes = MAX_SNAPSHOT_TOTAL_BYTES) {
    let names
    try {
      names = readdirSync(this.snapshotDir).filter((name) => name.endsWith('.txt'))
    } catch {
      return 0
    }
    const stats = []
    let total = 0
    for (const name of names) {
      const path = join(this.snapshotDir, name)
      try {
        const info = statSync(path)
        stats.push({ path, size: info.size, mtime: info.mtimeMs })
        total += info.size
      } catch {
        /* 跳过 */
      }
    }
    if (total <= limitBytes) return 0
    stats.sort((left, right) => left.mtime - right.mtime)
    let removed = 0
    for (const entry of stats) {
      if (total <= limitBytes) break
      try {
        unlinkSync(entry.path)
        total -= entry.size
        removed += 1
      } catch {
        /* 跳过 */
      }
    }
    return removed
  }

  /** 清空条目文件（保留配置与 Cookie）。 */
  clearItems() {
    try {
      rmSync(this.itemsPath, { force: true })
    } catch {
      /* 文件不存在时忽略 */
    }
  }

  /**
   * 整体重写条目文件（改摘要时用）。
   * @returns {Array} 写入后的条目
   */
  rewriteItems(items) {
    const list = Array.isArray(items) ? items : []
    mkdirSync(this.dir, { recursive: true })
    const temp = `${this.itemsPath}.tmp-${process.pid}`
    writeFileSync(temp, list.map((entry) => JSON.stringify(entry)).join('\n') + (list.length > 0 ? '\n' : ''), 'utf8')
    renameSync(temp, this.itemsPath)
    return list
  }

  /**
   * 删除指定条目并重写文件。
   * @returns {number} 实际删除条数
   */
  removeItems(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0
    const drop = new Set(ids)
    const items = this.loadItems()
    const kept = items.filter((item) => !drop.has(item.id))
    const removed = items.length - kept.length
    if (removed === 0) return 0
    mkdirSync(this.dir, { recursive: true })
    const temp = `${this.itemsPath}.tmp-${process.pid}`
    writeFileSync(temp, kept.map((entry) => JSON.stringify(entry)).join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8')
    renameSync(temp, this.itemsPath)
    return removed
  }

  /** 删除单份快照。 */
  clearSnapshotsByKey(key) {
    const safeKey = String(key).replace(/[^A-Za-z0-9_-]/gu, '')
    if (safeKey.length < 8) return false
    try {
      unlinkSync(join(this.snapshotDir, `${safeKey}.txt`))
      return true
    } catch {
      return false
    }
  }

  /** 清空全部正文快照。 */
  clearSnapshots() {
    let names
    try {
      names = readdirSync(this.snapshotDir).filter((name) => name.endsWith('.txt'))
    } catch {
      return 0
    }
    let removed = 0
    for (const name of names) {
      try {
        unlinkSync(join(this.snapshotDir, name))
        removed += 1
      } catch {
        /* 跳过 */
      }
    }
    return removed
  }

  /** 清空全部数据（卸载前用户主动清理时用）。 */
  clearAll() {
    try {
      rmSync(this.dir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
    mkdirSync(this.snapshotDir, { recursive: true })
  }
}

/** 内容键：url + 文本的 sha256 前 24 位。 */
export async function contentKeyOf(url, text) {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(`${url}\u0000${String(text)}`).digest('hex').slice(0, 24)
}

/** 保留 90 天内的键，其余淘汰；上限 MAX_SEEN_KEYS。 */
export function pruneSeenKeys(seenKeys, nowMs) {
  const cutoff = nowMs - SEEN_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const fresh = seenKeys.filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && Number(entry[1]) >= cutoff)
  return fresh.length > MAX_SEEN_KEYS ? fresh.slice(-MAX_SEEN_KEYS) : fresh
}


