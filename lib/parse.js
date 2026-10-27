/**
 * 抓取结果的解析：HTML 正文块 / RSS 条目 / 二者自动识别。
 *
 * 不引入第三方依赖：HTML 用正则做「块级切分 + 标签剥离」，
 * RSS/Atom 用一个能跑现实 feed 的最小 XML 扫描器。
 * 正则解析 HTML 有固有局限（不处理畸形嵌套、不做 CSS 选择器的完整语义），
 * 这里只承诺三件事：
 *   1) 能把导航/页脚这类噪声压掉大部分；
 *   2) 能把正文切成语义块；
 *   3) 选择器写错时明确报错，而不是静默返回空。
 */

const BLOCK_TAGS = 'p|div|section|article|li|h1|h2|h3|h4|h5|h6|td|blockquote|pre|figcaption'
const NOISE_TAGS = 'nav|header|footer|aside|script|style|noscript|svg|form|button|select|iframe|template'

/** 去掉 HTML 注释与不可见内容。 */
function stripNoise(html) {
  let out = html
  out = out.replace(/<!--[\s\S]*?-->/gu, ' ')
  out = out.replace(new RegExp(`<(${NOISE_TAGS})\\b[\\s\\S]*?</\\1>`, 'giu'), ' ')
  out = out.replace(new RegExp(`<(${NOISE_TAGS})\\b[^>]*/?>`, 'giu'), ' ')
  return out
}

/** 实体解码：只处理常见的，够用且不会引入依赖。 */
export function decodeEntities(text) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    ldquo: '“',
    rdquo: '”',
    lsquo: '‘',
    rsquo: '’',
    middot: '·',
    laquo: '«',
    raquo: '»',
  }
  return String(text)
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, (whole, body) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        const code = Number.parseInt(body.slice(2), 16)
        return Number.isFinite(code) ? safeChar(code) : whole
      }
      if (body.startsWith('#')) {
        const code = Number.parseInt(body.slice(1), 10)
        return Number.isFinite(code) ? safeChar(code) : whole
      }
      const mapped = named[body.toLowerCase()]
      return mapped === undefined ? whole : mapped
    })
}

