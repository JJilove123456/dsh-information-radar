/**
 * 推送相关的行为测试。
 *
 * 覆盖用户明确要求的事：
 * 1) 推送正文必须带摘要（面板里的总结仍是手动的，只推的时候补）
 * 2) 推送末尾默认带一句「有什么看不懂的可以问我」，可改可留空
 * 3) 推送出去的条目是否自动标已读，做成开关
 * 4) 未读的积压也要能补推；推过的打标记，不会重复发
 * 5) 没有已保存目标时，用「聊过的会话」当临时目标也能发
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store, normalizeConfig, normalizeDraftTarget, DEFAULT_PUSH_HINT } from '../lib/store.js'
import {
  composePushText,
  createDshImTarget,
  listDshImSuggestions,
  readOwnerSuggestion,
  sendViaDshIm,
} from '../lib/deliver.js'
import { RadarRunner, isItemRead, MAX_PUSH_ITEMS } from '../lib/runner.js'

const SOURCE = { id: 'src-a', name: '源 A', url: 'https://example.com/list' }
const NOTIFY = { enabled: true, dshImBotId: 'bot-1', dshImTargetId: 'target-1' }
const DRAFT = { kind: 'user', route: { userOpenId: 'QQ_OPENID_123456' }, label: 'QQ · 私聊（…123456）' }

/** 造一个够用的 ctx：dshIm 记下发出去的内容，llm 固定回一句摘要。 */
function makeCtx({ summary = '这是摘要。', sendFails = false } = {}) {
  const sent = []
  const ctx = {
    get(name) {
      if (name === 'dshIm') {
        return {
          async send(botId, targetId, text, options) {
            if (sendFails) throw new Error('投递通道挂了')
            sent.push({ botId, targetId, text, format: options?.format })
            return { sent: true }
          },
          async listBots() {
            return [{ botId: 'bot-1', channel: 'qq' }]
          },
          async listTargets() {
            return { botId: 'bot-1', channel: 'qq', targets: [] }
          },
        }
      }
      if (name === 'llm') {
        return {
          stream() {
            return (async function* stream() {
              yield { type: 'text-delta', text: summary }
              yield { type: 'finish', reason: { kind: 'stop' } }
            })()
          },
        }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) }
      }
      return undefined
    },
  }
  return { ctx, sent }
}

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'radar-push-'))
  return { dir, store: new Store(dir) }
}

/** 往库里塞一条未读内容，字段和 runner 落库时一致。 */
function addItem(store, patch = {}) {
  const key = patch.id ?? `key-${Math.random().toString(36).slice(2, 10)}-aaaa-bbbb`
  store.appendItem({
    id: key,
    seq: patch.seq ?? 1,
    sourceId: SOURCE.id,
    sourceName: SOURCE.name,
    title: patch.title ?? '某通知',
    summary: patch.summary ?? '',
    summarized: patch.summarized === true,
    summaryError: null,
    snapshotKey: patch.snapshotKey ?? key,
    url: patch.url ?? 'https://example.com/a',
    publishedAt: patch.publishedAt ?? '',
    foundAt: new Date().toISOString(),
    ...patch,
  })
  return key
}

/** 造一个带建议/建目标能力的假 dshIm 服务。 */
function makeImService({ targets = [], suggestions = [], conflictOnce = false } = {}) {
  const calls = { sent: [], created: [], listed: [] }
  const stored = targets.map((entry) => ({ ...entry }))
  let conflicted = false
  const service = {
    async send(botId, recipient, text) {
      calls.sent.push({ botId, recipient, text })
      return { sent: true }
    },
    async listBots() {
      return [{ botId: 'bot-1', channel: 'qq' }]
    },
    async listTargets(botId) {
      calls.listed.push(botId)
      return { botId, channel: 'qq', targets: stored.map((entry) => ({ ...entry, route: { ...entry.route } })) }
    },
    async listSuggestions(botId) {
      return { botId, channel: 'qq', suggestions }
    },
    async createTarget(botId, target) {
      if (conflictOnce && !conflicted) {
        conflicted = true
        const error = new Error('target-conflict')
        error.code = 'target-conflict'
        throw error
      }
      calls.created.push({ botId, target })
      stored.push({ targetId: target.targetId, name: target.name, kind: target.kind, route: target.route })
      return { targetId: target.targetId, kind: target.kind, route: target.route }
    },
  }
  return { service, calls, stored }
}

