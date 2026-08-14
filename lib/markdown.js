// Minimal markdown -> styled terminal lines. Each line is an array of
// { text, style } segments. Not a full spec implementation: covers the block
// shapes and inline spans most model output uses, and degrades gracefully.
import { makeStyle, mergeStyle } from './term.js'
import { runeWidth } from './util.js'

// Parse inline markdown into styled segments. `base` is merged into each.
// Handles **bold**, *italic*, `code`, [text](url), and ~~strike~~.
export function inlineSegments(text, theme, base = null) {
  const segments = []
  const buf = []
  const flush = (style) => {
    if (buf.length === 0) return
    segments.push({ text: buf.join(''), style: base ? mergeStyle(base, style) : style })
    buf.length = 0
  }
  const plain = () => flush(makeStyle(theme.text))
  let i = 0
  const n = text.length
  while (i < n) {
    const rest = text.slice(i)
    // code span
    if (rest.startsWith('`')) {
      plain()
      let j = i + 1
      let code = ''
      let closed = false
      while (j < n) {
        if (text[j] === '`') { closed = true; break }
        code += text[j]
        j++
      }
      if (closed) {
        flush(makeStyle({ fg: theme.markdownCode }))
        segments.push({ text: code, style: makeStyle({ fg: theme.markdownCode, bg: theme.codeBg }) })
        i = j + 1
        continue
      }
      buf.push('`')
      i += 1
      continue
    }
    // bold
    if (rest.startsWith('**')) {
      plain()
      const end = text.indexOf('**', i + 2)
      if (end !== -1) {
        flush(makeStyle({ fg: theme.text, bold: true }))
        const inner = inlineSegments(text.slice(i + 2, end), theme, makeStyle({ bold: true }))
        for (const seg of inner) segments.push(seg)
        i = end + 2
        continue
      }
    }
    // italic
    if (rest.startsWith('*')) {
      plain()
      const end = text.indexOf('*', i + 1)
      if (end !== -1) {
        flush(makeStyle({ fg: theme.text, italic: true }))
        const inner = inlineSegments(text.slice(i + 1, end), theme, makeStyle({ italic: true }))
        for (const seg of inner) segments.push(seg)
        i = end + 1
        continue
      }
    }
    // link [text](url)
    if (rest.startsWith('[')) {
      const close = text.indexOf(']', i)
      if (close !== -1 && text[close + 1] === '(') {
        const urlEnd = text.indexOf(')', close + 2)
        if (urlEnd !== -1) {
          plain()
          const label = text.slice(i + 1, close)
          segments.push({ text: label, style: makeStyle({ fg: theme.markdownLinkText, underline: true }) })
          i = urlEnd + 1
          continue
        }
      }
    }
    // strike
    if (rest.startsWith('~~')) {
      const end = text.indexOf('~~', i + 2)
      if (end !== -1) {
        plain()
        flush(makeStyle({ fg: theme.text, dim: true }))
        const inner = inlineSegments(text.slice(i + 2, end), theme, makeStyle({ dim: true }))
        for (const seg of inner) segments.push(seg)
        i = end + 2
        continue
      }
    }
    // A backslash is literal text (Windows paths keep their separators).
    buf.push(text[i])
    i += 1
  }
  flush(makeStyle(theme.text))
  return segments
}

// Wrap inline segments to `width` cells, returning lines of segments.
export function wrapSegments(segments, width) {
  if (width <= 0) return [[]]
  const lines = []
  let current = []
  let currentW = 0
  let word = []
  let wordW = 0
  const pushWord = () => {
    if (wordW === 0) return
    if (currentW + wordW > width && current.length > 0) {
      lines.push(current)
      current = []
      currentW = 0
    }
    if (wordW > width) {
      let rest = word
      let restW = wordW
      while (restW > width) {
        let acc = 0
        let used = 0
        outer: for (const seg of rest) {
          for (const ch of seg.text) {
            const w = runeWidth(ch)
            if (acc + w > width) break outer
            acc += w
            used += ch.length
          }
        }
        const chunk = extractPrefixSegments(rest, used)
        lines.push([...current, ...chunk])
        current = []
        currentW = 0
        rest = consumePrefixSegments(rest, used)
        restW = rest.reduce((s, seg) => s + segWidth(seg.text), 0)
      }
      for (const seg of rest) current.push(seg)
      currentW = restW
    } else {
      for (const seg of word) current.push(seg)
      currentW += wordW
    }
    word = []
    wordW = 0
  }
  for (const seg of segments) {
    const parts = seg.text.split(/(\s+)/)
    for (const part of parts) {
      if (part === '') continue
      if (/^\s+$/.test(part)) {
        pushWord()
        if (currentW + runeWidth(part) <= width || current.length === 0) {
          current.push({ text: part, style: seg.style })
          currentW += runeWidth(part)
        } else if (current.length > 0) {
          lines.push(current)
          current = []
          currentW = 0
        }
      } else {
        if (word.length > 0 && word[word.length - 1].style !== seg.style) pushWord()
        word.push({ text: part, style: seg.style })
        wordW += segWidth(part)
      }
    }
  }
  pushWord()
  if (current.length > 0 || lines.length === 0) lines.push(current)
  return lines
}

