/**
 * 本轮新增逻辑的测试：子页面链接抽取、日期拆分、逆序排序、逐条已读、定期清理。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { linksOfHtml, splitTitleDate, sortByDateDesc } from '../lib/parse.js'
import { Store } from '../lib/store.js'
import { isItemRead, RadarRunner } from '../lib/runner.js'
import { mainContentOf } from '../lib/fetch.js'

const PAGE = 'https://uc.whu.edu.cn/tzgg/xstz.htm'

test('链接抽取：每条带自己的子页面地址，不是母页', () => {
  const html = `
    <nav><a href="/">首页</a></nav>
    <ul id="list">
      <li><a href="../info/1517/128821.htm">关于2026—2027学年第一学期中期退课的通知2026-10-26</a></li>
      <li><a href="../info/1646/128791.htm">数智赋能启新程 薪火赓续育良师——武汉大学第五期未来教师研修班顺利举行</a></li>
    </ul>`
  const items = linksOfHtml(html, PAGE)
  assert.ok(items.length >= 2)
  const urls = items.map((item) => item.url)
  assert.ok(urls.every((u) => u !== PAGE), '不应包含母页面地址')
  assert.ok(urls.some((u) => u.includes('/info/1517/128821.htm')))
  assert.ok(urls.every((u) => u.startsWith('https://')))
})

test('链接抽取：相对路径正确解析为绝对地址', () => {
  const html = '<a href="../info/1517/128821.htm">这是一条足够长的通知标题</a>'
  const items = linksOfHtml(html, PAGE)
  assert.equal(items.length, 1)
  assert.equal(items[0].url, 'https://uc.whu.edu.cn/info/1517/128821.htm')
})

test('链接抽取：跳过锚点、javascript、空 href 与过短文本', () => {
  const html = `
    <a href="#top">回到顶部这个标题够长了</a>
    <a href="javascript:void(0)">点我点我点我点我点我</a>
    <a href="">空链接但是文字够长的标题</a>
    <a href="/x">短</a>
    <a href="/info/real.htm">这是一条真正有效的长标题内容</a>`
  const items = linksOfHtml(html, PAGE)
  assert.equal(items.length, 1)
  assert.ok(items[0].url.endsWith('/real.htm'))
})

test('链接抽取：跳过只有一层的栏目入口', () => {
  const html = `
    <a href="/about.htm">关于我们这个栏目入口标题</a>
    <a href="/info/1.htm">这是一条真正的内容页标题文本</a>`
  const items = linksOfHtml(html, PAGE)
  assert.equal(items.length, 1, '单层路径视为栏目入口')
  assert.ok(items[0].url.includes('/info/1.htm'))
})

test('链接抽取：跳过登录与搜索类链接', () => {
  const html = `
    <a href="/login">用户登录入口点击这里进入</a>
    <a href="/search?q=x">站内搜索这个按钮的说明</a>
    <a href="/info/2.htm">这是一条真正的内容页标题文本</a>`
  const items = linksOfHtml(html, PAGE)
  assert.equal(items.length, 1)
  assert.ok(items[0].url.includes('/info/2.htm'))
})

test('链接抽取：同一地址只保留一次', () => {
  const html = `
    <a href="/info/a.htm">这是第一条足够长的标题文本</a>
    <a href="/info/a.htm">这是第二条足够长的标题文本</a>`
  const items = linksOfHtml(html, PAGE)
  assert.equal(items.length, 1)
})

test('日期拆分：标题与日期粘连', () => {
  assert.deepEqual(splitTitleDate('关于2026—2027学年第一学期中期退课的通知2026-10-26'), {
    title: '关于2026—2027学年第一学期中期退课的通知',
    date: '2026-10-26',
  })
  assert.deepEqual(splitTitleDate('关于举办比赛的通知 2026/09/30'), {
    title: '关于举办比赛的通知',
    date: '2026-09-30',
  })
  assert.deepEqual(splitTitleDate('某通知2026年9月28日'), {
    title: '某通知',
    date: '2026-09-28',
  })
})

test('日期拆分：没有日期时原样返回', () => {
  assert.deepEqual(splitTitleDate('这是一个没有日期的标题'), {
    title: '这是一个没有日期的标题',
    date: '',
  })
  // 日期在标题开头、拆完太短 → 不拆
  assert.deepEqual(splitTitleDate('2026-10-26 通知'), {
    title: '2026-10-26 通知',
    date: '',
  })
})

test('逆序排序：按日期从新到旧', () => {
  const entries = [
    { title: '旧', publishedAt: '2026-09-01' },
    { title: '新', publishedAt: '2026-10-26' },
    { title: '中', publishedAt: '2026-10-01' },
  ]
  const sorted = sortByDateDesc(entries)
  assert.deepEqual(sorted.map((e) => e.title), ['新', '中', '旧'])
})

test('逆序排序：有日期的排前面，无日期的保持原序', () => {
  const entries = [
    { title: '无日期A', publishedAt: '' },
    { title: '有日期', publishedAt: '2026-10-01' },
    { title: '无日期B', publishedAt: '' },
  ]
  const sorted = sortByDateDesc(entries)
  assert.equal(sorted[0].title, '有日期')
  assert.deepEqual(sorted.slice(1).map((e) => e.title), ['无日期A', '无日期B'])
})

test('逆序排序：日期相同保持原序（稳定）', () => {
  const entries = [
    { title: '第一', publishedAt: '2026-10-01' },
    { title: '第二', publishedAt: '2026-10-01' },
    { title: '第三', publishedAt: '2026-10-01' },
  ]
  assert.deepEqual(sortByDateDesc(entries).map((e) => e.title), ['第一', '第二', '第三'])
})

test('逐条已读：readIds 命中即已读', () => {
  const state = { readSeq: 0, readIds: ['b'] }
  assert.equal(isItemRead(state, { id: 'a', seq: 1 }), false)
  assert.equal(isItemRead(state, { id: 'b', seq: 2 }), true)
})

test('逐条已读：整体游标仍然生效', () => {
  const state = { readSeq: 5, readIds: [] }
  assert.equal(isItemRead(state, { id: 'x', seq: 3 }), true)
  assert.equal(isItemRead(state, { id: 'y', seq: 6 }), false)
})

test('逐条已读：两种方式互补', () => {
  const state = { readSeq: 2, readIds: ['z'] }
  assert.equal(isItemRead(state, { id: 'z', seq: 99 }), true, 'id 命中优先')
  assert.equal(isItemRead(state, { id: 'w', seq: 1 }), true, '游标命中')
  assert.equal(isItemRead(state, { id: 'w', seq: 3 }), false)
})

test('store：removeItems 只删指定条目', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-rm-'))
  try {
    const store = new Store(dir)
    store.appendItem({ id: 'a', seq: 1, title: 'A' })
    store.appendItem({ id: 'b', seq: 2, title: 'B' })
    store.appendItem({ id: 'c', seq: 3, title: 'C' })
    const removed = store.removeItems(['a', 'c'])
    assert.equal(removed, 2)
    const left = store.loadItems()
    assert.equal(left.length, 1)
    assert.equal(left[0].id, 'b')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store：rewriteItems 整体重写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-rw-'))
  try {
    const store = new Store(dir)
    store.appendItem({ id: 'a', seq: 1, title: 'A', summary: '旧摘要' })
    const items = store.loadItems()
    items[0].summary = '新摘要'
    store.rewriteItems(items)
    assert.equal(store.loadItems()[0].summary, '新摘要')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('清理：未启用时不动作', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-clean-'))
  try {
    const store = new Store(dir)
    store.saveConfig({ cleanupReadEnabled: false })
    const runner = new RadarRunner({ ctx: {}, store, log: () => {} })
    const result = runner.cleanupReadItems(Date.now())
    assert.equal(result.cleaned, false)
    assert.equal(result.reason, 'disabled')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('清理：到时间后删除已读、保留未读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-clean2-'))
  try {
    const store = new Store(dir)
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    store.saveConfig({ cleanupReadEnabled: true, cleanupReadIntervalMinutes: 60 })
    store.appendItem({ id: 'read1', seq: 1, title: '已读的', foundAt: old })
    store.appendItem({ id: 'unread1', seq: 2, title: '未读的', foundAt: old })
    store.saveState({
      version: 1,
      readSeq: 0,
      readIds: ['read1'],
      readAt: { read1: old },
      sources: {},
      seenKeys: [],
      lastPushSlot: {},
      lastCleanupAt: null,
    })
    const runner = new RadarRunner({ ctx: {}, store, log: () => {} })
    const result = runner.cleanupReadItems(Date.now())
    assert.equal(result.cleaned, true)
    assert.equal(result.removed, 1)
    const left = store.loadItems()
    assert.equal(left.length, 1)
    assert.equal(left[0].id, 'unread1')
    // 已读标记也被清掉
    assert.deepEqual(store.loadState().readIds, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('清理：没到间隔时间不重复清理', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-clean3-'))
  try {
    const store = new Store(dir)
    store.saveConfig({ cleanupReadEnabled: true, cleanupReadIntervalMinutes: 60 })
    const justNow = new Date().toISOString()
    store.saveState({
      version: 1, readSeq: 0, readIds: ['x'], readAt: {}, sources: {}, seenKeys: [],
      lastPushSlot: {}, lastCleanupAt: justNow,
    })
    const runner = new RadarRunner({ ctx: {}, store, log: () => {} })
    const result = runner.cleanupReadItems(Date.now())
    assert.equal(result.cleaned, false)
    assert.equal(result.reason, 'not-due')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('清理：刚入库的已读内容有 1 分钟宽限期', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-clean4-'))
  try {
    const store = new Store(dir)
    store.saveConfig({ cleanupReadEnabled: true, cleanupReadIntervalMinutes: 1 })
    store.appendItem({ id: 'fresh', seq: 1, title: '刚入库', foundAt: new Date().toISOString() })
    store.saveState({
      version: 1, readSeq: 0, readIds: ['fresh'], readAt: {}, sources: {}, seenKeys: [],
      lastPushSlot: {}, lastCleanupAt: null,
    })
    const runner = new RadarRunner({ ctx: {}, store, log: () => {} })
    runner.cleanupReadItems(Date.now())
    assert.equal(store.loadItems().length, 1, '刚入库的不应被立即清掉')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('正文提取：甩掉侧栏推荐位', () => {
  const blocks = [
    '关于2026—2027学年第一学期中期退课的通知',
    '各学院：现将中期退课有关事项通知如下。退课时间为11月2日10:00至11月7日24:00，在本科教务管理系统自主办理，即申即退、无需审核。',
    '第九周及之前结束的课程、已提交成绩的课程、重修类课程及辅修专业单独缴费课程不允许退课。',
    '理论课与配套实验课只需办理理论课退课，关联实验课须于11月13日前向学院申请。',
    '上一条：关于举办机器人大赛的通知',
    '下一条：关于数字媒体竞赛的通知',
    '相关新闻：公共卫生学院获奖',
    '推荐阅读：青年教师学术沙龙',
  ]
  const main = mainContentOf(blocks)
  assert.ok(main.includes('11月2日10:00'))
  assert.ok(!/上一条|下一条|相关新闻|推荐阅读/.test(main), '侧栏内容不应进入正文')
})

test('正文提取：空输入与单块', () => {
  assert.equal(mainContentOf([]), '')
  assert.equal(mainContentOf(['唯一的一段正文内容']), '唯一的一段正文内容')
})