function ctxWith(service) {
  return { get: (name) => (name === 'dshIm' ? service : undefined) }
}

test('推送正文：默认带引导语', () => {
  const text = composePushText({
    sourceName: '源 A',
    totalCount: 1,
    items: [{ title: '标题一', summary: '摘要一', url: 'https://a/1' }],
  })
  assert.ok(text.includes('标题一'))
  assert.ok(text.includes('摘要一'))
  assert.ok(text.includes(DEFAULT_PUSH_HINT))
})

test('推送正文：引导语可自定义、可留空', () => {
  const custom = composePushText({
    sourceName: '源 A',
    totalCount: 1,
    items: [{ title: '标题一', summary: '摘要一' }],
    hint: '不懂就回我一句',
  })
  assert.ok(custom.includes('不懂就回我一句'))
  assert.ok(!custom.includes(DEFAULT_PUSH_HINT))

  const bare = composePushText({
    sourceName: '源 A',
    totalCount: 1,
    items: [{ title: '标题一', summary: '摘要一' }],
    hint: '',
  })
  assert.ok(!bare.includes(DEFAULT_PUSH_HINT))
  assert.ok(bare.trimEnd().endsWith('摘要一'))
})

test('推送正文：附件型条目不只剩标题', () => {
  const text = composePushText({
    sourceName: '源 A',
    totalCount: 2,
    items: [
      { title: '附件通知', attachmentOnly: true, attachmentNote: '内涵附件', url: 'https://a/1' },
      { title: '普通通知', summary: '摘要二', url: 'https://a/2' },
    ],
  })
  assert.ok(text.includes('内涵附件，请点链接看原文'))
  assert.ok(text.includes('摘要二'))
})

test('配置：pushHint 默认值、autoMarkRead 默认关', () => {
  const plain = normalizeConfig({})
  assert.equal(plain.notify.pushHint, DEFAULT_PUSH_HINT)
  assert.equal(plain.notify.autoMarkRead, false)
  assert.equal(plain.notify.enabled, false)

  const quoted = normalizeConfig({ notify: { autoMarkRead: true, pushHint: '' } })
  assert.equal(quoted.notify.autoMarkRead, true)
  assert.equal(quoted.notify.pushHint, '')
})

