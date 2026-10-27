/**
 * 锚点周期计算。
 *
 * 设计要点：
 * - 不存 nextDueAt，只存 anchor + interval + lastSlot。改间隔、改锚点都不需要迁移历史数据。
 * - 期号 slot = floor((now - anchor) / interval)。这一期没抓过（lastSlot < slot）才抓。
 * - 心跳每 30 秒算一次，所以 1 分钟到 365 天都在同一套逻辑里，
 *   不会撞上 Node 单定时器 2^31-1 毫秒（约 24.8 天）的上限。
 * - 关机跨过很多期时不逐期补跑：恢复后只抓一次，lastSlot 直接跳到当前期。
 *   需要补的内容由「内容键去重」负责，不靠期次回放。
 */

export const MIN_INTERVAL_MS = 60 * 1000
export const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000
export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000
export const HEARTBEAT_MS = 30 * 1000

/** 把用户输入的分钟数夹到合法区间；非法值退回默认。 */
export function clampIntervalMinutes(minutes) {
  const value = Number(minutes)
  if (!Number.isFinite(value) || value <= 0) return Math.round(DEFAULT_INTERVAL_MS / 60000)
  const ms = Math.round(value * 60 * 1000)
  return Math.round(Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, ms)) / 60000)
}

/** 解析锚点：接受 ISO 字符串或毫秒数；非法时退回 now。 */
export function parseAnchor(value, nowMs) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return nowMs
}

/**
 * 当前期号。锚点在将来时为负数，表示「还没开始」。
 * @returns {number|null} 输入非法时返回 null
 */
export function slotOf(anchorMs, intervalMs, nowMs) {
  if (!Number.isFinite(anchorMs) || !Number.isFinite(intervalMs) || !Number.isFinite(nowMs)) return null
  if (intervalMs <= 0) return null
  return Math.floor((nowMs - anchorMs) / intervalMs)
}

/** 下一期的起始时刻（毫秒）。 */
export function nextBoundaryOf(anchorMs, intervalMs, nowMs) {
  const slot = slotOf(anchorMs, intervalMs, nowMs)
  if (slot === null) return null
  return anchorMs + (slot + 1) * intervalMs
}

/**
 * 判断一个源这一期该不该抓。
 *
 * @param {object} input
 * @param {number} input.anchorMs 锚点
 * @param {number} input.intervalMs 该源生效的间隔
 * @param {number} input.nowMs 当前时刻
 * @param {number|null} input.lastSlot 该源上次抓取所属期号
 * @returns {{due:boolean, slot:number|null, reason:string, nextAtMs:number|null}}
 */
export function evaluateDue({ anchorMs, intervalMs, nowMs, lastSlot }) {
  const slot = slotOf(anchorMs, intervalMs, nowMs)
  if (slot === null) return { due: false, slot: null, reason: 'bad-config', nextAtMs: null }
  // 锚点在将来：还没开始计次。
  if (slot < 0) return { due: false, slot, reason: 'before-anchor', nextAtMs: anchorMs }
  const last = Number.isFinite(lastSlot) ? lastSlot : -1
  // 系统时间被调回过去：期号倒退，不抓，等时间追上来。
  if (slot < last) return { due: false, slot, reason: 'clock-moved-back', nextAtMs: anchorMs + (last + 1) * intervalMs }
  if (slot === last) return { due: false, slot, reason: 'already-ran-this-slot', nextAtMs: anchorMs + (slot + 1) * intervalMs }
  return { due: true, slot, reason: 'new-slot', nextAtMs: anchorMs + (slot + 1) * intervalMs }
}

/** 人类可读的剩余时间，用于面板展示。 */
export function describeRemaining(nextAtMs, nowMs) {
  if (!Number.isFinite(nextAtMs)) return '—'
  const left = nextAtMs - nowMs
  if (left <= 0) return '即将开始'
  const totalMinutes = Math.ceil(left / 60000)
  if (totalMinutes < 60) return `${totalMinutes} 分钟后`
  const hours = Math.floor(totalMinutes / 60)
  if (hours < 48) return `${hours} 小时后`
  return `${Math.floor(hours / 24)} 天后`
}
