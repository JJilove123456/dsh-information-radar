/**
 * 端到端离线自测：假宿主 + 本地 HTTP 服务 + 假 LLM + 假 IM。
 * 覆盖：正常抓取、去重、基线、关键词过滤、选择器、RSS、掉登录态、失败重试、推送去重。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store, contentKeyOf } from '../lib/store.js'
import { RadarRunner, effectiveInterval, looksLikeLoginLost } from '../lib/runner.js'
import { isPrivateAddress, validateUrl, filterEntries } from '../lib/fetch.js'
import { composePushText } from '../lib/deliver.js'

// ---------- 假网站 ----------
const pages = {
  '/news': `<!doctype html><html><head><title>新闻</title></head><body>
    <nav><a>首页</a><a>关于我们</a></nav>
    <div id="list">
      <article><h2>第一条新闻标题</h2><p>这是第一条新闻的正文内容，长度足够通过过滤。</p></article>
      <article><h2>第二条新闻标题</h2><p>这是第二条新闻的正文内容，长度也足够通过过滤。</p></article>
    </div>
    <footer>版权所有 2026</footer>
  </body></html>`,
  '/feed.xml': `<?xml version="1.0"?><rss version="2.0"><channel><title>测试源</title>
    <item><title>RSS 条目一</title><link>http://127.0.0.1:PORT/1</link>
      <description>RSS 第一条摘要内容</description><pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate></item>
  </channel></rss>`,
  '/login-gone': `<!doctype html><html><body><div class="login">请先登录后查看</div></body></html>`,
  '/empty': `<!doctype html><html><body><p>无</p></body></html>`,
}

let server
let base
/** 假 dsh-im 收到的投递请求 */
const imCalls = []

function startServer() {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      // 假 dsh-im 的投递接口
      if (req.url === '/api/dsh-im/delivery/messages') {
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          imCalls.push({ url: req.url, body })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ sent: true }))
        })
        return
      }
      const path = req.url.split('?')[0]
      const html = pages[path]
      if (html === undefined) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const type = path.endsWith('.xml') ? 'application/rss+xml' : 'text/html; charset=utf-8'
      res.writeHead(200, { 'content-type': type })
      res.end(html.replace(/PORT/gu, String(server.address().port)))
    })
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
}

