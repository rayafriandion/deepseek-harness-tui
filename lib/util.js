// Text and display helpers for the TUI. No dsh dependencies.

// Width of a rune in terminal cells: CJK/full-width runes are double width,
// combining marks are zero width, everything else is one.
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{2FFFD}]/u
const ZERO = /[\u0300-\u036F\u200B-\u200F\uFE00-\uFE0F]/u

export function runeWidth(ch) {
  if (ZERO.test(ch)) return 0
  if (WIDE.test(ch)) return 2
  return 1
}

export function displayWidth(str) {
  let w = 0
  for (const ch of str) w += runeWidth(ch)
  return w
}

// ANSI escape sequence: CSI ... final byte in 0x40-0x7E.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g
export function stripAnsi(str) {
  return str.replace(ANSI_RE, '')
}

// Truncate by display width, appending '…' when something was cut.
export function truncateWidth(str, width) {
  if (width <= 0) return ''
  let out = ''
  let w = 0
  for (const ch of str) {
    const cw = runeWidth(ch)
    if (w + cw > width) {
      if (out.length > 0 && w < width) out += '…'
      break
    }
    out += ch
    w += cw
  }
  return out
}

// Pad/truncate a string to exactly width cells.
export function fitWidth(str, width, fill = ' ') {
  const s = truncateWidth(str, width)
  const w = displayWidth(s)
  return s + fill.repeat(Math.max(0, width - w))
}

// Wrap text to lines of at most width cells. Splits on whitespace, hard-wraps
// overlong words. Existing newlines are preserved.
export function wrapText(str, width) {
  if (width <= 0) return []
  const lines = []
  for (const raw of str.split(/\r?\n/)) {
    if (raw === '') {
      lines.push('')
      continue
    }
    let line = ''
    let lineW = 0
    for (const token of raw.split(/(\s+)/)) {
      if (token === '') continue
      if (/^\s+$/.test(token)) {
        // Whitespace: keep if it fits on the current line.
        const tw = displayWidth(token)
        if (lineW + tw <= width) {
          line += token
          lineW += tw
        } else if (line !== '') {
          lines.push(line)
          line = ''
          lineW = 0
        }
        continue
      }
      const tw = displayWidth(token)
      if (lineW + tw <= width) {
        line += token
        lineW += tw
      } else {
        if (line !== '') {
          lines.push(line)
          line = ''
          lineW = 0
        }
        if (tw > width) {
          // Hard-wrap an overlong token.
          let rest = token
          while (displayWidth(rest) > width) {
            let cut = 0
            let cw = 0
            for (const ch of rest) {
              const w = runeWidth(ch)
              if (cw + w > width) break
              cw += w
              cut += ch.length
            }
            lines.push(rest.slice(0, cut))
            rest = rest.slice(cut)
          }
          line = rest
          lineW = displayWidth(rest)
        } else {
          line = token
          lineW = tw
        }
      }
    }
    lines.push(line)
  }
  return lines
}

// Compact local time, e.g. 14:03:22.
export function timeString(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

// Rough token estimate: CJK-heavy text ~1 token per rune, latin ~1 per 4 chars.
export function roughTokens(text) {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u2E80-\u9FFF\uF900-\uFAFF\uAC00-\uD7A3]/.test(ch)) cjk += 1
    else other += 1
  }
  return Math.max(1, cjk + Math.round(other / 4))
}

// Compact preview of a raw JSON tool-arguments string.
export function jsonPreview(raw) {
  if (raw === undefined || raw === null) return ''
  let text = String(raw)
  try {
    const parsed = JSON.parse(text)
    text = JSON.stringify(parsed)
  } catch {
    // Keep the raw string; it is already a preview.
  }
  if (text.length > 160) text = text.slice(0, 159) + '…'
  return text
}

// Extract plain text from an array of content blocks (llm ContentBlock[]).
export function contentText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((block) => {
      switch (block?.type) {
        case 'text': return block.text ?? ''
        case 'reasoning': return block.text ?? ''
        case 'tool-call': return ''
        default: return ''
      }
    })
    .join('')
}

export function formatError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