function safeChar(code) {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** 去标签取纯文本，保留空白以外的换行语义。 */
export function textOf(html) {
  const withoutTags = String(html).replace(/<[^>]*>/gu, ' ')
  return decodeEntities(withoutTags).replace(/[ \t\u00a0]+/gu, ' ').replace(/\s*\n\s*/gu, '\n').trim()
}

/** 从标签里取属性值。 */
function attrOf(tagText, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu')
  const match = pattern.exec(tagText)
  if (match === null) return ''
  return match[2] ?? match[3] ?? match[4] ?? ''
}

/**
 * 极简 CSS 选择器：支持 #id、.class、tag，以及它们的组合（交集）。
 * 不支持后代选择器与伪类——那种需求超出「圈定内容区域」的范围，
 * 遇到不支持的选择器会明确抛错，让用户改，而不是悄悄返回空。
 */
export function parseSelector(selector) {
  const raw = String(selector ?? '').trim()
  if (raw === '') return null
  if (/[\s>+~:[\]]/u.test(raw)) {
    throw new Error(`选择器 "${raw}" 使用了暂不支持的后代/伪类/属性语法，请用 #id、.class 或标签名`)
  }
  const parts = { tag: '', id: '', classes: [] }
  const tokenRe = /([.#]?)([A-Za-z0-9_-]+)/gu
  let consumed = 0
  let match
  while ((match = tokenRe.exec(raw)) !== null) {
    consumed += match[0].length
    const [, prefix, value] = match
    if (prefix === '#') parts.id = value
    else if (prefix === '.') parts.classes.push(value)
    else parts.tag = value.toLowerCase()
  }
  if (consumed !== raw.length) throw new Error(`无法解析的选择器 "${raw}"`)
  return parts
}

/** 一个标签是否匹配解析后的选择器。 */
function tagMatches(tagText, tagName, parts) {
  if (parts.tag !== '' && tagName.toLowerCase() !== parts.tag) return false
  if (parts.id !== '' && attrOf(tagText, 'id') !== parts.id) return false
  if (parts.classes.length > 0) {
    const classes = attrOf(tagText, 'class').split(/\s+/u).filter(Boolean)
    if (!parts.classes.every((name) => classes.includes(name))) return false
  }
  return true
}

/**
 * 取出选择器匹配的那段内容（取第一个匹配元素，含其内部）。
 * 找不到时返回 null，由调用方区分「没匹配到」与「匹配到但是空的」。
 */
export function extractBySelector(html, parts) {
  if (parts === null) return null
  const openRe = new RegExp(`<([A-Za-z][A-Za-z0-9-]*)\\b[^>]*>`, 'gu')
  let match
  while ((match = openRe.exec(html)) !== null) {
    const tagName = match[1]
    const tagText = match[0]
    if (!tagMatches(tagText, tagName, parts)) continue
    const start = match.index + tagText.length
    const end = findClosingTag(html, tagName, start)
    if (end < 0) continue
    return html.slice(start, end)
  }
  return null
}

/**
 * 从 start 起找对应的闭合标签，正确处理同名嵌套。
 *
 * 旧实现把「找闭合」和「数嵌套」混在一个循环里，lastIndex 互相干扰，
 * 同名嵌套时会提前错位。这里改成一次扫描所有开/闭标签，按出现顺序累减深度。
 */
function findClosingTag(html, tagName, start) {
  const tagRe = new RegExp(`<(/?)${tagName}\\b[^>]*?(/?)>`, 'giu')
  tagRe.lastIndex = start
  let depth = 1
  let match
  while ((match = tagRe.exec(html)) !== null) {
    const isClosing = match[1] === '/'
    const isSelfClosing = match[2] === '/'
    if (isSelfClosing) continue
    if (isClosing) {
      depth -= 1
      if (depth === 0) return match.index
    } else {
      depth += 1
    }
    if (tagRe.lastIndex <= match.index) break
  }
  return -1
}

/**
 * 把一段 HTML 切成正文块。
 *
 * 关键点：块级标签会嵌套（div > p），按文档顺序直接匹配会先吃到外层 div，
 * 把里面所有段落粘成一段。所以遇到「块里还有块」时必须递归进去，只把叶子块当条目。
 * 另外丢掉过短的块（导航残留）与重复块。
 */
export function blocksOfHtml(html, { minChars = 12, maxBlocks = 200 } = {}) {
  const cleaned = stripNoise(html)
  const blockSource = `<(${BLOCK_TAGS})\\b[^>]*>([\\s\\S]*?)</\\1\\s*>`
  const nestedSource = `<(${BLOCK_TAGS})\\b`
  const blocks = []
  const seen = new Set()

  const push = (text) => {
    const value = text.trim()
    if (value.length < minChars) return
    const key = value.slice(0, 80)
    if (seen.has(key)) return
    seen.add(key)
    if (blocks.length < maxBlocks) blocks.push(value)
  }

  // 逐层展开：先收集直接子块，遇到内含块的继续往里走。
  // 每次 walk 用独立的正则实例——共用全局正则会互相打乱 lastIndex，导致死循环。
  const walk = (fragment, depth) => {
    if (depth > 6 || blocks.length >= maxBlocks) return
    const blockRe = new RegExp(blockSource, 'giu')
    const nestedRe = new RegExp(nestedSource, 'iu')
    let rest = ''
    let cursor = 0
    let found = false
    let match
    while ((match = blockRe.exec(fragment)) !== null && blocks.length < maxBlocks) {
      found = true
      // 两个块之间的裸文本也算内容（有些页面正文直接放在 div 里）
      rest += `${fragment.slice(cursor, match.index)}\n`
      cursor = match.index + match[0].length
      const inner = match[2]
      if (nestedRe.test(inner)) {
        walk(inner, depth + 1)
      } else {
        push(textOf(inner))
      }
      // 零长度匹配保护：正则一旦不再前进就跳出，避免无限循环
      if (blockRe.lastIndex <= match.index) break
    }
    if (found) {
      rest += `${fragment.slice(cursor)}\n`
      const tail = textOf(rest)
      if (tail !== '') push(tail)
    }
  }

  walk(cleaned, 0)

  // 整页没有块级结构时，退回「整段文本按行切」。
  if (blocks.length === 0) {
    const whole = textOf(cleaned)
    for (const line of whole.split(/\n+/u)) {
      push(line)
      if (blocks.length >= maxBlocks) break
    }
  }
  return blocks
}

/** 极简 XML 扫描：取一个标签的内部文本（不含自身）。 */
function xmlInner(xml, tagName) {
  const openRe = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}\\s*>`, 'iu')
  const match = openRe.exec(xml)
  return match === null ? '' : match[1]
}

/** 取多个同名标签的内部文本（同时支持自闭合与成对）。 */
function xmlAll(xml, tagName, limit = 200) {
  const re = new RegExp(`<${tagName}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${tagName}\\s*>)`, 'giu')
  const out = []
  let match
  while ((match = re.exec(xml)) !== null && out.length < limit) {
    // 自闭合时第二组是 undefined，用一个特殊标记保留它的属性
    out.push({ attrs: match[1] ?? '', inner: match[2], selfClosing: match[2] === undefined })
  }
  return out
}

/** 兼容旧调用：只取内部文本字符串。 */
function xmlAllInner(xml, tagName, limit = 200) {
  return xmlAll(xml, tagName, limit).map((item) => (item.selfClosing ? '' : item.inner))
}

/**
 * 从一段 HTML 里抽出「条目」：每条带自己的子页面链接。
 *
 * 列表型页面的真实结构是「一串 <a> 指向详情页」，所以这里以 <a> 为单位，
 * 而不是以块级文本为单位——否则每条内容的 url 都会退化成母页面地址。
 *
 * 标题与日期的两种常见排布：
 *   <a><h4>标题</h4><span class="time">2026-10-26 15:51</span></a>   ← 分开写在子元素里
 *   <a>标题 2026-10-26</a>                                          ← 粘在一行里
 * 先试前者（更可靠），拿不到再用文本尾部拆分。
 */
export function linksOfHtml(html, baseUrl, { minChars = 8, maxItems = 200 } = {}) {
  // 先把导航与页脚整块删掉，避免把它们里面的链接也当成内容
  const cleaned = stripNoise(html)
  const out = []
  const seen = new Set()
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/giu
  let match
  while ((match = re.exec(cleaned)) !== null && out.length < maxItems) {
    const tagText = `<a${match[1]}>`
    const rawHref = attrOf(tagText, 'href').trim()
    if (rawHref === '' || rawHref.startsWith('#') || /^javascript:/iu.test(rawHref)) continue

    let absolute
    try {
      absolute = new URL(rawHref, baseUrl).toString()
    } catch {
      continue
    }
    if (!/^https?:/iu.test(absolute)) continue
    if (absolute === baseUrl) continue
    if (seen.has(absolute)) continue
    if (isNavigationUrl(absolute)) continue

    const inner = match[2]
    // 先试「标题在标题元素里、日期在 time 类元素里」的结构
    const structured = structuredTitleDateOf(inner)
    const text = textOf(inner).replace(/\s+/gu, ' ').trim()
    if (text.length < minChars) continue

    seen.add(absolute)
    const parsed = structured !== null ? structured : splitTitleDate(text)
    out.push({
      title: parsed.title,
      publishedAt: parsed.date,
      url: absolute,
      text,
    })
  }
  return out
}

/**
 * 从 `<a>` 内部按结构取标题与时间。
 *
 * 覆盖两种真实结构：
 *   <a><h4>标题</h4><span class="time">2026-10-26 15:51</span></a>   ← 日期有 time 类
 *   <a><span>标题</span><i>2026-10-27</i></a>                      ← 日期是最后一个元素且无 class
 * 命中返回 { title, date }；不命中返回 null，交给文本尾部拆分兜底。
 */
export function structuredTitleDateOf(inner) {
  // 结构一：标题元素 + 带 time/date 类的时间元素
  const titleMatch = /<(h[1-6]|span|div|p|em|strong)\b[^>]*>([\s\S]*?)<\/\1\s*>/iu.exec(inner)
  const timeMatch = /<(\w+)\b[^>]*(?:class|id)\s*=\s*["'][^"']*\b(?:time|date|riqi|pubdate)\b[^"']*["'][^>]*>([\s\S]*?)<\/\1\s*>/iu.exec(inner)
  if (titleMatch !== null && timeMatch !== null) {
    const title = textOf(titleMatch[2]).replace(/\s+/gu, ' ').trim()
    const rawDate = textOf(timeMatch[2]).replace(/\s+/gu, ' ').trim()
    if (title !== '' && rawDate !== '') {
      const date = splitTitleDate(`xxx${rawDate}`).date
      if (date !== '') return { title, date }
    }
  }

  // 结构二：最后一个内联元素的文本正好是日期（如 <span>标题</span><i>2026-10-27</i>）
  const tail = /<(\w+)\b[^>]*>([^<]{6,40})<\/\1\s*>\s*$/iu.exec(inner)
  if (tail !== null) {
    const rawDate = textOf(tail[2]).trim()
    const date = splitTitleDate(`xxx${rawDate}`).date
    if (date !== '') {
      const before = inner.slice(0, tail.index)
      const title = textOf(before).replace(/\s+/gu, ' ').trim()
      if (title.length >= 3) return { title, date }
    }
  }
  return null
}

/** 明显不是「内容页」的地址：登录、搜索、站点首页、功能入口。 */
const NAV_URL_HINTS = [
  /\/(login|signin|signup|register|logout)\b/iu,
  /\/(search|so)\b/iu,
  /\/(sitemap|rss|feed)\b/iu,
  /[?&](page|p|pageno)=\d+/iu,
  /\/(index|default)\.(html?|jsp|php|aspx?)$/iu,
  /javascript:/iu,
]

/**
 * 是否是导航类链接。
 *
 * 除了 URL 特征，还排除「和母页同域的首页」：列表页常把站名做成首页链接，
 * 那种链接的路径通常只有一层。
 */
function isNavigationUrl(absolute) {
  let url
  try {
    url = new URL(absolute)
  } catch {
    return true
  }
  if (NAV_URL_HINTS.some((re) => re.test(url.pathname) || re.test(url.href))) return true
  // 只有一层路径且没有查询参数（如 /about.htm）→ 栏目入口。
  // 注意：content.jsp?urltype=news...&wbnewsid=123 这类虽然路径只有一层，
  // 但查询参数里带着具体条目 id，是真正的内容页，不能过滤掉。
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length <= 1 && url.search === '') return true
  return false
}

/**
 * 把「标题2026-10-26 15:51」这类粘连文本拆成标题与日期。
 *
 * 站点上常见三种尾部格式：
 *   2026-10-26               纯日期
 *   2026-10-26 15:51         日期 + 时间（团委页面就是这种）
 *   2026年9月28日             中文写法
 * 都允许外面套一层 [ ] ( ) （ ）。
 */
export function splitTitleDate(text) {
  const source = String(text).trim()

  // 日期 + 可选时间。时间部分是两位数:两位数，可有可无。
  const numeric = /[\[(（]?(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[\sT]+(\d{1,2}):(\d{2})(?::\d{2})?)?[\])）]?\s*$/u
  const chinese = /[\[(（]?(\d{4})年(\d{1,2})月(\d{1,2})日(?:[\s]+(\d{1,2}):(\d{2}))?[\])）]?\s*$/u
  const chineseNoDay = /[\[(（]?(\d{4})年(\d{1,2})月[\])）]?\s*$/u

  for (const re of [numeric, chinese, chineseNoDay]) {
    const found = re.exec(source)
    if (found === null) continue
    const title = source.slice(0, found.index).trim()
    // 标题至少留 3 个字，否则日期其实是标题的一部分（例如「2026-10-26 通知」），不拆
    if (title.length < 3) return { title: source, date: '' }
    const [, year, month, day, hour, minute] = found
    const iso = `${year}-${String(Number(month)).padStart(2, '0')}-${String(Number(day ?? 1)).padStart(2, '0')}`
    // 有具体时间就一起带上，排序时同一天的条目也能分清先后
    const time = hour === undefined ? '' : ` ${String(Number(hour)).padStart(2, '0')}:${minute}`
    return { title, date: `${iso}${time}` }
  }
  return { title: source, date: '' }
}

/** 把一组「带链接的条目」按日期从新到旧排；没有日期时保持原顺序。 */
export function sortByDateDesc(entries) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const a = left.entry.publishedAt ?? ''
      const b = right.entry.publishedAt ?? ''
      if (a !== '' && b !== '') {
        if (a !== b) return a < b ? 1 : -1
        return left.index - right.index
      }
      // 有日期的排在没有日期的前面；都有/都没有时维持原序
      if (a !== '' && b === '') return -1
      if (a === '' && b !== '') return 1
      return left.index - right.index
    })
    .map((item) => item.entry)
}

/** CDATA 与纯文本都要能取值。 */
function xmlText(raw) {
  const trimmed = String(raw ?? '').trim()
  if (trimmed === '') return ''
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/u.exec(trimmed)
  if (cdata !== null) return cdata[1].replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim()
  // 普通文本里可能夹着 HTML 标签（description 常见），去标签再解码。
  return decodeEntities(trimmed.replace(/<[^>]*>/gu, ' ')).replace(/\s+/gu, ' ').trim()
}

/** 从 Atom 的 link 元素里挑 rel=alternate 或第一个 href。 */
function atomLink(entryXml) {
  const links = xmlAll(entryXml, 'link', 20)
  for (const link of links) {
    const href = attrOf(`<link${link.attrs}>`, 'href')
    if (href === '') continue
    const rel = attrOf(`<link${link.attrs}>`, 'rel')
    if (rel === '' || rel === 'alternate') return href
  }
  return ''
}

/** RSS 的 link 可能是裸文本，也可能是 Atom 风格的自闭合标签。 */
function rssLink(itemXml) {
  const links = xmlAll(itemXml, 'link', 10)
  for (const link of links) {
    if (link.selfClosing) {
      const href = attrOf(`<link${link.attrs}>`, 'href')
      if (href !== '') return href
      continue
    }
    const text = xmlText(link.inner)
    if (text !== '') return text
    const href = attrOf(`<link${link.attrs}>`, 'href')
    if (href !== '') return href
  }
  return ''
}

/**
 * 解析 RSS 2.0 / Atom。
 * @returns {{kind:string, title:string, entries:Array<{title:string, summary:string, url:string, publishedAt:string}>}}
 */
export function parseFeed(xml) {
  const source = String(xml)
  const isAtom = /<feed[\s>]/iu.test(source)
  const channelTitle = xmlText(isAtom ? xmlInner(source, 'title') : xmlInner(xmlInner(source, 'channel'), 'title'))
  const container = isAtom ? source : xmlInner(source, 'channel')
  const itemTexts = isAtom ? xmlAllInner(container, 'entry') : xmlAllInner(container, 'item')
  const entries = []
  for (const item of itemTexts) {
    const title = xmlText(xmlInner(item, 'title'))
    const summary =
      xmlText(xmlInner(item, 'description')) ||
      xmlText(xmlInner(item, 'summary')) ||
      xmlText(xmlInner(item, 'content')) ||
      xmlText(xmlInner(item, 'content:encoded'))
    const url = isAtom ? atomLink(item) : rssLink(item)
    const publishedAt =
      xmlText(xmlInner(item, 'pubDate')) ||
      xmlText(xmlInner(item, 'published')) ||
      xmlText(xmlInner(item, 'updated')) ||
      xmlText(xmlInner(item, 'dc:date'))
    entries.push({ title, summary, url, publishedAt })
  }
  return { kind: isAtom ? 'atom' : 'rss', title: channelTitle, entries }
}

/** 根据 Content-Type 与报文特征判断格式。 */
export function detectFormat(contentType, body) {
  const type = String(contentType ?? '').toLowerCase()
  const head = String(body ?? '').slice(0, 2000)
  if (type.includes('xml') || type.includes('rss') || type.includes('atom')) return 'feed'
  if (/^\s*<\?xml/iu.test(head)) return 'feed'
  if (/<rss[\s>]|<feed[\s>]/iu.test(head)) return 'feed'
  return 'html'
}
