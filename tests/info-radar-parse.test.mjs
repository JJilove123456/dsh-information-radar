import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSelector,
  extractBySelector,
  blocksOfHtml,
  parseFeed,
  detectFormat,
  decodeEntities,
  textOf,
} from '../lib/parse.js'

test('选择器：id / class / tag / 交集', () => {
  assert.deepEqual(parseSelector('#main'), { tag: '', id: 'main', classes: [] })
  assert.deepEqual(parseSelector('.list'), { tag: '', id: '', classes: ['list'] })
  assert.deepEqual(parseSelector('article'), { tag: 'article', id: '', classes: [] })
  assert.deepEqual(parseSelector('div.item'), { tag: 'div', id: '', classes: ['item'] })
  assert.deepEqual(parseSelector('div.a.b'), { tag: 'div', id: '', classes: ['a', 'b'] })
  assert.equal(parseSelector(''), null)
})

test('选择器：不支持的语法明确报错', () => {
  assert.throws(() => parseSelector('div > p'), /暂不支持/u)
  assert.throws(() => parseSelector('.a .b'), /暂不支持/u)
  assert.throws(() => parseSelector('li:first-child'), /暂不支持/u)
  assert.throws(() => parseSelector('a[href]'), /暂不支持/u)
})

test('按选择器抽取：找到第一个匹配元素', () => {
  const html = '<body><div class="nav">导航</div><div class="list"><p>一</p><p>二</p></div></body>'
  const inner = extractBySelector(html, parseSelector('.list'))
  assert.ok(inner.includes('<p>一</p>'))
  assert.ok(!inner.includes('导航'))
})

test('按选择器抽取：同名嵌套只取外层', () => {
  const html = '<div class="x"><div class="x">内层</div>尾巴</div>后记'
  const inner = extractBySelector(html, parseSelector('.x'))
  assert.ok(inner.includes('内层'))
  assert.ok(inner.includes('尾巴'))
  assert.ok(!inner.includes('后记'))
})

test('按选择器抽取：没匹配到返回 null', () => {
  assert.equal(extractBySelector('<div class="a">x</div>', parseSelector('.nope')), null)
})

test('正文块：去掉 nav/script/footer', () => {
  const html = `
    <nav><a>首页</a><a>关于</a></nav>
    <article>
      <h1>标题在这</h1>
      <p>这是第一段正文，长度足够。</p>
      <p>这是第二段正文，长度也足够。</p>
    </article>
    <script>var x = 1</script>
    <footer>版权所有</footer>`
  const blocks = blocksOfHtml(html)
  const joined = blocks.join('\n')
  assert.ok(joined.includes('这是第一段正文'))
  assert.ok(joined.includes('这是第二段正文'))
  assert.ok(!joined.includes('版权所有'))
  assert.ok(!joined.includes('var x'))
  assert.ok(!joined.includes('首页'))
})

test('正文块：过短段落被丢掉', () => {
  const html = '<div><p>短</p><p>这是一个足够长的段落文本内容</p></div>'
  const blocks = blocksOfHtml(html, { minChars: 12 })
  assert.deepEqual(blocks, ['这是一个足够长的段落文本内容'])
})

test('正文块：重复段落只留一份', () => {
  const html = '<div><p>完全重复的一段文字内容</p><p>完全重复的一段文字内容</p></div>'
  const blocks = blocksOfHtml(html, { minChars: 5 })
  assert.equal(blocks.length, 1)
})

test('正文块：没有块级标签时按行切', () => {
  const html = '第一行很长很长的内容文字\n第二行很长很长的内容文字'
  const blocks = blocksOfHtml(html, { minChars: 5 })
  assert.equal(blocks.length, 2)
})

test('实体解码', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42;'), 'a & b <c> A B')
  assert.equal(decodeEntities('&nbsp;'), ' ')
})

test('纯文本提取', () => {
  assert.equal(textOf('<p>hello <b>world</b></p>'), 'hello world')
})

test('RSS 解析', () => {
  const xml = `<?xml version="1.0"?>
  <rss version="2.0"><channel>
    <title>示例频道</title>
    <item>
      <title>第一条</title>
      <link>https://example.com/1</link>
      <description><![CDATA[<p>摘要一</p>]]></description>
      <pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>第二条</title>
      <link>https://example.com/2</link>
      <description>摘要二</description>
      <pubDate>Tue, 27 Oct 2026 10:00:00 GMT</pubDate>
    </item>
  </channel></rss>`
  const feed = parseFeed(xml)
  assert.equal(feed.kind, 'rss')
  assert.equal(feed.title, '示例频道')
  assert.equal(feed.entries.length, 2)
  assert.equal(feed.entries[0].title, '第一条')
  assert.equal(feed.entries[0].url, 'https://example.com/1')
  assert.equal(feed.entries[0].summary, '摘要一')
  assert.ok(feed.entries[0].publishedAt.includes('2026'))
})

test('Atom 解析', () => {
  const xml = `<?xml version="1.0"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <title>Atom 频道</title>
    <entry>
      <title>条目一</title>
      <link rel="alternate" href="https://example.com/a1"/>
      <summary>摘要甲</summary>
      <published>2026-10-26T10:00:00Z</published>
    </entry>
  </feed>`
  const feed = parseFeed(xml)
  assert.equal(feed.kind, 'atom')
  assert.equal(feed.title, 'Atom 频道')
  assert.equal(feed.entries.length, 1)
  assert.equal(feed.entries[0].url, 'https://example.com/a1')
  assert.equal(feed.entries[0].summary, '摘要甲')
})

test('格式识别', () => {
  assert.equal(detectFormat('application/rss+xml', ''), 'feed')
  assert.equal(detectFormat('text/html', '<html></html>'), 'html')
  assert.equal(detectFormat('', '<?xml version="1.0"?><rss>'), 'feed')
  assert.equal(detectFormat('', '<feed xmlns="x">'), 'feed')
  assert.equal(detectFormat('text/plain', 'hello'), 'html')
})


