// Terminal engine: raw-mode input, alternate screen, a diffing cell buffer,
// and ANSI truecolor rendering. Zero dependencies; works on any VT-capable
// terminal (Windows Terminal, ConPTY, iTerm2, GNOME Terminal, ...).
import { EventEmitter } from 'node:events'
import { runeWidth, truncateWidth, fitWidth } from './util.js'

// ---- ANSI helpers -------------------------------------------------------

export function hexToAnsi(hex) {
  const h = hex.replace(/^#/, '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  if ([r, g, b].some((n) => Number.isNaN(n))) return undefined
  return { r, g, b }
}

// Immutable-ish style bundle: { fg, bg (hex or null), bold, dim, italic,
// underline }. Merges by producing a new object.
export function makeStyle(partial = {}) {
  return {
    fg: partial.fg ?? null,
    bg: partial.bg ?? null,
    bold: partial.bold ?? false,
    dim: partial.dim ?? false,
    italic: partial.italic ?? false,
    underline: partial.underline ?? false,
  }
}

export function mergeStyle(base, over) {
  return {
    fg: over.fg ?? base.fg ?? null,
    bg: over.bg ?? base.bg ?? null,
    bold: over.bold ?? base.bold ?? false,
    dim: over.dim ?? base.dim ?? false,
    italic: over.italic ?? base.italic ?? false,
    underline: over.underline ?? base.underline ?? false,
  }
}

function styleAnsi(style) {
  const parts = []
  if (style.bold) parts.push('1')
  if (style.dim) parts.push('2')
  if (style.italic) parts.push('3')
  if (style.underline) parts.push('4')
  if (style.fg) {
    const c = hexToAnsi(style.fg)
    if (c) parts.push('38;2;' + c.r + ';' + c.g + ';' + c.b)
  }
  if (style.bg) {
    const c = hexToAnsi(style.bg)
    if (c) parts.push('48;2;' + c.r + ';' + c.g + ';' + c.b)
  }
  return parts.length > 0 ? '\x1b[' + parts.join(';') + 'm' : ''
}

const RESET = '\x1b[0m'

// ---- Screen -------------------------------------------------------------

// A row-major grid of cells; each cell carries a char and a style. The
// renderer diffs two screens so only changed cells reach the terminal.
export class Screen {
  constructor(cols, rows) {
    this.cols = cols
    this.rows = rows
    this.cells = []
    for (let y = 0; y < rows; y++) {
      const row = []
      for (let x = 0; x < cols; x++) row.push({ ch: ' ', style: null })
      this.cells.push(row)
    }
  }

  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return false
    const next = new Screen(cols, rows)
    const copyRows = Math.min(rows, this.rows)
    const copyCols = Math.min(cols, this.cols)
    for (let y = 0; y < copyRows; y++) {
      for (let x = 0; x < copyCols; x++) {
        next.cells[y][x] = this.cells[y][x]
      }
    }
    this.cols = cols
    this.rows = rows
    this.cells = next.cells
    return true
  }

  clear(style = null) {
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        this.cells[y][x] = { ch: ' ', style }
      }
    }
  }

  set(x, y, ch, style = null) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return
    this.cells[y][x] = { ch, style }
  }

  // Write a string horizontally starting at (x, y), clipping to the screen.
  // Handles wide runes by skipping the following cell. Returns the x after
  // the last written rune.
  text(x, y, str, style = null) {
    if (y < 0 || y >= this.rows) return x
    let cx = x
    for (const ch of str) {
      if (cx >= this.cols) break
      const w = runeWidth(ch)
      if (w === 0) {
        if (cx >= 0) this.set(cx, y, ch, style)
        continue
      }
      this.set(cx, y, ch, style)
      if (w === 2 && cx + 1 < this.cols) this.set(cx + 1, y, '', style)
      cx += w
    }
    return cx
  }

  // Fill a horizontal run with a char.
  fill(x, y, width, ch, style = null) {
    for (let i = 0; i < width; i++) this.set(x + i, y, ch, style)
  }

  // Fill an entire row to its right edge (used to keep background continuous).
  fillToEnd(x, y, style = null) {
    this.fill(x, y, Math.max(0, this.cols - x), ' ', style)
  }
}

// ---- Key decoding -------------------------------------------------------

const KEY_NAMES = {
  '\r': 'return', '\n': 'enter', '\t': 'tab', '\x7f': 'backspace', '\x08': 'backspace',
  '\x1b': 'escape',
}
const CTRL_NAMES = {
  '\x03': 'c', '\x04': 'd', '\x0e': 'n', '\x13': 's', '\x0c': 'l',
  '\x15': 'u', '\x01': 'a', '\x02': 'b', '\x05': 'e', '\x06': 'f',
  '\x07': 'g', '\x08': 'h', '\x09': 'i', '\x0a': 'j', '\x0b': 'k',
  '\x0f': 'o', '\x10': 'p', '\x11': 'q', '\x12': 'r', '\x14': 't',
  '\x16': 'v', '\x17': 'w', '\x18': 'x', '\x19': 'y', '\x1a': 'z',
}