function segWidth(text) {
  let w = 0
  for (const ch of text) w += runeWidth(ch)
  return w
}

function extractPrefixSegments(segs, used) {
  const out = []
  let acc = 0
  for (const seg of segs) {
    if (acc >= used) break
    const take = Math.min(used - acc, seg.text.length)
    out.push({ text: seg.text.slice(0, take), style: seg.style })
    acc += take
  }
  return out
}
function consumePrefixSegments(segs, used) {
  const out = []
  let acc = 0
  for (const seg of segs) {
    if (acc >= used) {
      out.push(seg)
      continue
    }
    const take = Math.min(used - acc, seg.text.length)
    acc += take
    if (take < seg.text.length) out.push({ text: seg.text.slice(take), style: seg.style })
  }
  return out
}

const CODE_BG = '1e1e1e'

// Render markdown text to styled lines for the given width.
// Returns an array of lines; each line is an array of { text, style }.
export function renderMarkdown(text, theme, width) {
  const lines = []
  const raw = String(text).replace(/\r\n/g, '\n')
  const blockLines = raw.split('\n')
  let i = 0
  let inCode = false
  while (i < blockLines.length) {
    const line = blockLines[i]
    if (inCode) {
      if (/^```/.test(line.trim())) {
        inCode = false
        lines.push([])
        i++
        continue
      }
      const segs = [{ text: line, style: makeStyle({ fg: theme.markdownCodeBlock, bg: CODE_BG }) }]
      pushWrapped(lines, segs, width)
      i++
      continue
    }
    const trimmed = line.trim()
    const fence = /^```(\S*)/.exec(trimmed)
    if (fence) {
      inCode = true
      lines.push([])
      i++
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(trimmed)
    if (h) {
      lines.push([{ text: h[2], style: makeStyle({ fg: theme.markdownHeading, bold: true }) }])
      i++
      continue
    }
    if (/^(---|\*\*\*|___)\s*$/.test(trimmed)) {
      lines.push([{ text: '─'.repeat(Math.max(4, width)), style: makeStyle({ fg: theme.markdownHorizontalRule, dim: true }) }])
      i++
      continue
    }
    const q = /^>\s?(.*)$/.exec(line)
    if (q) {
      const segs = [{ text: '▍ ', style: makeStyle({ fg: theme.markdownBlockQuote }) }]
      segs.push(...inlineSegments(q[1], theme, makeStyle({ fg: theme.markdownBlockQuote })))
      pushWrapped(lines, segs, width)
      i++
      continue
    }
    const li = /^([-*+]|\d+\.)\s+(.*)$/.exec(trimmed)
    if (li) {
      const marker = /^\d/.test(li[1]) ? ' ' + li[1] + ' ' : '• '
      const prefix = [{ text: marker, style: makeStyle({ fg: theme.markdownListItem, bold: true }) }]
      prefix.push(...inlineSegments(li[2], theme))
      pushWrapped(lines, prefix, width)
      i++
      continue
    }
    if (trimmed === '') {
      lines.push([])
      i++
      continue
    }
    let para = line
    while (i + 1 < blockLines.length && !startsNewBlock(blockLines[i + 1])) {
      i++
      para += ' ' + blockLines[i]
    }
    pushWrapped(lines, inlineSegments(para, theme), width)
    i++
  }
  return lines
}

// Whether a raw line begins a block that must not merge into the paragraph
// above it: blank, list item, blockquote, fence, heading, or horizontal rule.
function startsNewBlock(raw) {
  const trimmed = raw.trim()
  if (trimmed === '') return true
  if (/^```/.test(trimmed)) return true
  if (/^#{1,4}\s/.test(trimmed)) return true
  if (/^([-*+]|\d+\.)\s/.test(trimmed)) return true
  if (/^>\s?/.test(trimmed)) return true
  if (/^(---|\*\*\*|___)\s*$/.test(trimmed)) return true
  return false
}

function pushWrapped(out, segments, width) {
  for (const line of wrapSegments(segments, width)) {
    out.push(line.length === 0 ? [] : line)
  }
}