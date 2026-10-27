/**
 * 时长拆分/合并的逻辑测试。
 * client.js 里这两段是纯函数，拷同一份实现来测，避免为了测试去加载整个客户端模块。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

function splitDuration(totalMinutes) {
  const total = Math.max(0, Math.round(Number(totalMinutes) || 0))
  return {
    days: Math.floor(total / 1440),
    hours: Math.floor((total % 1440) / 60),
    minutes: total % 60,
  }
}

function joinDuration(parts) {
  const days = Number(parts.days)
  const hours = Number(parts.hours)
  const minutes = Number(parts.minutes)
  if (![days, hours, minutes].every((value) => Number.isFinite(value) && value >= 0)) return null
  return days * 1440 + hours * 60 + minutes
}

test('拆分：常见间隔', () => {
  assert.deepEqual(splitDuration(1), { days: 0, hours: 0, minutes: 1 })
  assert.deepEqual(splitDuration(60), { days: 0, hours: 1, minutes: 0 })
  assert.deepEqual(splitDuration(90), { days: 0, hours: 1, minutes: 30 })
  assert.deepEqual(splitDuration(1440), { days: 1, hours: 0, minutes: 0 })
  assert.deepEqual(splitDuration(3060), { days: 2, hours: 3, minutes: 0 })
  assert.deepEqual(splitDuration(525600), { days: 365, hours: 0, minutes: 0 })
})

test('拆分：零与非法值归零', () => {
  assert.deepEqual(splitDuration(0), { days: 0, hours: 0, minutes: 0 })
  assert.deepEqual(splitDuration(null), { days: 0, hours: 0, minutes: 0 })
  assert.deepEqual(splitDuration('abc'), { days: 0, hours: 0, minutes: 0 })
  assert.deepEqual(splitDuration(-5), { days: 0, hours: 0, minutes: 0 })
})

test('合并：三段相加', () => {
  assert.equal(joinDuration({ days: 0, hours: 0, minutes: 1 }), 1)
  assert.equal(joinDuration({ days: 1, hours: 0, minutes: 0 }), 1440)
  assert.equal(joinDuration({ days: 2, hours: 3, minutes: 0 }), 3060)
  assert.equal(joinDuration({ days: 0, hours: 23, minutes: 59 }), 1439)
  assert.equal(joinDuration({ days: 365, hours: 0, minutes: 0 }), 525600)
  assert.equal(joinDuration({ days: 0, hours: 0, minutes: 0 }), 0)
})

test('合并：负数或非数字返回 null', () => {
  assert.equal(joinDuration({ days: -1, hours: 0, minutes: 0 }), null)
  assert.equal(joinDuration({ days: 0, hours: 'x', minutes: 0 }), null)
})

test('往返：拆了再合并等于原值', () => {
  for (const value of [1, 5, 30, 60, 90, 120, 1440, 1500, 2880, 3060, 10080, 43200, 525600]) {
    const parts = splitDuration(value)
    assert.equal(joinDuration(parts), value, `${value} 往返失败`)
  }
})