// Decode one key event from a raw-mode byte buffer. Returns { key } or null
// when more bytes are needed.
export function decodeKey(input) {
  const first = input[0]
  if (first === 0x1b) {
    // A lone ESC is the escape key itself.
    if (input.length === 1) return { key: { name: 'escape' }, consumed: 1 }
    const seq = Buffer.from(input)
    const s = seq.toString('latin1')
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s)
    if (mouse) {
      const code = Number(mouse[1])
      const x = Number(mouse[2]) - 1
      const y = Number(mouse[3]) - 1
      const wheel = (code & 64) !== 0
      const motion = (code & 32) !== 0
      const buttonCode = code & 3
      const button = wheel ? 'wheel' : ['left', 'middle', 'right', 'none'][buttonCode]
      const action = wheel
        ? (buttonCode === 0 ? 'wheel-up' : 'wheel-down')
        : mouse[4] === 'm' || buttonCode === 3 ? 'up'
          : motion ? 'move' : 'down'
      return {
        key: {
          name: 'mouse',
          mouse: {
            x, y, button, action,
            shift: (code & 4) !== 0,
            alt: (code & 8) !== 0,
            ctrl: (code & 16) !== 0,
          },
        },
        consumed: mouse[0].length,
      }
    }
    // Legacy X10 mouse (no SGR): ESC [ M <button+32> <x+32> <y+32>.
    // Without this, wheel/click bytes that follow \x1b[M would be misread as
    // printable text and inserted into the composer.
    if (s.startsWith('\x1b[M')) {
      if (input.length < 6) return null
      const b = input[3] - 32
      const x = input[4] - 32 - 1
      const y = input[5] - 32 - 1
      const wheel = (b & 64) !== 0
      const motion = (b & 32) !== 0
      const release = (b & 3) === 3
      const buttonCode = b & 3
      const button = wheel ? 'wheel' : ['left', 'middle', 'right', 'none'][buttonCode]
      const action = wheel
        ? (buttonCode === 0 ? 'wheel-up' : 'wheel-down')
        : motion ? 'move'
          : release ? 'up' : 'down'
      return {
        key: {
          name: 'mouse',
          mouse: { x, y, button, action, shift: false, alt: false, ctrl: false },
        },
        consumed: 6,
      }
    }
    if (s.startsWith('\x1b[<')) return null
    const m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(s)
    if (m) {
      const param = m[1]
      const final = m[2]
      const consumed = m[0].length
      if (consumed > input.length) return null
      if (final === 'A') return { key: { name: 'up' }, consumed }
      if (final === 'B') return { key: { name: 'down' }, consumed }
      if (final === 'C') return { key: { name: 'right' }, consumed }
      if (final === 'D') return { key: { name: 'left' }, consumed }
      if (final === 'H') return { key: { name: 'home' }, consumed }
      if (final === 'F') return { key: { name: 'end' }, consumed }
      if (final === 'Z') return { key: { name: 'shift-tab' }, consumed }
      if (final === 'u') {
        const [code, modifier = 1] = param.split(';').map(Number)
        if (code === 13 && (modifier === 2 || modifier === 3)) return { key: { name: 'enter', shift: true }, consumed }
        if (code === 13 && modifier === 5) return { key: { name: 'enter', ctrl: true }, consumed }
        if (code > 0 && modifier === 5) return { key: { name: String.fromCodePoint(code), ctrl: true }, consumed }
      }
      if (final === '~') {
        const p = Number(param)
        const map = { 2: 'insert', 3: 'delete', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end' }
        if (map[p]) return { key: { name: map[p] }, consumed }
        if (p >= 11 && p <= 15) return { key: { name: 'f' + (p - 10) }, consumed }
        if (p === 17) return { key: { name: 'f6' }, consumed }
        if (p === 18) return { key: { name: 'f7' }, consumed }
        if (p === 19) return { key: { name: 'f8' }, consumed }
        if (p === 20) return { key: { name: 'f9' }, consumed }
        if (p === 21) return { key: { name: 'f10' }, consumed }
        if (p === 23) return { key: { name: 'f11' }, consumed }
        if (p === 24) return { key: { name: 'f12' }, consumed }
      }
      return { key: { name: 'unknown', sequence: s.slice(0, consumed) }, consumed }
    }
    // Alt+key or other ESC prefix: treat ESC + rest as alt-modified char.
    const rest = s[1]
    if (rest === '\r' || rest === '\n') return { key: { name: 'enter', shift: true }, consumed: 2 }
    if (rest !== undefined && !/^[\x00-\x1f\x7f]$/.test(rest)) {
      return { key: { name: rest, alt: true }, consumed: 2 }
    }
    return { key: { name: 'escape' }, consumed: 1 }
  }
  // Single control byte.
  const ch = Buffer.from([first]).toString('latin1')
  if (first === 0x1b) return { key: { name: 'escape' }, consumed: 1 }
  if (first === 0x0a) {
    // LF = Ctrl+J / Ctrl+Enter in raw mode. Route it to the newline path so
    // Ctrl+Enter inserts a line break instead of submitting (Enter is CR).
    return { key: { name: 'enter', ctrl: true }, consumed: 1 }
  }
  if (first < 0x20 || first === 0x7f) {
    const named = KEY_NAMES[ch]
    if (named) return { key: { name: named }, consumed: 1 }
    const ctrl = CTRL_NAMES[ch]
    if (ctrl) return { key: { name: ctrl, ctrl: true }, consumed: 1 }
    return { key: { name: 'unknown', sequence: ch }, consumed: 1 }
  }
  // Printable UTF-8: consume the full multibyte char.
  const decoded = seqFromUtf8(input)
  return { key: { name: decoded.text, text: decoded.text }, consumed: decoded.consumed }
}

