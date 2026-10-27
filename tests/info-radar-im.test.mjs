/**
 * IM 联动测试：通道探测、dsh-im 发送、OneBot 发送、配置归一化。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectDshIm, listDshImTargets, sendViaDshIm, CHANNELS } from '../lib/deliver.js'
import { Store, normalizeConfig } from '../lib/store.js'

function makeCtx(dshIm) {
  return {
    get(name) {
      if (name === 'dshIm') return dshIm
      return undefined
    },
  }
}

test('通道清单只保留两种状态', () => {
  assert.deepEqual(CHANNELS.map((c) => c.id), ['none', 'dshIm'])
})

test('探测：同 Host 服务可用时优先用服务', async () => {
  const ctx = makeCtx({
    async listBots() {
      return [{ botId: 'bot_1', channel: 'qq' }]
    },
    async send() {
      return { sent: true }
    },
  })
  const info = await detectDshIm(ctx, 'http://127.0.0.1:9999')
  assert.equal(info.available, true)
  assert.equal(info.via, 'service')
  assert.equal(info.bots.length, 1)
})

test('探测：没有服务也没有地址时判定未安装', async () => {
  const info = await detectDshIm(makeCtx(undefined), '')
  assert.equal(info.available, false)
  assert.ok(/没有安装|没有找到/u.test(info.error ?? ''))
})

test('探测：HTTP 路由存在时判定可用', async () => {
  const server = createServer((req, res) => {
    // 模拟 dsh-im：缺参数返回 400
    res.writeHead(400)
    res.end('missing botId')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const info = await detectDshIm(makeCtx(undefined), base)
    assert.equal(info.available, true)
    assert.equal(info.via, 'http')
  } finally {
    server.close()
  }
})

test('探测：HTTP 404 判定未安装', async () => {
  const server = createServer((req, res) => {
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const info = await detectDshIm(makeCtx(undefined), base)
    assert.equal(info.available, false)
  } finally {
    server.close()
  }
})

test('发送：通过服务成功', async () => {
  let captured = null
  const ctx = makeCtx({
    async send(botId, targetId, text) {
      captured = { botId, targetId, text }
      return { sent: true }
    },
  })
  const result = await sendViaDshIm({ ctx, origin: '', botId: 'b1', targetId: 't1', text: '你好' })
  assert.equal(result.ok, true)
  assert.equal(result.via, 'service')
  assert.deepEqual(captured, { botId: 'b1', targetId: 't1', text: '你好' })
})

test('发送：服务抛错时返回失败原因', async () => {
  const ctx = makeCtx({
    async send() {
      throw new Error('bot 未连接')
    },
  })
  const result = await sendViaDshIm({ ctx, origin: '', botId: 'b1', targetId: 't1', text: 'x' })
  assert.equal(result.ok, false)
  assert.ok(/未连接/u.test(result.error))
})

test('发送：HTTP 回退成功', async () => {
  let body = null
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      body = JSON.parse(raw)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ sent: true }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const result = await sendViaDshIm({
      ctx: makeCtx(undefined),
      origin: base,
      botId: 'b1',
      targetId: 't1',
      text: '推送内容',
    })
    assert.equal(result.ok, true)
    assert.equal(result.via, 'http')
    assert.equal(body.botId, 'b1')
    assert.equal(body.targetId, 't1')
    assert.equal(body.text, '推送内容')
  } finally {
    server.close()
  }
})

test('发送：HTTP 非 200 返回失败', async () => {
  const server = createServer((req, res) => {
    res.writeHead(500)
    res.end('boom')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const result = await sendViaDshIm({ ctx: makeCtx(undefined), origin: base, botId: 'b1', targetId: 't1', text: 'x' })
    assert.equal(result.ok, false)
    assert.ok(/500/u.test(result.error))
  } finally {
    server.close()
  }
})

test('发送：既无服务也无地址时明确报错', async () => {
  const result = await sendViaDshIm({ ctx: makeCtx(undefined), origin: '', botId: 'b1', targetId: 't1', text: 'x' })
  assert.equal(result.ok, false)
  assert.ok(/没有可用/u.test(result.error))
})

test('列目标：没有服务时返回失败而不是抛错', async () => {
  const result = await listDshImTargets(makeCtx(undefined), 'b1')
  assert.equal(result.ok, false)
  assert.deepEqual(result.targets, [])
})

test('列目标：有服务时返回列表', async () => {
  const ctx = makeCtx({
    async listTargets() {
      return [{ targetId: 'release-alerts', name: '发布告警', kind: 'group' }]
    },
  })
  const result = await listDshImTargets(ctx, 'b1')
  assert.equal(result.ok, true)
  assert.equal(result.targets.length, 1)
})

test('配置：IM 参数归一化', () => {
  const config = normalizeConfig({
    notify: { enabled: true, dshImBotId: 'bot_x', dshImTargetId: 'tgt_y' },
  })
  assert.equal(config.notify.dshImBotId, 'bot_x')
  assert.equal(config.notify.dshImTargetId, 'tgt_y')
  assert.equal(config.notify.enabled, true)
})

test('配置：推送默认关闭', () => {
  const config = normalizeConfig({})
  assert.equal(config.notify.enabled, false)
  assert.equal(config.notify.dshImBotId, '')
  assert.equal(config.notify.dshImTargetId, '')
})

test('配置：老配置里的 OneBot 字段被忽略', () => {
  const config = normalizeConfig({
    notify: { enabled: true, channel: 'onebot', oneBotUrl: 'http://127.0.0.1:3000', targetId: '10001' },
  })
  // 新结构不再保留这些字段
  assert.equal(config.notify.oneBotUrl, undefined)
  assert.equal(config.notify.targetId, undefined)
  assert.equal(config.notify.channel, undefined)
})

test('store：保存后能读回 IM 通道配置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-im-'))
  try {
    const store = new Store(dir)
    store.saveConfig({
      notify: { enabled: true, dshImBotId: 'b9', dshImTargetId: 't9' },
      sources: [],
    })
    const loaded = store.loadConfig()
    assert.equal(loaded.notify.dshImBotId, 'b9')
    assert.equal(loaded.notify.dshImBotId, 'b9')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})



