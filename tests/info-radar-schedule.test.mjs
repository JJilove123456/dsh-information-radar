import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampIntervalMinutes,
  slotOf,
  nextBoundaryOf,
  evaluateDue,
  describeRemaining,
  parseAnchor,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
} from '../lib/schedule.js'

const MIN = 60 * 1000
const DAY = 24 * 60 * MIN

test('间隔夹取：范围 1 分钟到 365 天', () => {
  assert.equal(clampIntervalMinutes(0), 1440)
  assert.equal(clampIntervalMinutes(-5), 1440)
  assert.equal(clampIntervalMinutes(0.1), 1)
  assert.equal(clampIntervalMinutes(1), 1)
  assert.equal(clampIntervalMinutes(1440), 1440)
  assert.equal(clampIntervalMinutes(525600), 525600)
  assert.equal(clampIntervalMinutes(999999), 525600)
  assert.equal(clampIntervalMinutes('abc'), 1440)
})

test('常量与范围一致', () => {
  assert.equal(MIN_INTERVAL_MS, MIN)
  assert.equal(MAX_INTERVAL_MS, 365 * DAY)
  assert.equal(DEFAULT_INTERVAL_MS, DAY)
})

test('期号：锚点起点当期为 0', () => {
  const anchor = Date.parse('2026-10-26T20:00:00+08:00')
  assert.equal(slotOf(anchor, DAY, anchor), 0)
  assert.equal(slotOf(anchor, DAY, anchor + DAY - 1), 0)
  assert.equal(slotOf(anchor, DAY, anchor + DAY), 1)
  assert.equal(slotOf(anchor, DAY, anchor + 3 * DAY + 5), 3)
})

test('期号：锚点在将来为负', () => {
  const anchor = Date.parse('2026-12-01T00:00:00+08:00')
  const now = Date.parse('2026-10-26T20:00:00+08:00')
  assert.ok(slotOf(anchor, DAY, now) < 0)
})

test('无边界：1 分钟间隔每分钟前进一期', () => {
  const anchor = 0
  assert.equal(slotOf(anchor, MIN, 59 * 1000), 0)
  assert.equal(slotOf(anchor, MIN, 60 * 1000), 1)
  assert.equal(slotOf(anchor, MIN, 61 * 1000), 1)
})

test('下一期边界', () => {
  const anchor = 0
  assert.equal(nextBoundaryOf(anchor, DAY, 0), DAY)
  assert.equal(nextBoundaryOf(anchor, DAY, DAY), 2 * DAY)
  assert.equal(nextBoundaryOf(anchor, DAY, DAY + 1), 2 * DAY)
})

test('到期判定：新一期要抓', () => {
  const anchor = 0
  const res = evaluateDue({ anchorMs: anchor, intervalMs: DAY, nowMs: DAY + 1, lastSlot: 0 })
  assert.equal(res.due, true)
  assert.equal(res.slot, 1)
  assert.equal(res.reason, 'new-slot')
  assert.equal(res.nextAtMs, 2 * DAY)
})

test('到期判定：当期抓过就不再抓', () => {
  const anchor = 0
  const res = evaluateDue({ anchorMs: anchor, intervalMs: DAY, nowMs: DAY + 5, lastSlot: 1 })
  assert.equal(res.due, false)
  assert.equal(res.reason, 'already-ran-this-slot')
})

test('到期判定：跨过多期只抓一次', () => {
  const anchor = 0
  // 关机 30 天，lastSlot 停在 1，现在在第 31 期
  const res = evaluateDue({ anchorMs: anchor, intervalMs: DAY, nowMs: 31 * DAY, lastSlot: 1 })
  assert.equal(res.due, true)
  assert.equal(res.slot, 31)
})

test('到期判定：锚点在将来不抓', () => {
  const anchor = 10 * DAY
  const res = evaluateDue({ anchorMs: anchor, intervalMs: DAY, nowMs: DAY, lastSlot: null })
  assert.equal(res.due, false)
  assert.equal(res.reason, 'before-anchor')
  assert.equal(res.nextAtMs, anchor)
})

test('到期判定：系统时间回拨不抓', () => {
  const anchor = 0
  const res = evaluateDue({ anchorMs: anchor, intervalMs: DAY, nowMs: DAY, lastSlot: 5 })
  assert.equal(res.due, false)
  assert.equal(res.reason, 'clock-moved-back')
  assert.equal(res.nextAtMs, 6 * DAY)
})

test('到期判定：首次运行（lastSlot 为 null）在第 0 期会抓', () => {
  const anchor = 0
  const res = evaluateDue({ anchorMs: anchor, intervalMs: DAY, nowMs: 1000, lastSlot: null })
  assert.equal(res.due, true)
  assert.equal(res.slot, 0)
})

test('到期判定：非法输入不抓', () => {
  assert.equal(evaluateDue({ anchorMs: NaN, intervalMs: DAY, nowMs: 0, lastSlot: null }).due, false)
  assert.equal(evaluateDue({ anchorMs: 0, intervalMs: 0, nowMs: 0, lastSlot: null }).due, false)
})

test('锚点解析', () => {
  assert.equal(parseAnchor(12345, 0), 12345)
  assert.equal(parseAnchor('2026-10-26T20:00:00+08:00', 0), Date.parse('2026-10-26T20:00:00+08:00'))
  assert.equal(parseAnchor('', 777), 777)
  assert.equal(parseAnchor(null, 777), 777)
  assert.equal(parseAnchor('not-a-date', 777), 777)
})

test('剩余时间描述', () => {
  const now = 0
  // 已过期或刚好到期
  assert.equal(describeRemaining(0, now), '即将开始')
  assert.equal(describeRemaining(-1, now), '即将开始')
  // 30 秒向上取整为 1 分钟
  assert.equal(describeRemaining(30 * 1000, now), '1 分钟后')
  assert.equal(describeRemaining(30 * MIN, now), '30 分钟后')
  assert.equal(describeRemaining(3 * DAY, now), '3 天后')
  assert.equal(describeRemaining(NaN, now), '—')
})

