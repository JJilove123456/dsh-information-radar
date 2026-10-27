/**
 * 摘要行为测试。
 *
 * 重点防住两个已经踩过的坑：
 * 1) token 预算太小 + 开推理 → 只输出半句话，面板里存成残句
 * 2) 模型偶发返回空文本 → 摘要直接缺失
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { summarize, fallbackSummary, SUMMARY_MAX_TOKENS } from '../lib/summarize.js'

/** 按调用次序给出预设回复，并记录每次的 options。 */
function makeCtx(replies) {
  const calls = []
  const ctx = {
    get(name) {
      if (name === 'llm') {
        return {
          stream(options) {
            calls.push({ maxTokens: options.maxTokens })
            const reply = replies[Math.min(calls.length - 1, replies.length - 1)]
            return (async function* stream() {
              if (reply.text !== '') yield { type: 'text-delta', text: reply.text }
              yield {
                type: 'finish',
                reason: { kind: reply.truncated === true ? 'max-tokens' : 'stop' },
              }
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
  return { ctx, calls }
}

test('摘要：默认预算足够写完整句子', async () => {
  const { ctx, calls } = makeCtx([{ text: '这是一段完整的摘要，包含时间、地点和两件事。' }])
  const result = await summarize({ ctx, text: '正文正文正文' })
  assert.equal(result, '这是一段完整的摘要，包含时间、地点和两件事。')
  assert.equal(calls[0].maxTokens, SUMMARY_MAX_TOKENS)
  assert.ok(SUMMARY_MAX_TOKENS >= 800)
})

test('摘要：被 token 预算截断时加大预算重跑，不留半句话', async () => {
  const { ctx, calls } = makeCtx([
    { text: '武汉大学地球与空间科学技术学院将举办', truncated: true },
    { text: '武汉大学地球与空间科学技术学院将于11月举办地球物理技能竞赛，报名截止11月5日。' },
  ])
  const result = await summarize({ ctx, text: '正文正文正文' })
  assert.ok(result.startsWith('武汉大学地球与空间科学技术学院将于11月举办'))
  assert.equal(calls.length, 2)
  assert.equal(calls[1].maxTokens, SUMMARY_MAX_TOKENS * 3)
})

test('摘要：重跑还是更短就保留原来的', async () => {
  const { ctx } = makeCtx([
    { text: '一段被截断但还行的摘要内容', truncated: true },
    { text: '短' },
  ])
  const result = await summarize({ ctx, text: '正文正文正文' })
  assert.equal(result, '一段被截断但还行的摘要内容')
})

test('摘要：空回复自动重试一次', async () => {
  const { ctx, calls } = makeCtx([{ text: '' }, { text: '补上了的摘要。' }])
  const result = await summarize({ ctx, text: '正文正文正文' })
  assert.equal(result, '补上了的摘要。')
  assert.equal(calls.length, 2)
})

test('摘要：连续空回复才判定失败', async () => {
  const { ctx } = makeCtx([{ text: '' }])
  const result = await summarize({ ctx, text: '正文正文正文' })
  assert.equal(result, null)
  assert.equal(summarize.lastError, '模型返回空文本')
})

test('摘要：「无有效内容」是哨兵而不是失败', async () => {
  const { ctx } = makeCtx([{ text: '无有效内容' }])
  const result = await summarize({ ctx, text: '正文正文正文' })
  assert.equal(result, summarize.NO_CONTENT)
  assert.equal(summarize.lastError, null)
})

test('摘要：模型报错返回 null 而不是抛栈', async () => {
  const ctx = {
    get(name) {
      if (name === 'llm') {
        return {
          stream() {
            return (async function* stream() {
              yield { type: 'finish', reason: { kind: 'error', failure: { message: '渠道 429' } } }
            })()
          },
        }
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
  }
  const result = await summarize({ ctx, text: '正文' })
  assert.equal(result, null)
  assert.ok(String(summarize.lastError).includes('429'))
})

test('降级摘要：超长截断', () => {
  assert.equal(fallbackSummary('短句'), '短句')
  assert.equal(fallbackSummary('   '), '')
  const long = fallbackSummary('字'.repeat(300), 160)
  assert.equal(long.length, 160)
  assert.ok(long.endsWith('…'))
})