test('推送：同一条内容只发一次', async () => {
  const { dir, store } = makeStore()
  try {
    store.saveConfig({ notify: NOTIFY })
    addItem(store, { seq: 1, summary: '摘要' })
    const { ctx, sent } = makeCtx()
    const runner = new RadarRunner({ ctx, store, log: () => {} })

    const first = await runner.pushSource(SOURCE)
    assert.equal(first.ok, true)
    assert.equal(first.count, 1)
    assert.equal(sent.length, 1)

    // 第二次：已经打过 pushedAt 标记，什么都不发
    const second = await runner.pushSource(SOURCE)
    assert.equal(second, null)
    assert.equal(sent.length, 1)
    assert.equal(typeof store.loadItems()[0].pushedAt, 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('推送：默认不改已读状态', async () => {
  const { dir, store } = makeStore()
  try {
    store.saveConfig({ notify: NOTIFY })
    addItem(store, { seq: 1 })
    const { ctx } = makeCtx()
    const runner = new RadarRunner({ ctx, store, log: () => {} })

    const result = await runner.pushSource(SOURCE)
    assert.equal(result.ok, true)
    assert.equal(result.markedRead, 0)
    assert.equal(isItemRead(store.loadState(), store.loadItems()[0]), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('推送：开启 autoMarkRead 后推送即已读', async () => {
  const { dir, store } = makeStore()
  try {
    store.saveConfig({ notify: { ...NOTIFY, autoMarkRead: true } })
    addItem(store, { seq: 1 })
    const { ctx } = makeCtx()
    const runner = new RadarRunner({ ctx, store, log: () => {} })

    const result = await runner.pushSource(SOURCE)
    assert.equal(result.ok, true)
    assert.equal(result.markedRead, 1)
    assert.equal(isItemRead(store.loadState(), store.loadItems()[0]), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('推送：没开推送就什么都不发', async () => {
  const { dir, store } = makeStore()
  try {
    store.saveConfig({})
    addItem(store, { seq: 1 })
    const { ctx, sent } = makeCtx()
    const runner = new RadarRunner({ ctx, store, log: () => {} })
    assert.equal(await runner.pushSource(SOURCE), null)
    assert.equal(sent.length, 0)
    const flushed = await runner.flushPendingPushes({})
    assert.equal(flushed.skipped, 'disabled')
    assert.equal(sent.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('推送：已经点开过的（已读）不推', async () => {
  const { dir, store } = makeStore()
  try {
    store.saveConfig({ notify: NOTIFY })
    const oldKey = addItem(store, { seq: 1, title: '已经看过的' })
    addItem(store, { seq: 2, title: '新来的' })
    const state = store.loadState()
    state.readIds = [oldKey]
    store.saveState(state)
    const { ctx, sent } = makeCtx()
    const runner = new RadarRunner({ ctx, store, log: () => {} })

    const result = await runner.pushSource(SOURCE)
    assert.equal(result.ok, true)
    assert.equal(sent.length, 1)
    assert.ok(sent[0].text.includes('新来的'))
    assert.ok(!sent[0].text.includes('已经看过的'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('推送：开关后开也能把积压补发出去', async () => {
  const { dir, store } = makeStore()
  try {
    // 先是关着的：攒下三条未读
    store.saveConfig({ notify: { ...NOTIFY, enabled: false }, sources: [SOURCE] })
    addItem(store, { seq: 1, title: '积压一' })
    addItem(store, { seq: 2, title: '积压二' })
    addItem(store, { seq: 3, title: '积压三' })
    const { ctx, sent } = makeCtx()
    const runner = new RadarRunner({ ctx, store, log: () => {} })
    assert.equal(sent.length, 0)
    assert.equal(runner.snapshot().pendingPush, 3)

    // 打开推送，补推
    store.saveConfig({ notify: NOTIFY, sources: [SOURCE] })
    const flushed = await runner.flushPendingPushes({})
    assert.equal(flushed.messages.length, 1)
    assert.equal(flushed.messages[0].ok, true)
    assert.equal(flushed.messages[0].count, 3)
    assert.equal(sent.length, 1)
    assert.ok(sent[0].text.includes('积压一'))
    assert.ok(sent[0].text.includes('新内容 3 条'))
    assert.equal(runner.snapshot().pendingPush, 0)

    // 再补一次不会重复发
    const again = await runner.flushPendingPushes({})
    assert.equal(again.messages.length, 0)
    assert.equal(sent.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test(`推送：一批最多 ${MAX_PUSH_ITEMS} 条，其余不另发第二条`, async () => {
  const { dir, store } = makeStore()
  try {
    store.saveConfig({ notify: NOTIFY })
    for (let index = 1; index <= MAX_PUSH_ITEMS + 5; index += 1) {
      addItem(store, { seq: index, title: `通知 ${index}` })
    }
    const { ctx, sent } = makeCtx()
    const runner = new RadarRunner({ ctx, store, log: () => {} })

    const result = await runner.pushSource(SOURCE)
    assert.equal(result.ok, true)
    assert.equal(result.count, MAX_PUSH_ITEMS)
    assert.equal(result.total, MAX_PUSH_ITEMS + 5)
    assert.equal(sent.length, 1)
    // 不折叠：20 条全部列出，不写「其余 N 条请在面板查看」
    assert.ok(!sent[0].text.includes('其余'))
    assert.ok(sent[0].text.includes('另有 5 条会在下一次推送里发出'))
    for (let index = 1; index <= MAX_PUSH_ITEMS; index += 1) {
      assert.ok(sent[0].text.includes(`通知 ${index}`), `缺少第 ${index} 条`)
    }
    assert.ok(!sent[0].text.includes(`通知 ${MAX_PUSH_ITEMS + 1}`))

    // 剩下的 5 条留给下一轮，不会在同一轮重复发
    const second = await runner.pushSource(SOURCE)
    assert.equal(second.ok, true)
    assert.equal(second.count, 5)
    assert.equal(sent.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('推送：发送失败时不打标记，下轮还会重试', async () => {
  const { dir, store } = makeStore()
  try {
    store.saveConfig({ notify: NOTIFY })
    const key = addItem(store, { seq: 1 })
    const { ctx } = makeCtx({ sendFails: true })
    const runner = new RadarRunner({ ctx, store, log: () => {} })

    const result = await runner.pushSource(SOURCE)
    assert.equal(result.ok, false)
    const saved = store.loadItems().find((item) => item.id === key)
    assert.equal(saved.pushedAt, undefined)
    assert.equal(runner.snapshot().pendingPush, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('推送：推送前补摘要并写回条目', async () => {
  const { dir, store } = makeStore()
  try {
    store.saveConfig({ notify: NOTIFY })
    const key = addItem(store, { seq: 1, summary: '' })
    store.saveSnapshot(key, '这里是一段很长的正文，讲的是某某通知的具体安排和报名要求。')
    const { ctx, sent } = makeCtx({ summary: '报名截止到本周五。' })
    const runner = new RadarRunner({ ctx, store, log: () => {} })

    const result = await runner.pushSource(SOURCE)
    assert.equal(result.ok, true)
    assert.equal(sent.length, 1)
    assert.ok(sent[0].text.includes('报名截止到本周五。'))
    // 补出来的摘要要写回条目，面板里不用再点一次才看到
    const saved = store.loadItems()[0]
    assert.equal(saved.summary, '报名截止到本周五。')
    assert.equal(saved.summarized, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('推送：没有正文快照也不阻塞推送', async () => {
  const { dir, store } = makeStore()
  try {
    store.saveConfig({ notify: NOTIFY })
    addItem(store, { seq: 1, title: '只有标题', snapshotKey: 'not-exist-xx' })
    const { ctx, sent } = makeCtx()
    const runner = new RadarRunner({ ctx, store, log: () => {} })

    const result = await runner.pushSource(SOURCE)
    assert.equal(result.ok, true)
    assert.equal(sent.length, 1)
    assert.ok(sent[0].text.includes('只有标题'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置：临时会话目标会被归一化，脏数据丢弃', () => {
  assert.equal(normalizeDraftTarget(null), null)
  assert.equal(normalizeDraftTarget({ kind: 'user' }), null)
  assert.equal(normalizeDraftTarget({ kind: '', route: { userOpenId: 'x' } }), null)
  assert.equal(normalizeDraftTarget({ kind: 'user', route: { 'bad key!': 'x' } }), null)

  const normalized = normalizeDraftTarget({
    kind: 'user',
    route: { userOpenId: 'abc', extra: 1, skipped: null },
    label: '  QQ · 私聊  ',
  })
  assert.deepEqual(normalized, { kind: 'user', route: { userOpenId: 'abc', extra: 1 }, label: 'QQ · 私聊' })

  const config = normalizeConfig({ notify: { dshImDraft: DRAFT } })
  assert.deepEqual(config.notify.dshImDraft.route, DRAFT.route)
  assert.equal(normalizeConfig({}).notify.dshImDraft, null)
})

test('发送：没有保存目标时用临时会话投递', async () => {
  const { service, calls } = makeImService()
  const result = await sendViaDshIm({
    ctx: ctxWith(service),
    origin: '',
    botId: 'bot-1',
    targetId: '',
    draft: DRAFT,
    text: '内容',
  })
  assert.equal(result.ok, true)
  assert.equal(calls.sent.length, 1)
  // 只能带 kind + route：dsh-im 会拒绝多余字段（label 是界面用的）
  assert.deepEqual(calls.sent[0].recipient, { kind: 'user', route: { userOpenId: 'QQ_OPENID_123456' } })
})

test('发送：什么都没有时报错而不是乱发', async () => {
  const { service, calls } = makeImService()
  const result = await sendViaDshIm({
    ctx: ctxWith(service), origin: '', botId: 'bot-1', targetId: '', draft: null, text: '内容',
  })
  assert.equal(result.ok, false)
  assert.equal(calls.sent.length, 0)
})

test('推送：只配了临时会话也能推出去', async () => {
  const { dir, store } = makeStore()
  try {
    store.saveConfig({ notify: { ...NOTIFY, dshImTargetId: '', dshImDraft: DRAFT } })
    addItem(store, { seq: 1, title: '新通知', summary: '摘要' })
    const { service, calls } = makeImService()
    const runner = new RadarRunner({ ctx: ctxWith(service), store, log: () => {} })
    const result = await runner.pushSource(SOURCE)
    assert.equal(result.ok, true)
    assert.equal(calls.sent.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('建议：能列出机器人聊过的会话', async () => {
  const { service } = makeImService({ suggestions: [{ kind: 'user', route: { userOpenId: 'abc' } }] })
  const result = await listDshImSuggestions(ctxWith(service), 'bot-1')
  assert.equal(result.ok, true)
  assert.equal(result.suggestions.length, 1)
  assert.equal(result.suggestions[0].kind, 'user')

  const unavailable = await listDshImSuggestions({ get: () => ({}) }, 'bot-1')
  assert.equal(unavailable.ok, false)
})

test('建议→目标：自动挑未占用的 id，冲突后重试', async () => {
  const { service, calls } = makeImService({
    targets: [{ targetId: 'info-radar', kind: 'user', route: { userOpenId: 'old' } }],
  })
  const result = await createDshImTarget(ctxWith(service), 'bot-1', {
    kind: 'user',
    route: { userOpenId: 'new' },
    name: '信息雷达',
  })
  assert.equal(result.ok, true)
  assert.equal(result.targetId, 'info-radar-2')
  assert.equal(calls.created.length, 1)
  assert.equal(calls.created[0].target.name, '信息雷达')

  // 第一次冲突（列表读不到时）也要能换下一个 id 重试成功
  const second = makeImService({ conflictOnce: true })
  const retried = await createDshImTarget(ctxWith(second.service), 'bot-1', {
    kind: 'user',
    route: { userOpenId: 'new' },
  })
  assert.equal(retried.ok, true)
  assert.equal(retried.targetId, 'info-radar-2')

  const broken = await createDshImTarget({ get: () => ({}) }, 'bot-1', { kind: 'user', route: { a: 'b' } })
  assert.equal(broken.ok, false)
})

test('兜底：从 dsh-im 渠道配置里读出「机器人主人」的会话', () => {
  const home = mkdtempSync(join(tmpdir(), 'radar-home-'))
  const previous = process.env.DSH_HOME
  try {
    const dir = join(home, 'integrations', 'dsh-qq')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      version: 1,
      bots: [
        { botId: 'bot-a', ownerUserOpenid: 'OPENID_A' },
        { botId: 'bot-b', appId: '123', secretRef: 'secret-ref' },
      ],
    }), 'utf8')
    process.env.DSH_HOME = home

    assert.deepEqual(readOwnerSuggestion('qq', 'bot-a'), [
      { kind: 'user', route: { userOpenId: 'OPENID_A' } },
    ])
    // 没有 owner 字段的机器人不猜
    assert.deepEqual(readOwnerSuggestion('qq', 'bot-b'), [])
    // 不认识的机器人 / 不认识的渠道都返回空数组，不抛错
    assert.deepEqual(readOwnerSuggestion('qq', 'bot-missing'), [])
    assert.deepEqual(readOwnerSuggestion('telegram', 'bot-a'), [])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

