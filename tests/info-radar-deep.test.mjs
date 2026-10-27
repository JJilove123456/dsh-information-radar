/**
 * 深层递归抓取测试：列表 → 详情 → 子页 → 孙页。
 * 用本地 HTTP 服务模拟四层结构。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { fetchSource, enrichWithDetail } from '../lib/fetch.js'

const LIST = `<html><body>
<div class="list_txt"><ul>
  <li><a href="/a/1"><span>年度技术交流会通知</span><i>2026-10-27</i></a></li>
  <li><a href="/a/2"><span>设备普查工作通知</span><i>2026-10-26</i></a></li>
</ul></div>
<div class="sidebar"><a href="/about.htm">关于我们</a></div>
</body></html>`

const PAGES = {
  '/a/1': `<html><body><div class="v_news_content">
    <h2>年度技术交流会通知</h2>
    <p>定于十一月十五日举办年度技术交流会，地点为综合楼报告厅，请各单位派人参加。</p>
    <p>会议包含主题报告和分组研讨两个环节，详细议程见子页面。</p>
    <p><a href="/a/1/sub/1">分论坛一议程</a></p>
  </div><div class="sidebar"><a href="/a/2">另一条通知</a></div></body></html>`,
  '/a/1/sub/1': `<html><body><div class="v_news_content">
    <h2>分论坛一议程</h2>
    <p>分论坛一安排在下午两点至四点，包含三场主题报告和一场圆桌讨论。</p>
    <p>请参会人员提前阅读背景材料。</p>
    <p><a href="/a/1/sub/1/deep">参会须知</a></p>
  </div></body></html>`,
  '/a/1/sub/1/deep': `<html><body><div class="v_news_content">
    <h2>参会须知</h2>
    <p>请提前十五分钟入场，会前发放议程手册。会议期间请将手机调至静音。</p>
  </div></body></html>`,
  '/a/2': `<html><body><div class="v_news_content">
    <h2>设备普查工作通知</h2>
    <p>请各单位于十一月底前完成设备自查并提交普查表，问题设备统一安排检修。</p>
  </div></body></html>`,
}

async function startSite() {
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0]
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (path === '/list') {
      res.end(LIST)
      return
    }
    const body = PAGES[path]
    if (body === undefined) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

/** 允许私网时，走自建通道；这里 web 故意不可用以确保没走宿主。 */
const web = {
  async fetch() {
    throw new Error('本测试应走自建通道')
  },
}

test('深度递归：列表 → 详情 → 子页 → 孙页', async () => {
  const { server, base } = await startSite()
  try {
    const source = {
      id: 't',
      name: '测试站',
      url: `${base}/list`,
      selector: '',
      includeKeywords: [],
      excludeKeywords: [],
      allowPrivate: true,
    }
    const list = await fetchSource({ web, source, headers: null })
    assert.equal(list.ok, true)
    assert.equal(list.kind, 'list')
    assert.equal(list.entries.length, 2, '列表应有 2 条')
    assert.equal(list.entries[0].publishedAt, '2026-10-27')

    const enriched = await enrichWithDetail({ web, entries: list.entries, source, headers: null, limit: 2, depth: 2 })
    const first = enriched.find((entry) => entry.url.endsWith('/a/1'))
    assert.ok(first !== undefined)
    assert.equal(first.children.length, 1, '第 1 条应有 1 个子页')

    const sub = first.children[0]
    assert.equal(sub.title, '分论坛一议程')
    assert.ok(sub.text.includes('下午两点至四点'), '子页正文应抓回')
    assert.equal(sub.children.length, 1, '子页应再挂 1 个孙页')

    const grand = sub.children[0]
    assert.ok(grand.title.includes('参会须知'))
    assert.ok(grand.text.includes('提前十五分钟入场'), '孙页正文应抓回')

    // 第 2 条没有子页
    const second = enriched.find((entry) => entry.url.endsWith('/a/2'))
    assert.equal(second.children.length, 0)
  } finally {
    server.close()
  }
})

test('深度递归：depth=0 时不抓子页', async () => {
  const { server, base } = await startSite()
  try {
    const source = { id: 't', name: '测试站', url: `${base}/list`, selector: '', includeKeywords: [], excludeKeywords: [], allowPrivate: true }
    const list = await fetchSource({ web, source, headers: null })
    const enriched = await enrichWithDetail({ web, entries: list.entries, source, headers: null, limit: 2, depth: 0 })
    assert.ok(enriched.every((entry) => entry.children.length === 0), 'depth=0 不应有子页')
  } finally {
    server.close()
  }
})

test('深度递归：depth=1 只抓一层，不含孙页', async () => {
  const { server, base } = await startSite()
  try {
    const source = { id: 't', name: '测试站', url: `${base}/list`, selector: '', includeKeywords: [], excludeKeywords: [], allowPrivate: true }
    const list = await fetchSource({ web, source, headers: null })
    const enriched = await enrichWithDetail({ web, entries: list.entries, source, headers: null, limit: 2, depth: 1 })
    const first = enriched.find((entry) => entry.url.endsWith('/a/1'))
    assert.equal(first.children.length, 1, '应抓到子页')
    assert.equal(first.children[0].children.length, 0, 'depth=1 不应继续抓孙页')
  } finally {
    server.close()
  }
})

test('私网保护：未开 allowPrivate 时拒绝本地地址', async () => {
  const { server, base } = await startSite()
  try {
    const source = {
      id: 't',
      name: '测试站',
      url: `${base}/list`,
      selector: '',
      includeKeywords: [],
      excludeKeywords: [],
      allowPrivate: false,
    }
    // 走宿主通道，模拟宿主拒绝私网
    const rejectingWeb = {
      async fetch() {
        const error = new Error('URL hostname resolves to a non-public IP address')
        error.code = 'WEB_BLOCKED_URL'
        throw error
      },
    }
    const result = await fetchSource({ web: rejectingWeb, source, headers: null })
    assert.equal(result.ok, false)
    assert.ok(/公网|拒绝/u.test(result.error), `实际错误：${result.error}`)
  } finally {
    server.close()
  }
})

