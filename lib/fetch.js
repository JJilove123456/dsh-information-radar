/**
 * 抓取一个源：发请求 → 识别格式 → 抽条目。
 *
 * 两条通道：
 * - 无自定义请求头：走宿主 `ctx.web.fetch`（公网校验、代理、大小上限都由宿主负责）。
 * - 有自定义请求头（Cookie 等）：用自己的 fetch 发，因为宿主接口不接受自定义头。
 *   这条通道要自己防内网探测：只允许 http/https，且解析后的地址不能是私有网段。
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { detectFormat, parseFeed, blocksOfHtml, extractBySelector, parseSelector, textOf, linksOfHtml, sortByDateDesc } from './parse.js'

export const FETCH_TIMEOUT_MS = 30 * 1000
export const MAX_BODY_CHARS = 400 * 1024

/** 判断一个 IP 是否属于私有/保留网段。 */
export function isPrivateAddress(address) {
  const family = isIP(address)
  if (family === 4) {
    const parts = address.split('.').map(Number)
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true
    const [a, b] = parts
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a >= 224) return true
    return false
  }
  if (family === 6) {
    const lower = address.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('fe80')) return true
    // IPv4 映射地址：::ffff:a.b.c.d
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lower)
    if (mapped !== null) return isPrivateAddress(mapped[1])
    return false
  }
  return true
}

/** 校验 URL 是否可用于抓取；返回错误信息或 null。 */
export function validateUrl(raw) {
  let url
  try {
    url = new URL(String(raw).trim())
  } catch {
    return '不是合法的网址'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '只支持 http 与 https'
  return null
}

/** 解析主机名并确认没有私有地址。 */
async function assertPublicHost(hostname) {
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) throw new Error('目标地址属于私有网段，已拒绝')
    return
  }
  const addresses = await lookup(hostname, { all: true })
  if (addresses.length === 0) throw new Error('域名解析不到地址')
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) throw new Error('域名解析到私有网段，已拒绝')
  }
}

/**
 * 自建请求：带自定义头，自己控超时与大小。
 * @param {boolean} [allowPrivate] 是否允许私网地址（仅供本机测试站使用，默认禁止）
 */