// ---------- 假宿主 ----------
function makeCtx({ llmText = '这是模型生成的摘要。' } = {}) {
  const web = {
    async fetch({ url }) {
      const response = await fetch(url)
      const contentType = response.headers.get('content-type') ?? ''
      const content = await response.text()
      return {
        url,
        statusCode: response.status,
        body: { kind: contentType.includes('html') ? 'html' : 'text', content },
        truncated: false,
      }
    },
  }
  const llm = {
    stream(options) {
      return (async function* () {
        yield { type: 'text-delta', text: llmText }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return {
    get(name) {
      if (name === 'web') return web
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
  }
}

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'radar-test-'))
  return { store: new Store(dir), dir }
}

const baseConfig = {
  globalIntervalMinutes: 60,
  anchor: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  sources: [],
}

// ---------- 测试 ----------
test('端到端：首次抓取只建立基线，不显示存量内容', async () => {
  await startServer()
  const { store, dir } = makeStore()
  try {
    store.saveConfig({
      ...baseConfig,
      sources: [{ id: 'a1', name: '新闻源', url: `${base}/news`, selector: '#list', includeKeywords: [], excludeKeywords: [] }],
    })
    const runner = new RadarRunner({ ctx: makeCtx(), store, log: () => {}, loadHeaders: () => null })
    const first = await runner.tick(Date.now())
    assert.equal(first.ran, 1)
    assert.equal(first.results[0].ok, true)
    assert.equal(first.results[0].baseline, true)
    // 用户要求：网页原有内容只登记、不显示
    assert.equal(first.results[0].baselineCount >= 2, true)
    assert.equal(first.results[0].created, 0)
    assert.equal(store.loadItems().length, 0, '基线内容不应入库')
    // 但 key 已登记，后续会被判定为已见过
    assert.ok((store.loadState().seenKeys ?? []).length >= 2, '基线应登记已见内容')

    // 同一期再 tick：已抓过，不再触发
    const second = await runner.tick(Date.now())
    assert.equal(second.skipped, 'nothing-due')
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：跨期后只抓一次，且新增内容会去重', async () => {
  await startServer()
  const { store, dir } = makeStore()
  try {
    // 锚点设成 2 小时前，间隔 60 分钟 → 第 2 期
    store.saveConfig({
      globalIntervalMinutes: 60,
      anchor: new Date(Date.now() - 130 * 60 * 1000).toISOString(),
      sources: [{ id: 'a1', name: '新闻源', url: `${base}/news`, selector: '#list' }],
    })
    const runner = new RadarRunner({ ctx: makeCtx(), store, log: () => {}, loadHeaders: () => null })
    // 先把状态写成「已在第 0 期抓过基线」
    const state = store.loadState()
    state.sources = { a1: { status: 'ok', lastSlot: 0, baselineDone: true, lastBodyLen: 200 } }
    store.saveState(state)

    const res = await runner.tick(Date.now())
    assert.equal(res.ran, 1)
    const items = store.loadItems()
    // 第一次是基线（因为 baselineOnly 默认 true 且 baselineDone 被手工置 true，这里应正常入库）
    assert.ok(items.length >= 2)
    assert.ok(items.every((item) => item.baseline === false))

    // 再 tick：同一期不会重复
    const again = await runner.tick(Date.now())
    assert.equal(again.skipped, 'nothing-due')
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：关键词过滤生效', async () => {
  await startServer()
  const { store, dir } = makeStore()
  try {
    store.saveConfig({
      ...baseConfig,
      sources: [{ id: 'a1', name: '新闻源', url: `${base}/news`, selector: '#list', includeKeywords: ['第一条'], excludeKeywords: [] }],
    })
    // 跳过基线阶段，直接测过滤：把源标记成基线已完成
    const state0 = store.loadState()
    state0.sources = { a1: { status: 'ok', baselineDone: true, lastSlot: -1, lastBodyLen: 300 } }
    store.saveState(state0)
    const runner = new RadarRunner({ ctx: makeCtx(), store, log: () => {}, loadHeaders: () => null })
    await runner.tick(Date.now())
    const items = store.loadItems()
    assert.ok(items.length >= 1)
    assert.ok(items.every((item) => /第一条/u.test(item.title) || /第一条/u.test(item.summary)))
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：RSS 抓取', async () => {
  await startServer()
  const { store, dir } = makeStore()
  try {
    store.saveConfig({
      ...baseConfig,
      sources: [{ id: 'f1', name: '订阅源', url: `${base}/feed.xml` }],
    })
    // 跳过基线：RSS 同样先建基线，这里要测的是解析
    const state0 = store.loadState()
    state0.sources = { f1: { status: 'ok', baselineDone: true, lastSlot: -1, lastBodyLen: 300 } }
    store.saveState(state0)
    const runner = new RadarRunner({ ctx: makeCtx(), store, log: () => {}, loadHeaders: () => null })
    const res = await runner.tick(Date.now())
    assert.equal(res.ran, 1)
    const items = store.loadItems()
    assert.ok(items.some((item) => item.title.includes('RSS 条目一')))
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：选择器写错时明确报错', async () => {
  await startServer()
  const { store, dir } = makeStore()
  try {
    store.saveConfig({
      ...baseConfig,
      sources: [{ id: 'a1', name: '新闻源', url: `${base}/news`, selector: '#not-exist' }],
    })
    const runner = new RadarRunner({ ctx: makeCtx(), store, log: () => {}, loadHeaders: () => null })
    const res = await runner.tick(Date.now())
    assert.equal(res.ran, 1)
    assert.equal(res.results[0].ok, false)
    assert.ok(/没有匹配到内容/u.test(res.results[0].error))
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：连续失败 3 次后暂停', async () => {
  await startServer()
  const { store, dir } = makeStore()
  try {
    store.saveConfig({
      globalIntervalMinutes: 1,
      anchor: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      sources: [{ id: 'a1', name: '坏源', url: `${base}/missing` }],
    })
    const runner = new RadarRunner({ ctx: makeCtx(), store, log: () => {}, loadHeaders: () => null })
    for (let i = 0; i < 3; i += 1) {
      const state = store.loadState()
      state.sources = { a1: { ...(state.sources.a1 ?? {}), lastSlot: -1 } }
      store.saveState(state)
      await runner.tick(Date.now())
    }
    const state = store.loadState()
    assert.equal(state.sources.a1.status, 'paused')
    assert.ok(/连续失败 3 次/u.test(state.sources.a1.lastError))
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：IM 推送只发一次并且合并成一条', async () => {
  await startServer()
  const { store, dir } = makeStore()
  try {
    imCalls.length = 0
    store.saveConfig({
      globalIntervalMinutes: 60,
      anchor: new Date(Date.now() - 130 * 60 * 1000).toISOString(),
      notify: { enabled: true, dshImBotId: 'bot_test', dshImTargetId: 'tgt_test' },
      sources: [{ id: 'a1', name: '新闻源', url: `${base}/news`, selector: '#list' }],
    })
    const state = store.loadState()
    state.sources = { a1: { status: 'ok', lastSlot: 0, baselineDone: true, lastBodyLen: 200 } }
    store.saveState(state)

    // 通过 HTTP 回退投递：origin 指向本地假 dsh-im
    const runner = new RadarRunner({ ctx: makeCtx(), store, log: () => {}, loadHeaders: () => null, origin: base })
    await runner.tick(Date.now())
    assert.equal(imCalls.length, 1, '一轮只应发一条')
    const payload = JSON.parse(imCalls[0].body)
    assert.equal(payload.botId, 'bot_test')
    assert.equal(payload.targetId, 'tgt_test')
    assert.ok(payload.text.includes('新内容'))

    // 同一期再跑不应重复推送
    const again = await runner.tick(Date.now())
    assert.equal(again.skipped, 'nothing-due')
    assert.equal(imCalls.length, 1)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('掉登录态判定：只有字数骤减 + 登录词同时满足才触发', () => {
  assert.equal(looksLikeLoginLost({ previousLen: 3000, currentLen: 500, text: '请先登录' }), true)
  assert.equal(looksLikeLoginLost({ previousLen: 3000, currentLen: 500, text: '正常内容' }), false)
  assert.equal(looksLikeLoginLost({ previousLen: 3000, currentLen: 2800, text: '请先登录' }), false)
  assert.equal(looksLikeLoginLost({ previousLen: 100, currentLen: 10, text: '请先登录' }), false)
})

test('私有地址识别', () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true)
  assert.equal(isPrivateAddress('10.1.2.3'), true)
  assert.equal(isPrivateAddress('192.168.1.1'), true)
  assert.equal(isPrivateAddress('172.16.0.1'), true)
  assert.equal(isPrivateAddress('172.32.0.1'), false)
  assert.equal(isPrivateAddress('8.8.8.8'), false)
  assert.equal(isPrivateAddress('::1'), true)
  assert.equal(isPrivateAddress('fe80::1'), true)
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true)
})

test('URL 校验', () => {
  assert.equal(validateUrl('https://example.com'), null)
  assert.equal(validateUrl('http://example.com/a'), null)
  assert.ok(validateUrl('ftp://example.com') !== null)
  assert.ok(validateUrl('javascript:alert(1)') !== null)
  assert.ok(validateUrl('not a url') !== null)
})

test('关键词过滤', () => {
  const entries = [
    { title: '甲', summary: '包含苹果', text: '包含苹果的内容' },
    { title: '乙', summary: '包含香蕉', text: '包含香蕉的内容' },
    { title: '丙', summary: '包含苹果和广告', text: '包含苹果和广告的内容' },
  ]
  const source = { includeKeywords: ['苹果'], excludeKeywords: ['广告'] }
  const kept = filterEntries(entries, source)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].title, '甲')
})

test('推送正文：合并与截断', () => {
  const text = composePushText({
    sourceName: '源 A',
    totalCount: 10,
    maxEntries: 3,
    items: [
      { title: '标题一', summary: '摘要一', url: 'https://a/1' },
      { title: '标题二', summary: '摘要二', url: 'https://a/2' },
      { title: '标题三', summary: '摘要三', url: 'https://a/3' },
    ],
  })
  assert.ok(text.includes('新内容 10 条'))
  assert.ok(text.includes('标题一'))
  assert.ok(text.includes('另有 7 条会在下一次推送里发出'))
})

test('内容键稳定且不同内容不同键', async () => {
  const a = await contentKeyOf('https://x/1', '内容 A')
  const b = await contentKeyOf('https://x/1', '内容 A')
  const c = await contentKeyOf('https://x/1', '内容 B')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(a.length, 24)
})

test('有效间隔：源覆盖优先', () => {
  const config = { globalIntervalMinutes: 60 }
  assert.equal(effectiveInterval({ intervalMinutes: 5 }, config), 5 * 60 * 1000)
  assert.equal(effectiveInterval({ intervalMinutes: null }, config), 60 * 60 * 1000)
  assert.equal(effectiveInterval({}, config), 60 * 60 * 1000)
})






