/**
 * 翻页、附件识别、子网页链接、批量总结的测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { nextPageUrlOf, crawlPages, looksLikeAttachmentOnly, childLinksOf } from '../lib/fetch.js'
import { Store } from '../lib/store.js'

const BASE = 'https://example.com/tzgg/xstz.htm'

test('翻页：识别「下一页」文字链接', () => {
  const html = '<a href="xstz_1.htm">下一页</a>'
  assert.equal(nextPageUrlOf(html, BASE), 'https://example.com/tzgg/xstz_1.htm')
})

test('翻页：识别 index_N 形式的页码链接', () => {
  const html = `
    <a href="xstz.htm">1</a>
    <a href="xstz_1.htm">2</a>
    <a href="xstz_2.htm">3</a>`
  const next = nextPageUrlOf(html, BASE)
  assert.ok(next !== null)
  assert.ok(next.endsWith('xstz_1.htm'), `实际 ${next}`)
})

test('翻页：没有下一页时返回 null', () => {
  const html = '<a href="detail1.htm">某条通知标题</a>'
  assert.equal(nextPageUrlOf(html, BASE), null)
})

test('翻页：已经到最后一页时返回 null', () => {
  const html = `<a href="xstz.htm">1</a><a href="xstz_1.htm">2</a>`
  const lastPage = 'https://example.com/tzgg/xstz_1.htm'
  assert.equal(nextPageUrlOf(html, lastPage), null)
})

test('翻页抓取：追上已读内容就停止，不再请求后续页', async () => {
  let requested = 0
  const server = createServer((req, res) => {
    requested += 1
    res.writeHead(200, { 'content-type': 'text/html' })
    // 每一页都返回同样的两条「旧」内容 + 下一页链接
    res.end(`<html><body>
      <a href="/detail/a.htm">这是第一页里的旧通知标题甲</a>
      <a href="/detail/b.htm">这是第一页里的旧通知标题乙</a>
      <a href="/tzgg/xstz_1.htm">下一页</a>
    </body></html>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const web = {
      async fetch({ url }) {
        const response = await fetch(url)
        return {
          url,
          statusCode: response.status,
          body: { kind: 'html', content: await response.text() },
          truncated: false,
        }
      },
    }
    // 模拟「所有内容都已见过」：countNew 永远返回 0
    const collected = await crawlPages({
      web,
      headers: null,
      startUrl: `${base}/tzgg/xstz.htm`,
      startHtml: `<a href="/detail/a.htm">旧通知标题甲的内容</a><a href="/tzgg/xstz_1.htm">下一页</a>`,
      maxPages: 5,
      source: { selector: '' },
      countNew: async () => 0,
    })
    assert.equal(collected.length, 0, '没有新内容时不应收集')
    // 只请求了第二页就停下（第一页是传进来的）
    assert.equal(requested, 1, `应只请求 1 页，实际 ${requested}`)
  } finally {
    server.close()
  }
})

test('翻页抓取：有新内容时继续往后翻', async () => {
  let pageIndex = 0
  const server = createServer((req, res) => {
    pageIndex += 1
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<html><body>
      <a href="/detail/new${pageIndex}.htm">第 ${pageIndex} 页的新通知标题内容</a>
      <a href="/tzgg/xstz_${pageIndex}.htm">下一页</a>
    </body></html>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const web = {
      async fetch({ url }) {
        const response = await fetch(url)
        return { url, statusCode: response.status, body: { kind: 'html', content: await response.text() }, truncated: false }
      },
    }
    const collected = await crawlPages({
      web,
      headers: null,
      startUrl: `${base}/tzgg/xstz.htm`,
      startHtml: '<a href="/tzgg/xstz_0.htm">下一页</a>',
      maxPages: 3,
      source: { selector: '' },
      countNew: async (entries) => entries.length,
    })
    assert.ok(collected.length >= 1, '有新内容时应收上来')
  } finally {
    server.close()
  }
})

test('附件识别：报名表类页面', () => {
  assert.equal(looksLikeAttachmentOnly('请下载附件1 报名表.docx 填写后提交', '关于XX大赛报名的通知'), '内涵报名表')
  assert.equal(looksLikeAttachmentOnly('附件：汇总表.xlsx', 'XX情况汇总'), '内涵汇总表')
})

test('附件识别：有实质正文时不判定为附件', () => {
  const longBody = '各学院：现将有关事项通知如下。'.repeat(30) + '附件1 报名表'
  assert.equal(looksLikeAttachmentOnly(longBody, '关于XX的通知'), null)
})

test('附件识别：完全无关的正文不判定', () => {
  assert.equal(looksLikeAttachmentOnly('今天天气很好，适合出门散步。', '随笔'), null)
})

test('子网页链接：排除附件与明显非内容页', () => {
  const html = `
    <a href="/detail/1.htm">这是第一条子网页的标题内容</a>
    <a href="/files/form.docx">报名表.docx</a>
    <a href="/detail/2.htm">这是第二条子网页的标题内容</a>`
  const links = childLinksOf(html, 'https://example.com/detail/main.htm')
  assert.ok(links.length >= 1)
  assert.ok(links.every((link) => !/\.docx$/u.test(link.url)), '不应包含附件')
})

test('store：新源默认带翻页配置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-page-'))
  try {
    const store = new Store(dir)
    const config = store.saveConfig({
      sources: [{ id: 's1', name: '源', url: 'https://example.com/a' }],
    })
    assert.equal(config.sources[0].followPages, true)
    assert.equal(config.sources[0].maxPages, 5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store：可以关闭翻页并限制页数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-page2-'))
  try {
    const store = new Store(dir)
    const config = store.saveConfig({
      sources: [{ id: 's1', name: '源', url: 'https://example.com/a', followPages: false, maxPages: 2 }],
    })
    assert.equal(config.sources[0].followPages, false)
    assert.equal(config.sources[0].maxPages, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

