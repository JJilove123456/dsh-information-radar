/**
 * 推送通道抽象。
 *
 * 只保留一种真实通道：通过已装的 @xmanrui/dsh-im 机器人投递
 * （微信 / QQ / 飞书 / 钉钉等由那个插件负责，信息雷达不自己接 QQ）。
 * 推送整体是可选项，默认不开启。
 *
 * dshIm 的调用有两条路，按可用性自动选：
 * 1) 同 Host 插件：ctx.dshIm.send(botId, targetId, text)
 * 2) HTTP 回退：POST <origin>/api/dsh-im/delivery/messages
 * 两条都失败时要能说清失败原因，而不是静默不发。
 */
import { DEFAULT_PUSH_HINT } from './store.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 通道清单：推送只有「不开」和「走 IM 机器人」两种状态。 */
export const CHANNELS = [
  { id: 'none', label: '不推送' },
  { id: 'dshIm', label: 'DSH-IM 机器人（微信 / QQ / 飞书 / 钉钉…）' },
]

/**
 * 探测本机是否装了 dsh-im。
 * @param {object} ctx 宿主 context
 * @param {string} [origin] Web 根地址，用于 HTTP 回退
 */
export async function detectDshIm(ctx, origin) {
  const service = ctx.get?.('dshIm')
  const viaService = service !== undefined && typeof service.send === 'function'
  if (viaService) {
    let bots = []
    try {
      bots = typeof service.listBots === 'function' ? await service.listBots() : []
    } catch {
      bots = []
    }
    return { available: true, via: 'service', bots, error: null }
  }
  // 没有服务时探测 HTTP 路由：缺参数会返回 400，说明路由在
  if (typeof origin === 'string' && origin !== '') {
    try {
      const response = await fetch(`${origin.replace(/\/+$/u, '')}/api/dsh-im/delivery/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(4000),
      })
      if (response.status === 400) {
        // 路由存在且能处理请求，只是我们没给必填字段
        return { available: true, via: 'http', bots: [], error: null }
      }
      if (response.status === 404) {
        return { available: false, via: null, bots: [], error: '没有找到 dsh-im 的投递接口' }
      }
      return { available: false, via: null, bots: [], error: `dsh-im 返回 HTTP ${response.status}` }
    } catch (error) {
      return { available: false, via: null, bots: [], error: String(error?.message ?? error) }
    }
  }
  return { available: false, via: null, bots: [], error: '本机没有安装 @xmanrui/dsh-im' }
}

/** 列出某个机器人已配置的投递目标。 */
export async function listDshImTargets(ctx, botId) {
  const service = ctx.get?.('dshIm')
  if (service !== undefined && typeof service.listTargets === 'function') {
    try {
      return { ok: true, targets: await service.listTargets(botId) }
    } catch (error) {
      return { ok: false, targets: [], error: String(error?.message ?? error) }
    }
  }
  return { ok: false, targets: [], error: '当前没有可列出目标的 dsh-im 服务' }
}

/**
 * 列出「可以投递的会话」建议。
 *
 * dsh-im 会把机器人聊过的会话记录下来，`listSuggestions` 把这些会话
 * 转成投递路由（kind + route）。用户没手动建目标时，界面上用它们兜底，
 * 免得下拉框空着没法选。
 */
export async function listDshImSuggestions(ctx, botId) {
  const service = ctx.get?.('dshIm')
  if (service === undefined || typeof service.listSuggestions !== 'function') {
    return { ok: false, suggestions: [], error: '当前 dsh-im 不支持会话建议' }
  }
  try {
    const result = await service.listSuggestions(botId)
    const list = Array.isArray(result?.suggestions) ? result.suggestions : []
    return { ok: true, suggestions: list, error: null }
  } catch (error) {
    return { ok: false, suggestions: [], error: String(error?.message ?? error) }
  }
}

/**
 * 兜底：从 dsh-im 的渠道配置里读「机器人主人」的会话路由。
 *
 * dsh-im 5.x 暴露给同 Host 插件的服务只有 send / listTargets / createTarget，
 * 没有 `listSuggestions`；但每个渠道的 `config.json` 里记了 owner 的平台 id
 * （例如 QQ 的 `ownerUserOpenid`）。用户还没建过任何投递目标时，用它可以
 * 直接生成一条「私聊主人」的路由，免去手动填 openid。
 *
 * 只读、只认 `integrations/dsh-<channel>/config.json`，读不到就返回空数组。
 */
const OWNER_FIELDS = {
  qq: { key: 'ownerUserOpenid', kind: 'user', field: 'userOpenId' },
  weixin: { key: 'ownerUserId', kind: 'user', field: 'toUserId' },
  feishu: { key: 'ownerOpenId', kind: 'user', field: 'openId' },
  dingtalk: { key: 'ownerUserId', kind: 'user', field: 'userId' },
  wecom: { key: 'ownerUserId', kind: 'user', field: 'chatId' },
  'wecom-app': { key: 'ownerUserId', kind: 'user', field: 'chatId' },
  telegram: { key: 'ownerChatId', kind: 'chat', field: 'chatId' },
  slack: { key: 'ownerUserId', kind: 'conversation', field: 'channelId' },
  discord: { key: 'ownerUserId', kind: 'channel', field: 'channelId' },
  whatsapp: { key: 'ownerJid', kind: 'user', field: 'jid' },
  imessage: { key: 'ownerChatGuid', kind: 'user', field: 'chatGuid' },
  matrix: { key: 'ownerUserId', kind: 'dm', field: 'userId' },
}

function dshHomeDir() {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') return home.trim()
  return join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
}

/**
 * 读某个机器人的「主人会话」路由。
 * @returns {Array<{kind:string, route:object}>}
 */
export function readOwnerSuggestion(channel, botId) {
  if (typeof channel !== 'string' || channel === '' || typeof botId !== 'string' || botId === '') return []
  const path = join(dshHomeDir(), 'integrations', `dsh-${channel}`, 'config.json')
  if (!existsSync(path)) return []
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
  const bots = Array.isArray(parsed?.bots) ? parsed.bots : []
  const bot = bots.find((entry) => entry?.botId === botId)
  if (bot === null || typeof bot !== 'object') return []
  const known = OWNER_FIELDS[channel]
  if (known !== undefined) {
    const value = bot[known.key]
    if (typeof value === 'string' && value.trim() !== '') {
      return [{ kind: known.kind, route: { [known.field]: value.trim() } }]
    }
  }
  // 字段名对不上时退一步：找任何 owner 开头的字符串字段，按渠道默认字段塞进去
  const fallbackField = known?.field ?? 'userId'
  for (const [key, value] of Object.entries(bot)) {
    if (!/^owner/iu.test(key)) continue
    if (typeof value !== 'string' || value.trim() === '') continue
    return [{ kind: known?.kind ?? 'user', route: { [fallbackField]: value.trim() } }]
  }
  return []
}

/**
 * 把一条会话建议注册成真正的投递目标。
 *
 * 目标 id 用 `info-radar`，被占用就加序号；成功后返回可长期使用的 targetId，
 * 这样推送不必每次带着平台原生路由，也能在 dsh-im 的目标列表里看到。
 */
export async function createDshImTarget(ctx, botId, { kind, route, name } = {}) {
  const service = ctx.get?.('dshIm')
  if (service === undefined || typeof service.createTarget !== 'function') {
    return { ok: false, error: '当前 dsh-im 不支持创建投递目标' }
  }
  if (typeof kind !== 'string' || kind === '' || route === null || typeof route !== 'object') {
    return { ok: false, error: '缺少目标类型或平台路由' }
  }
  // 先读已有目标，挑一个没被占用的 id；读不到就靠冲突重试
  const taken = new Set()
  try {
    const envelope = await service.listTargets(botId)
    const list = Array.isArray(envelope) ? envelope : envelope?.targets
    for (const entry of Array.isArray(list) ? list : []) {
      if (typeof entry?.targetId === 'string') taken.add(entry.targetId)
    }
  } catch {
    /* 列不出来时继续尝试 */
  }
  const candidates = ['info-radar', 'info-radar-2', 'info-radar-3', 'info-radar-4', 'info-radar-5']
  let lastError = ''
  for (const candidate of candidates) {
    if (taken.has(candidate)) continue
    try {
      const created = await service.createTarget(botId, {
        targetId: candidate,
        kind,
        route,
        ...(typeof name === 'string' && name !== '' ? { name } : {}),
      })
      return { ok: true, targetId: created?.targetId ?? candidate }
    } catch (error) {
      lastError = String(error?.message ?? error)
      if (!/conflict|已存在|exists/iu.test(lastError)) break
    }
  }
  return { ok: false, error: lastError === '' ? '创建投递目标失败' : lastError }
}

/**
 * 把一批条目拼成一条推送正文；上限 3 条，超出只写「其余 N 条」。
 *
 * 末尾固定带一句引导语：用户回一句「看不懂」或「解释一下」就能追问。
 * 这句话对所有渠道都一样（微信 / QQ / 飞书 / 钉钉…），不针对某个平台写死。
 */
export function composePushText({ sourceName, items, totalCount, maxEntries = 3, hint }) {
  const shown = items.slice(0, maxEntries)
  const lines = [`【${sourceName}】新内容 ${totalCount} 条`]
  shown.forEach((item, index) => {
    const summary = String(item.summary ?? '').replace(/\s+/gu, ' ').trim()
    const note = String(item.attachmentOnly === true ? (item.attachmentNote ?? '') : '').replace(/\s+/gu, ' ').trim()
    lines.push(`${index + 1}. ${item.title}`)
    if (summary !== '') lines.push(`   ${summary}`)
    // 附件型条目没有正文（只有报名表/名单），至少把「内涵附件」说清楚，别让消息只剩标题
    else if (note !== '') lines.push(`   ${note}，请点链接看原文`)
    if (typeof item.url === 'string' && item.url !== '') lines.push(`   ${item.url}`)
  })
  const rest = totalCount - shown.length
  // 一批超过上限时，剩下的不是丢掉，是下一轮接着推；说清楚，别让人以为没了
  if (rest > 0) lines.push(`… 另有 ${rest} 条会在下一次推送里发出`)
  // 默认引导语；可以按配置覆盖或留空关掉
  const trailing = hint === undefined ? DEFAULT_PUSH_HINT : String(hint).trim()
  if (trailing !== '') {
    lines.push('')
    lines.push(trailing)
  }
  return lines.join('\n')
}

/**
 * 通过 dsh-im 发一条文字。
 *
 * targetId 是已保存目标的别名；没有别名时用 draft（`{kind, route}`）
 * 直接发——dsh-im 的 send 接受这种临时目标，用户不必先去设置页建目标。
 * @returns {Promise<{ok:boolean, via?:string, error?:string}>}
 */
export async function sendViaDshIm({ ctx, origin, botId, targetId, draft, text, format = 'plain' }) {
  // dsh-im 对临时目标做严格字段校验，只能带 kind + route；
  // 我们自己的 draft 上还挂了给界面看的 label，这里要剥掉。
  const cleanDraft = draft !== null && typeof draft === 'object' && typeof draft.kind === 'string' && draft.route !== null && typeof draft.route === 'object'
    ? { kind: draft.kind, route: draft.route }
    : null
  const recipient = typeof targetId === 'string' && targetId !== '' ? targetId : cleanDraft
  if (recipient === null) return { ok: false, error: '没有可用的投递目标' }
  const service = ctx.get?.('dshIm')
  if (service !== undefined && typeof service.send === 'function') {
    try {
      const result = await service.send(botId, recipient, text, { format })
      if (result?.sent === true) return { ok: true, via: 'service' }
      return { ok: false, error: 'dsh-im 没有返回 sent:true' }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  // HTTP 回退只认已保存的 targetId，临时目标没法走这条
  if (typeof recipient !== 'string') {
    return { ok: false, error: '临时目标需要 dsh-im 服务，HTTP 回退只能发已保存的目标' }
  }
  if (typeof origin !== 'string' || origin === '') return { ok: false, error: '没有可用的 dsh-im 服务或地址' }
  try {
    const response = await fetch(`${origin.replace(/\/+$/u, '')}/api/dsh-im/delivery/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId, targetId: recipient, text, format }),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return { ok: false, error: `HTTP ${response.status}${detail === '' ? '' : `：${detail.slice(0, 200)}`}` }
    }
    const payload = await response.json().catch(() => null)
    if (payload?.sent === true) return { ok: true, via: 'http' }
    return { ok: false, error: '投递接口返回成功但不是 sent:true' }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}
