/**
 * 自动总结。
 *
 * 走宿主 llm 服务：路由取 agentDefaultModel.currentSelection()，
 * 用 prepareCall 拿到校验过的 config，再 stream 收集文本。
 * 任何一步失败都返回 null，由调用方降级为「截断原文」，绝不因为总结失败丢掉整条内容。
 */
export const SUMMARY_TIMEOUT_MS = 60 * 1000
/**
 * 单次摘要的 token 预算。
 *
 * 300 太小：开推理时预算被 reasoning 吃掉，正文只够输出半句话，
 * 面板里就出现「武汉大学地球与空间科学技术学院将举办」这种残句。
 * 1200 足够 1~3 句中文；万一还是被截断，会按 3 倍预算重跑一次。
 */
export const SUMMARY_MAX_TOKENS = 1200

const SYSTEM_PROMPT = [
  '你是信息摘要助手。把用户给的内容压缩成 1 到 3 句中文要点。',
  '规则：',
  '1. 只陈述内容本身的事实，不评价、不加开场白、不写「这篇文章」。',
  '2. 不要输出 Markdown、链接或标题。',
  '3. 即使内容只是一段导语、标题列表或片段，也要照实概括它说了什么，不要拒绝。',
  '4. 只有当内容完全是空白的乱码、纯占位符（如 -.--）或纯导航链接时，才回复：无有效内容',
].join('\n')

/**
 * 从 stream 里拼出正文；只收 text-delta，reasoning 不要。
 *
 * 同时记下「是不是被 token 预算截断」——被截断时模型只输出半句话
 * （例如「武汉大学地球与空间科学技术学院将举办」），必须重跑更长预算，
 * 否则存进面板的就是残句。
 */
async function collectText(stream) {
  let text = ''
  let truncated = false
  for await (const chunk of stream) {
    const type = chunk?.type
    if (type === 'text-delta') text += chunk.text ?? ''
    else if (type === 'finish') {
      const kind = chunk.reason?.kind ?? chunk.kind
      if (kind === 'error' || kind === 'aborted') {
        const failure = chunk.reason?.failure ?? chunk.failure
        throw new Error(String(failure?.message ?? '模型调用失败'))
      }
      if (kind === 'max-tokens' || kind === 'length') truncated = true
    }
  }
  return { text: text.trim(), truncated }
}

/**
 * 对一条内容做摘要。
 * @returns {Promise<string|null>} null 表示没做成，调用方降级
 */
export async function summarize({ ctx, text, maxChars = 6000 }) {
  const llm = ctx.get?.('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    summarize.lastError = '宿主没有 llm 服务'
    return null
  }

  const modelService = ctx.get?.('agentDefaultModel')
  let selection = null
  try {
    selection = modelService?.currentSelection?.() ?? null
  } catch {
    selection = null
  }
  if (selection === null || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
    summarize.lastError = '拿不到默认模型路由'
    return null
  }

  const input = String(text).slice(0, maxChars)
  if (input.trim() === '') {
    summarize.lastError = '输入为空'
    return null
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS)
  try {
    const runOnce = (maxTokens) => {
      const options = {
        provider: selection.provider,
        model: selection.model,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
        maxTokens,
        signal: controller.signal,
      }
      if (typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== '') {
        options.reasoningEffort = selection.reasoningEffort
      }
      return collectText(llm.stream(options))
    }

    let out = await runOnce(SUMMARY_MAX_TOKENS)
    // 模型偶尔会返回空文本（试过同一批 9 条里 3～4 条空），
    // 空回复重试一次就能救回来；真失败才降级。
    if (out.text === '' && !controller.signal.aborted) {
      out = await runOnce(SUMMARY_MAX_TOKENS)
    }
    // 被 token 预算截断时会得到半句话，加大预算重跑一次，取更长的结果
    if (out.truncated && out.text !== '' && !controller.signal.aborted) {
      const retry = await runOnce(SUMMARY_MAX_TOKENS * 3)
      if (retry.text.length > out.text.length) out = retry
    }
    const text2 = out.text
    if (text2 === '') {
      summarize.lastError = '模型返回空文本'
      return null
    }
    // 模型明确判定「无有效内容」是正常结论，不是失败：
    // 直接返回这个标记，让调用方决定丢弃这条，而不是记成「总结失败」。
    if (text2.includes('无有效内容')) {
      summarize.lastError = null
      return summarize.NO_CONTENT
    }
    summarize.lastError = null
    return text2
  } catch (error) {
    summarize.lastError = String(error?.message ?? error)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 最近一次失败原因，面板用来解释「为什么没总结」。 */
summarize.lastError = null
/** 「模型认为这条没有价值」的哨兵值，与「总结失败」区分开。 */
summarize.NO_CONTENT = Symbol('no-content')

/** 降级：没有摘要时截断原文。 */
export function fallbackSummary(text, limit = 160) {
  const normalized = String(text).replace(/\s+/gu, ' ').trim()
  if (normalized === '') return ''
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}

