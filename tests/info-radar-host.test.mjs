/**
 * 宿主半集成测试：伪造 ctx 与 webServer，真实起 HTTP 服务打端点。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

/** 收集 apply 注册的路由。 */
function makeHost({ dataDir }) {
  const routes = new Map()
  const disposers = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get(name) {
      if (name === 'webServer') return { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } }
      if (name === 'web') {
        return {
          async fetch({ url }) {
            return { url, statusCode: 200, body: { kind: 'html', content: '<p>测试内容足够长的段落在这里</p>' }, truncated: false }
          },
        }
      }
      if (name === 'llm') {
        return {
          stream: () => (async function* () {
            yield { type: 'text-delta', text: '摘要' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })(),
        }
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
    effect(callback) {
      const disposer = callback()
      disposers.push(disposer)
      return disposer
    },
    // 真实 Cordis ctx 有 inject：等服务就绪后再执行回调。
    // 测试里的服务同步就绪，立即回调即可，但要把 scope.effect 也接上。
    inject(_names, callback) {
      const scope = {
        get: (name) => ctx.get(name),
        effect: (fn) => ctx.effect(fn),
      }
      const result = callback(scope)
      if (typeof result === 'function') disposers.push(result)
      return () => {}
    },
  }
  apply(ctx, { dataDir, defaultIntervalMinutes: 1440 })
  /** 卸载：清理定时器，否则测试进程会一直挂着。 */
  const dispose = () => {
    for (const disposer of disposers) {
      try {
        if (typeof disposer === 'function') disposer()
      } catch {
        /* 忽略 */
      }
    }
  }
  return { ctx, routes, dispose }
}

function startApi(routes) {
  const server = createServer(async (req, res) => {
    const path = req.url.split('?')[0]
    const route = routes.get(path)
    if (route === undefined) {
      res.writeHead(404)
      res.end('no route')
      return
    }
    await route.handler(req, res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

async function callJson(base, path, options) {
  const response = await fetch(`${base}${path}`, options)
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

const post = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
})

test('端点：注册了全部 10 条路由', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-host-'))
  let dispose = () => {}
  try {
    const host = makeHost({ dataDir: dir })
    dispose = host.dispose
    const expected = [
      'status',
      'config',
      'run',
      'read',
      'summarize',
      'summarize-all',
      'cookie',
      'source-action',
      'im-status',
      'im-test',
      'clear',
    ]
    for (const name of expected) {
      assert.ok(host.routes.has(`/api/dsh-info-radar/${name}`), `缺少 ${name} 路由`)
    }
    // OneBot 通道已移除
    assert.equal(host.routes.has('/api/dsh-info-radar/onebot-test'), false, 'onebot-test 不应再注册')
  } finally {
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端点：GET /status 返回初始结构', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-host-'))
  const { routes, dispose } = makeHost({ dataDir: dir })
  const { server, base } = await startApi(routes)
  try {
    const res = await callJson(base, '/api/dsh-info-radar/status')
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.unread, 0)
    assert.equal(res.json.needsCookie, 0)
    assert.deepEqual(res.json.sources, [])
    assert.ok(Array.isArray(res.json.items))
    assert.equal(res.json.config.globalIntervalMinutes, 1440)
  } finally {
    server.close()
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端点：保存配置并回读', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-host-'))
  const { routes, dispose } = makeHost({ dataDir: dir })
  const { server, base } = await startApi(routes)
  try {
    const status = await callJson(base, '/api/dsh-info-radar/status')
    const config = {
      ...status.json.config,
      globalIntervalMinutes: 30,
      sources: [{ id: 's1', name: '测试源', url: 'https://example.com/news', selector: '#list', includeKeywords: ['AI'], excludeKeywords: [] }],
    }
    const saved = await callJson(base, '/api/dsh-info-radar/config', post({ config }))
    assert.equal(saved.status, 200)
    assert.equal(saved.json.config.globalIntervalMinutes, 30)
    assert.equal(saved.json.config.sources.length, 1)

    const again = await callJson(base, '/api/dsh-info-radar/status')
    assert.equal(again.json.sources.length, 1)
    assert.equal(again.json.sources[0].name, '测试源')
    assert.equal(again.json.sources[0].hasCookie, false)
  } finally {
    server.close()
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端点：非法网址被拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-host-'))
  const { routes, dispose } = makeHost({ dataDir: dir })
  const { server, base } = await startApi(routes)
  try {
    const status = await callJson(base, '/api/dsh-info-radar/status')
    const config = {
      ...status.json.config,
      sources: [{ id: 'bad', name: '坏源', url: 'ftp://example.com' }],
    }
    const res = await callJson(base, '/api/dsh-info-radar/config', post({ config }))
    assert.equal(res.status, 400)
    assert.ok(/只支持 http 与 https/u.test(res.json.error))
  } finally {
    server.close()
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端点：写入 Cookie 后不回传原值，且落盘到独立文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-host-'))
  const { routes, dispose } = makeHost({ dataDir: dir })
  const { server, base } = await startApi(routes)
  try {
    const status = await callJson(base, '/api/dsh-info-radar/status')
    await callJson(base, '/api/dsh-info-radar/config', post({
      config: {
        ...status.json.config,
        sources: [{ id: 's1', name: '登录源', url: 'https://example.com/a' }],
      },
    }))

    const saved = await callJson(base, '/api/dsh-info-radar/cookie', post({ sourceId: 's1', cookie: 'SESSION=abc123' }))
    assert.equal(saved.status, 200)
    assert.equal(saved.json.hasCookie, true)

    const after = await callJson(base, '/api/dsh-info-radar/status')
    assert.equal(after.json.sources[0].hasCookie, true)
    // 关键：响应里绝不能出现 Cookie 原值
    assert.ok(!JSON.stringify(after.json).includes('abc123'), 'Cookie 原值不应出现在状态响应里')

    const cookieFile = join(dir, 'cookies.json')
    assert.ok(existsSync(cookieFile))
    const stored = JSON.parse(readFileSync(cookieFile, 'utf8'))
    assert.equal(stored.s1.cookie, 'SESSION=abc123')
  } finally {
    server.close()
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端点：缺确认标记时拒绝清空', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-host-'))
  const { routes, dispose } = makeHost({ dataDir: dir })
  const { server, base } = await startApi(routes)
  try {
    const res = await callJson(base, '/api/dsh-info-radar/clear', post({}))
    assert.equal(res.status, 400)
    assert.ok(/缺少确认标记/u.test(res.json.error))
  } finally {
    server.close()
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端点：未知操作被拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-host-'))
  const { routes, dispose } = makeHost({ dataDir: dir })
  const { server, base } = await startApi(routes)
  try {
    const res = await callJson(base, '/api/dsh-info-radar/source-action', post({ sourceId: 's1', action: 'nuke' }))
    assert.equal(res.status, 400)
    assert.ok(/未知操作/u.test(res.json.error))
  } finally {
    server.close()
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端点：错误方法返回 405', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-host-'))
  const { routes, dispose } = makeHost({ dataDir: dir })
  const { server, base } = await startApi(routes)
  try {
    const res = await callJson(base, '/api/dsh-info-radar/read', { method: 'GET' })
    assert.equal(res.status, 405)
  } finally {
    server.close()
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('数据目录首次运行会写出 config.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-host-'))
  const target = join(dir, 'nested', 'radar')
  let dispose = () => {}
  try {
    const host = makeHost({ dataDir: target })
    dispose = host.dispose
    assert.ok(existsSync(join(target, 'config.json')))
    const config = JSON.parse(readFileSync(join(target, 'config.json'), 'utf8'))
    assert.equal(config.globalIntervalMinutes, 1440)
    assert.deepEqual(config.sources, [])
  } finally {
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})



test('端点：清空会真的删除条目与快照', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-host-'))
  const { routes, dispose } = makeHost({ dataDir: dir })
  const { server, base } = await startApi(routes)
  try {
    // 造一条条目与一份快照
    const { Store } = await import('../lib/store.js')
    const store = new Store(dir)
    store.appendItem({ id: 'k1', seq: 1, sourceId: 's1', sourceName: 'x', title: 't', summary: 's', url: 'https://e/1', foundAt: new Date().toISOString() })
    store.saveSnapshot('k1abcdefghijkl', '内容')

    const before = await callJson(base, '/api/dsh-info-radar/status')
    assert.equal(before.json.items.length, 1)

    const cleared = await callJson(base, '/api/dsh-info-radar/clear', post({ confirm: true }))
    assert.equal(cleared.status, 200)

    const after = await callJson(base, '/api/dsh-info-radar/status')
    assert.equal(after.json.items.length, 0, '清空后条目应真的没了')
    assert.equal(after.json.unread, 0)
  } finally {
    server.close()
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