async function fetchWithHeaders(url, headers, allowPrivate = false) {
  const parsed = new URL(url)
  if (!allowPrivate) await assertPublicHost(parsed.hostname)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8',
        ...headers,
      },
      signal: controller.signal,
    })
    const contentType = response.headers.get('content-type') ?? ''
    const text = await response.text()
    return {
      statusCode: response.status,
      contentType,
      body: text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text,
      truncated: text.length > MAX_BODY_CHARS,
      url: response.url || url,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 宿主通道：走 ctx.web.fetch。 */
async function fetchViaHost(web, url) {
  const result = await web.fetch({ url })
  return {
    statusCode: result.statusCode,
    contentType: result.body.kind === 'html' ? 'text/html' : 'text/plain',
    body: result.body.content,
    truncated: result.truncated === true,
    url: result.url ?? url,
  }
}

/**
 * 统一抓取入口：按源配置选通道。
 *
 * 宿主的 ctx.web.fetch 有公网校验，私网地址一律拒绝；
 * 源的 allowPrivate 为 true 时改走自己的 fetch，跳过公网校验（仅供本机测试站）。
 */
async function fetchPage({ web, url, headers, allowPrivate = false }) {
  const hasHeaders = headers !== null && typeof headers === 'object' && Object.keys(headers).length > 0
  if (hasHeaders || allowPrivate === true) {
    try {
      return await fetchWithHeaders(url, headers ?? {}, allowPrivate === true)
    } catch (error) {
      // 私网测试站没有自定义头时，这里是唯一通道，失败就直接抛
      if (allowPrivate === true) throw error
      // 普通源带了头但自建通道失败，退回宿主通道再试一次
      return await fetchViaHost(web, url)
    }
  }
  return await fetchViaHost(web, url)
}

/**
 * 抓取并抽取条目。
 *
 * @returns {Promise<{ok:boolean, error?:string, kind?:string, entries?:Array, blocks?:Array, raw?:string}>}
 */
export async function fetchSource({ web, source, headers }) {
  const invalid = validateUrl(source.url)
  if (invalid !== null) return { ok: false, error: `${source.name}：${invalid}` }

  let page
  try {
    page = await fetchPage({ web, url: source.url, headers, allowPrivate: source.allowPrivate === true })
  } catch (error) {
    return { ok: false, error: describeFetchError(error) }
  }

  if (page.statusCode >= 400) {
    return { ok: false, error: `HTTP ${page.statusCode}` }
  }

  const format = detectFormat(page.contentType, page.body)
  if (format === 'feed') {
    let feed
    try {
      feed = parseFeed(page.body)
    } catch (error) {
      return { ok: false, error: `RSS 解析失败：${String(error?.message ?? error)}` }
    }
    const entries = feed.entries
      .map((entry) => ({
        title: entry.title,
        summary: entry.summary,
        // RSS 自带的条目链接才是「内容地址」，没有时才退回母页
        url: entry.url !== '' ? entry.url : source.url,
        publishedAt: entry.publishedAt,
        text: `${entry.title}\n${entry.summary}`.trim(),
      }))
      .filter((entry) => entry.text !== '')
      .filter((entry) => !(entry.url === source.url && entry.text === ''))
    // 有日期的按日期从新到旧；RSS 本身通常已是倒序，sortByDateDesc 会保持稳定
    return { ok: true, kind: feed.kind, entries: sortByDateDesc(entries), blocks: [], raw: page.body }
  }

  // HTML：先按选择器圈定范围。
  let html = page.body
  let selectorMissed = false
  if (source.selector !== '') {
    let parts
    try {
      parts = parseSelector(source.selector)
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
    const scoped = extractBySelector(html, parts)
    if (scoped === null) selectorMissed = true
    else html = scoped
  }
  if (selectorMissed) {
    return { ok: false, error: `选择器 "${source.selector}" 没有匹配到内容，可能页面结构改了` }
  }

  // 列表型页面优先按 <a> 抽条目：这样每条都有自己的子页面地址，
  // 而不是全部指向母页面。抽不到链接（例如纯正文页）时才退回按块切分。
  //
  // 关键：先尝试把范围收缩到「列表容器」内。列表页常把侧栏推荐新闻也写成 <a>，
  // 那些条目通常没有日期，会混进来（本科生院页面的 6 条侧栏新闻就是这样）。
  // 有日期的一律保留；没日期的只在「列表容器内」才接受。
  const pageUrl = page.url ?? source.url
  const listScope = listContainerOf(html)
  const scopedHtml = listScope ?? html
  const linked = linksOfHtml(scopedHtml, pageUrl)
  if (linked.length > 0) {
    const entries = linked.map((item) => ({
      title: item.title,
      summary: '',
      url: item.url,
      publishedAt: item.publishedAt,
      // 列表页只能拿到标题，正文要等子页面抓回来再补
      text: item.text,
      needsDetail: true,
    }))
    return {
      ok: true,
      kind: 'list',
      entries: sortByDateDesc(entries),
      blocks: [],
      raw: page.body,
      pageUrl,
      listScoped: listScope !== null,
      pageTitle: textOf(html).slice(0, 120),
    }
  }

  const blocks = blocksOfHtml(html)
  const titleText = textOf(html).slice(0, 120)
  const blockEntries = blocks.map((text) => ({
    title: firstLineOf(text),
    summary: restOf(text),
    url: pageUrl,
    publishedAt: '',
    text,
    needsDetail: false,
  }))
  return {
    ok: true,
    kind: 'html',
    blocks,
    entries: sortByDateDesc(blockEntries),
    raw: page.body,
    pageTitle: titleText,
  }
}

/**
 * 找「列表容器」：页面上真正承载条目列表的那一块。
 *
 * 命中后只在它内部抽 <a>，避免侧栏推荐新闻混进结果。
 * 逐个尝试常见容器类名，取包含链接最多的那个（至少 3 个链接才算）。
 */
export function listContainerOf(html) {
  const CANDIDATES = [
    'list_txt',
    'list',
    'news-list',
    'news_list',
    'article-list',
    'article_list',
    'content-list',
    'ul-list',
  ]
  let best = null
  let bestCount = 0
  for (const className of CANDIDATES) {
    let parts
    try {
      parts = parseSelector(`.${className}`)
    } catch {
      continue
    }
    const scoped = extractBySelector(html, parts)
    if (scoped === null) continue
    const count = (scoped.match(/<a\b/giu) ?? []).length
    if (count > bestCount) {
      best = scoped
      bestCount = count
    }
  }
  return bestCount >= 3 ? best : null
}

/**
 * 详情页正文提取：取「最长的连续正文段」，甩掉侧栏推荐位。
 *
 * 判定依据：正文段落通常较长（>= 40 字），而「上一条 / 相关新闻 / 推荐阅读」
 * 这类侧栏条目很短。所以把连续的长块当作正文，遇到长串短块就断开分段，
 * 再取最长的一段。
 */
export function mainContentOf(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return ''
  if (blocks.length <= 2) return blocks.join('\n').trim()

  const LONG = 40
  const segments = []
  let current = []
  let shortRun = 0
  for (const block of blocks) {
    const isLong = block.length >= LONG
    if (isLong) {
      current.push(block)
      shortRun = 0
      continue
    }
    shortRun += 1
    // 连续 2 个短块之后视为正文结束：侧栏区通常成片出现
    if (shortRun >= 2) {
      if (current.length > 0) segments.push(current)
      current = []
      shortRun = 0
    } else {
      current.push(block)
    }
  }
  if (current.length > 0) segments.push(current)

  if (segments.length === 0) return blocks.join('\n').trim()
  // 取总字数最长的一段
  let best = segments[0]
  let bestScore = best.reduce((sum, text) => sum + text.length, 0)
  for (const segment of segments.slice(1)) {
    const score = segment.reduce((sum, text) => sum + text.length, 0)
    if (score > bestScore) {
      best = segment
      bestScore = score
    }
  }
  return best.join('\n').trim()
}

/**
 * 详情页正文容器候选选择器。
 *
 * 大多数 CMS（含武汉大学用的这套）会把正文包在一个有明确 class 的容器里，
 * 而侧栏推荐位在容器外。优先按这些通用容器取，比「猜最长段落」可靠得多。
 * 顺序按命中率排：越靠前越常见。
 */
const DETAIL_CONTAINERS = [
  'v_news_content',
  'article-content',
  'article_content',
  'news_content',
  'news-content',
  'content-body',
  'post-content',
  'entry-content',
  'article-body',
  'main-content',
  'content',
]

/**
 * 从详情页 HTML 里取正文：先试通用容器，取不到再退回「最长连续段」。
 */
export function detailTextOf(html) {
  const scoped = detailContainerOf(html)
  if (scoped !== null) {
    // 容器已经确认是正文区，块的最小长度放低一点，避免把短句丢掉
    const blocks = blocksOfHtml(scoped, { minChars: 8, maxBlocks: 120 })
    const text = blocks.join('\n').trim()
    if (text.length >= 15) return text
  }
  const blocks = blocksOfHtml(html, { minChars: 12, maxBlocks: 80 })
  return mainContentOf(blocks)
}

/**
 * 取正文容器的 HTML 片段（找不到返回 null）。
 *
 * 子网页链接必须在这个范围内找：整页找会把侧栏「相关新闻」当成子页面，
 * 而那些并不是这条内容的组成部分。
 *
 * 判定不只看绝对长度（短通知也是正文），还要看「这段内容占了整页多少」：
 * 真正的正文容器通常包含页面里相当比例的可见文字。
 */
export function detailContainerOf(html) {
  const pageText = blocksOfHtml(html, { minChars: 10, maxBlocks: 200 }).join('')
  for (const className of DETAIL_CONTAINERS) {
    let parts
    try {
      parts = parseSelector(`.${className}`)
    } catch {
      continue
    }
    const scoped = extractBySelector(html, parts)
    if (scoped === null) continue
    const text = blocksOfHtml(scoped, { minChars: 8, maxBlocks: 80 }).join('')
    if (text.length < 20) continue
    // 容器里的文字要么够长，要么占整页相当大的比例（短通知的情形）
    const share = pageText.length === 0 ? 1 : text.length / pageText.length
    if (text.length >= 60 || share >= 0.5) return scoped
  }
  return null
}

/**
 * 判断一段正文是不是「只有报名表/附件、没有实质信息」。
 *
 * 用户要的是：这类页面不呈现正文，只提示「内涵报名表」并附链接。
 * 判定依据是「正文很短 + 出现附件/报名类关键词 + 几乎没有正文句」。
 */
export function looksLikeAttachmentOnly(text, title = '') {
  const body = String(text ?? '').trim()
  const heading = String(title ?? '')
  const haystack = `${heading}\n${body}`
  const ATTACH_HINTS = [
    /附件/u,
    /报名表/u,
    /申请表/u,
    /汇总表/u,
    /登记表/u,
    /回执/u,
    /下载/u,
    /\.(pdf|docx?|xlsx?|zip|rar)\b/iu,
  ]
  const hit = ATTACH_HINTS.filter((re) => re.test(haystack)).length
  if (hit === 0) return null

  // 正文去掉附件名之后，实质内容少于 200 字就认为「只有表，没有信息」
  const stripped = body
    .replace(/\S+\.(pdf|docx?|xlsx?|zip|rar)/giu, ' ')
    .replace(/附件\s*\d*/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (stripped.length >= 200) return null

  // 给出人类可读的说明：是什么表
  let note = '内涵附件'
  if (/报名表/u.test(haystack)) note = '内涵报名表'
  else if (/申请表/u.test(haystack)) note = '内涵申请表'
  else if (/汇总表/u.test(haystack)) note = '内涵汇总表'
  else if (/登记表/u.test(haystack)) note = '内涵登记表'
  else if (/回执/u.test(haystack)) note = '内涵回执'
  return note
}

/**
 * 从详情页里找「下一层」链接：用于递归抓取子网页的子网页。
 *
 * 只保留看起来像内容页的链接（排除下载文件、明显的表单、外站首页）。
 */
export function childLinksOf(html, baseUrl, limit = 8) {
  // 子页面标题往往很短（「参会须知」「附件1」之类），阈值要放低
  const links = linksOfHtml(html, baseUrl, { minChars: 3, maxItems: 60 })
  const out = []
  const seen = new Set()
  for (const link of links) {
    if (out.length >= limit) break
    if (seen.has(link.url)) continue
    // 跳过附件下载
    if (/\.(pdf|docx?|xlsx?|zip|rar|7z)(\?|$)/iu.test(link.url)) continue
    // 跳过明显不是内容页的
    if (/\/(login|search|index|list|tzgg|xwdt)(\.|$|\/)/iu.test(new URL(link.url).pathname) && link.url === baseUrl) continue
    seen.add(link.url)
    out.push(link)
  }
  return out
}

/**
 * 抓子页面正文，用于「总结子网址的内容」。
 *
 * @param {object} options
 * @param {number} [options.limit] 本轮最多补几条
 * @param {number} [options.depth] 还允许往下递归几层（0 表示只抓这一层）
 */
export async function enrichWithDetail({ web, entries, source, headers, limit = 20, depth = 1 }) {
  const pending = entries.filter((entry) => entry.needsDetail === true)
  if (pending.length === 0) return entries

  const targets = pending.slice(0, limit)
  const results = new Map()

  const fetchOne = async (url) => {
    const page = await fetchPage({
      web,
      url,
      headers,
      allowPrivate: source?.allowPrivate === true,
    })
    if (page.statusCode >= 400) return null
    if (detectFormat(page.contentType, page.body) === 'feed') return null
    return page
  }

  /**
   * 递归抓一层：拿到「这一页的正文 + 它下面挂的子页」。
   *
   * 之前只写死了一层，子页里的孙页链接不会被跟进，表现为「孙页 0 个」。
   * 现在按 remainingDepth 递归，每层都只在正文容器内找链接。
   */
  const fetchLayer = async (url, title, remainingDepth) => {
    const page = await fetchOne(url)
    if (page === null) return null
    const text = detailTextOf(page.body)
    const node = {
      title,
      url,
      text: text.slice(0, 4000),
      attachmentOnly: false,
      attachmentNote: '',
      children: [],
    }
    if (remainingDepth <= 0) return node

    const note = looksLikeAttachmentOnly(text, title)
    if (note !== null) {
      node.attachmentOnly = true
      node.attachmentNote = note
    }

    const container = detailContainerOf(page.body)
    const childLinks = container === null ? [] : childLinksOf(container, url, 5)
    const fetched = []
    for (const child of childLinks) {
      if (fetched.length >= 3) break
      try {
        const childNode = await fetchLayer(child.url, child.title, remainingDepth - 1)
        if (childNode === null) continue
        // 正文极短且没有更下层内容时才丢掉（短通知也算有效内容）
        if (childNode.text.length < 15 && childNode.children.length === 0) continue
        fetched.push(childNode)
      } catch {
        /* 单个子页失败跳过 */
      }
    }
    node.children = fetched
    return node
  }

  for (let index = 0; index < targets.length; index += 3) {
    const batch = targets.slice(index, index + 3)
    await Promise.all(
      batch.map(async (entry) => {
        try {
          const page = await fetchOne(entry.url)
          if (page === null) return
          const main = detailTextOf(page.body)

          // 递归：只在正文容器内部找下一层链接。
          // 整页找会把侧栏「相关新闻」误当子页面，那些并不是这条内容的组成部分。
          let children = []
          if (depth > 0) {
            const container = detailContainerOf(page.body)
            const childLinks = container === null ? [] : childLinksOf(container, entry.url, 5)
            const fetched = []
            for (const child of childLinks) {
              if (fetched.length >= 3) break
              try {
                const childNode = await fetchLayer(child.url, child.title, depth - 1)
                if (childNode === null) continue
                // 正文极短且无更下层内容时才丢掉
                if (childNode.text.length < 15 && childNode.children.length === 0) continue
                fetched.push(childNode)
              } catch {
                /* 单个子页失败跳过 */
              }
            }
            children = fetched
          }

          results.set(entry.key ?? entry.url, { main, children })
        } catch {
          /* 单条失败忽略，保留列表页标题 */
        }
      }),
    )
  }

  for (const entry of entries) {
    const detail = results.get(entry.key ?? entry.url)
    if (detail === undefined) continue
    entry.needsDetail = false
    entry.detailFetched = true
    entry.children = detail.children
    // 附件型：只留说明，不留正文
    const note = looksLikeAttachmentOnly(detail.main, entry.title)
    if (note !== null) {
      entry.attachmentOnly = true
      entry.attachmentNote = note
      entry.text = `${entry.title}\n${note}`
      entry.summary = ''
      continue
    }
    entry.text = `${entry.title}\n${detail.main}`.trim()
    entry.summary = detail.main.slice(0, 400)
  }
  return entries
}

/** 从一段标签文本里读属性值；fetch.js 自己用，不依赖 parse.js 的内部实现。 */
function attrOf(tagText, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu')
  const match = pattern.exec(String(tagText))
  if (match === null) return ''
  return match[2] ?? match[3] ?? match[4] ?? ''
}

/**
 * 从列表页里找「下一页」链接。
 *
 * 常见写法：
 *   <a href="index_1.htm">下一页</a>
 *   <a href="?page=2">2</a> / <a href="list_2.html">
 *   class 里带 next / page-next 的链接
 */
export function nextPageUrlOf(html, baseUrl) {
  const links = linksOfHtml(html, baseUrl, { minChars: 1, maxItems: 200 })
  // 先按文字找「下一页」
  for (const link of links) {
    if (/^(下一页|下页|next|Next|›|»)$/u.test(link.title.trim())) return link.url
  }
  // 再按 URL 特征找：页码比当前大一位
  const current = new URL(baseUrl)
  const candidates = []
  const re = /<a\b([^>]*)>([\s\S]{0,40}?)<\/a\s*>/giu
  let match
  while ((match = re.exec(html)) !== null) {
    const tagText = `<a${match[1]}>`
    const rawHref = attrOf(tagText, 'href').trim()
    if (rawHref === '' || rawHref.startsWith('#')) continue
    let absolute
    try {
      absolute = new URL(rawHref, baseUrl).toString()
    } catch {
      continue
    }
    if (absolute === baseUrl) continue
    // 去页码后缀后的「基路径」：xstz.htm / xstz_1.htm / xstz-2.htm 都归到 xstz
    const stripPage = (pathname) => pathname.replace(/([_-]\d+)?\.(html?|jsp|php)$/iu, '')
    const samePath = stripPage(new URL(absolute).pathname) === stripPage(current.pathname)
    if (!samePath) continue
    // 页码递增的候选：带分隔符的数字后缀，或 ?page=N
    const numMatch = /[_-](\d+)\.(html?|jsp|php)$/iu.exec(new URL(absolute).pathname) ??
      /[?&]page=(\d+)/iu.exec(new URL(absolute).search)
    if (numMatch === null) continue
    // xstz_1.htm 是第 2 页，所以页码 = 后缀 + 1
    candidates.push({ url: absolute, page: Number(numMatch[1]) + 1 })
  }
  if (candidates.length === 0) return null
  // 页码基准：`xstz.htm`（无数字后缀）算第 1 页
  const currentSuffix = /[_-](\d+)\.(html?|jsp|php)$/iu.exec(current.pathname)?.[1]
  const currentQuery = /[?&]page=(\d+)/iu.exec(current.search)?.[1]
  const currentPage = currentQuery !== undefined ? Number(currentQuery) : currentSuffix === undefined ? 1 : Number(currentSuffix) + 1
  candidates.sort((a, b) => a.page - b.page)
  const next = candidates.find((item) => item.page > currentPage)
  return next === undefined ? null : next.url
}

/**
 * 翻页抓取更早的内容。
 *
 * 用户要求：从第一页开始向后翻，一旦发现某一页的内容「已经见过」（时间线追上已读位置）
 * 就停止，节约请求。所以这里边翻边判：本页不产生任何新条目时立刻收手。
 *
 * @param {object} options
 * @param {number} [options.maxPages] 最多翻几页，防止无限翻
 * @param {(entries: Array) => Promise<number>} options.countNew 回调：返回本页真正新增的条数
 */
export async function crawlPages({ web, headers, startUrl, startHtml, maxPages = 5, countNew, source }) {
  const collected = []
  let html = startHtml
  let url = startUrl
  const visited = new Set([startUrl])

  for (let page = 1; page <= maxPages; page += 1) {
    const nextUrl = nextPageUrlOf(html, url)
    if (nextUrl === null) break
    if (visited.has(nextUrl)) break
    visited.add(nextUrl)

    let pageData
    try {
      pageData = await fetchPage({ web, url: nextUrl, headers, allowPrivate: source?.allowPrivate === true })
    } catch {
      break
    }
    if (pageData.statusCode >= 400) break
    if (detectFormat(pageData.contentType, pageData.body) === 'feed') break

    let scoped = pageData.body
    if (source.selector !== '') {
      try {
        const parts = parseSelector(source.selector)
        const found = extractBySelector(scoped, parts)
        if (found !== null) scoped = found
      } catch {
        break
      }
    }

    const pageUrl = pageData.url ?? nextUrl
    const entries = linksOfHtml(scoped, pageUrl).map((item) => ({
      title: item.title,
      summary: '',
      url: item.url,
      publishedAt: item.publishedAt,
      text: item.text,
      needsDetail: true,
    }))

    if (entries.length === 0) break

    // 交给调用方去重：如果这一页一条新的都没有，说明已经追到见过的旧内容了
    const newCount = await countNew(entries)
    if (newCount === 0) {
      // 这一页全是旧内容 → 时间线已追上，不再往后翻
      break
    }
    collected.push(...entries)
    url = pageUrl
    html = pageData.body
  }
  return collected
}

function firstLineOf(text) {
  const line = String(text).split(/\n/u)[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 117)}…` : line
}

function restOf(text) {
  const lines = String(text).split(/\n/u)
  if (lines.length === 1) return text.length > 300 ? `${text.slice(0, 297)}…` : text
  return lines.slice(1).join('\n').trim()
}

function describeFetchError(error) {
  const code = String(error?.code ?? '')
  const message = String(error?.message ?? error)
  if (code === 'WEB_BLOCKED_URL') return '目标地址不在公网，已被拒绝'
  if (code === 'WEB_REDIRECT_BLOCKED') return '跨域重定向被拒，请直接填写最终地址'
  if (code === 'WEB_FETCH_TIMEOUT') return '请求超时'
  if (code === 'WEB_UNSUPPORTED_CONTENT_TYPE') return '该地址返回的不是网页或订阅源'
  if (/abort/iu.test(message)) return '请求超时或被取消'
  return message
}

/**
 * 关键词过滤：包含词命中任意一个即保留，排除词命中任意一个即丢弃。
 * 两者都为空时全部保留。
 */
export function filterEntries(entries, source) {
  const include = source.includeKeywords.map((k) => k.toLowerCase()).filter(Boolean)
  const exclude = source.excludeKeywords.map((k) => k.toLowerCase()).filter(Boolean)
  return entries.filter((entry) => {
    const haystack = `${entry.title}\n${entry.summary}\n${entry.text}`.toLowerCase()
    if (exclude.some((word) => haystack.includes(word))) return false
    if (include.length === 0) return true
    return include.some((word) => haystack.includes(word))
  })
}