function seqFromUtf8(input) {
  const b0 = input[0]
  let len = 1
  if (b0 >= 0xf0) len = 4
  else if (b0 >= 0xe0) len = 3
  else if (b0 >= 0xc0) len = 2
  const bytes = input.slice(0, len)
  if (bytes.length < len) return { text: '', consumed: 0 } // incomplete
  return { text: bytes.toString('utf8'), consumed: len }
}

// ---- Terminal -----------------------------------------------------------

export class Terminal extends EventEmitter {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    super()
    this.input = input
    this.output = output
    this.raw = false
    this.started = false
    this._buffer = Buffer.alloc(0)
    this.cols = output.columns || 80
    this.rows = output.rows || 24
    this._onData = (chunk) => this._handleData(chunk)
    this._onResize = () => {
      this.cols = this.output.columns || this.cols
      this.rows = this.output.rows || this.rows
      this.emit('resize')
    }
  }

  isTTY() {
    return Boolean(this.input.isTTY && this.output.isTTY)
  }

  start() {
    if (this.started) return
    this.started = true
    this.cols = this.output.columns || 80
    this.rows = this.output.rows || 24
    if (this.input.isTTY) {
      this.input.setRawMode(true)
      this.input.resume()
    }
    this.input.on('data', this._onData)
    this.output.on('resize', this._onResize)
    // Alternate screen, hide cursor, enable click, motion, and wheel tracking.
    this.write('\x1b[?1049h\x1b[?25l\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[H')
    this.raw = true
  }

  stop() {
    if (!this.started) return
    this.started = false
    this.input.off('data', this._onData)
    this.output.off('resize', this._onResize)
    if (this.input.isTTY) {
      this.input.setRawMode(false)
      this.input.pause()
    }
    // Disable mouse tracking, show cursor, leave alternate screen, reset.
    this.write('\x1b[?1006l\x1b[?1003l\x1b[?25h\x1b[0m\x1b[?1049l')
    this.raw = false
  }

  write(s) {
    this.output.write(s)
  }

  _handleData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk])
    while (this._buffer.length > 0) {
      const decoded = decodeKey(this._buffer)
      if (!decoded || decoded.consumed === 0) break
      this._buffer = this._buffer.subarray(decoded.consumed)
      this.emit('key', decoded.key)
    }
  }

  // Paint a Screen to the terminal, diffing against the previous frame.
  // Only rows that changed are rewritten.
  paint(screen) {
    const out = []
    if (!this._prev || this._prev.rows !== screen.rows || this._prev.cols !== screen.cols) {
      this._prev = new Screen(screen.cols, screen.rows)
    }
    const prev = this._prev
    const W = screen.cols
    for (let y = 0; y < screen.rows; y++) {
      let changed = false
      for (let x = 0; x < W; x++) {
        const a = screen.cells[y][x]
        const b = prev.cells[y][x]
        if (a.ch !== b.ch || !sameStyle(a.style, b.style)) {
          changed = true
          break
        }
      }
      if (!changed) continue
      // Rewrite the whole row: move cursor, emit styled runes, pad to width.
      out.push('\x1b[' + (y + 1) + ';1H')
      let lastStyle = null
      for (let x = 0; x < W; x++) {
        const cell = screen.cells[y][x]
        if (cell.ch === '' ) continue // wide-rune continuation cell
        const st = cell.style
        if (!sameStyle(st, lastStyle)) {
          if (lastStyle !== null) out.push(RESET)
          if (st !== null) out.push(styleAnsi(st))
          lastStyle = st
        }
        out.push(cell.ch)
      }
      if (lastStyle !== null) out.push(RESET)
    }
    this._prev.cells = screen.cells
    if (out.length > 0) this.write(out.join(''))
    // Park the (hidden) terminal cursor at the input caret so the OS IME
    // anchors its composition window inside the composer instead of at the
    // bottom-left corner. Screen coords are 0-based; the CSI cursor address
    // is 1-based, so add one to each. Falls back to the bottom-left.
    const cursorY = (screen.cursorY ?? screen.rows - 1) + 1
    const cursorX = (screen.cursorX ?? 0) + 1
    this.write('\x1b[' + cursorY + ';' + cursorX + 'H')
  }
}

function sameStyle(a, b) {
  if (a === b) return true
  if (a === null || b === null) return false
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim
    && a.italic === b.italic && a.underline === b.underline
}