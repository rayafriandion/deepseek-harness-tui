// The TUI view model and renderer: opencode-inspired layout with a dark
// theme, session sidebar, chat transcript, input row, and status bar.
import { Screen, makeStyle } from './term.js'
import { renderMarkdown, inlineSegments } from './markdown.js'
import { displayWidth, truncateWidth, fitWidth, timeString, jsonPreview, roughTokens } from './util.js'

// opencode default dark palette (src/theme/assets/opencode.json).
export const THEME = {
  primary: 'fab283',      // orange
  secondary: '5c9cf5',    // blue
  accent: '9d7cd8',       // purple
  error: 'e06c75',
  warning: 'f5a742',
  success: '7fd88f',
  info: '56b6c2',
  text: 'eeeeee',
  textMuted: '808080',
  background: '0a0a0a',
  backgroundPanel: '141414',
  backgroundElement: '1e1e1e',
  border: '484848',
  borderSubtle: '3c3c3c',
  markdownHeading: '9d7cd8',
  markdownLinkText: '56b6c2',
  markdownCode: '7fd88f',
  markdownCodeBlock: 'eeeeee',
  markdownBlockQuote: 'e5c07b',
  markdownListItem: 'fab283',
  markdownHorizontalRule: '808080',
  codeBg: '1e1e1e',
  thinking: '9a9a9a',
}

const PROMPT = '>'
const CURSOR = '█'

// A transcript block. Fields vary by kind.
// user:      { kind, text, time }
// assistant: { kind, text, reasoning, streaming, time }
// tool:      { kind, callId, name, args, status, result, time }
// todo:      { kind, todos, time }
// system:    { kind, text, level }
export function makeBlock(kind, data = {}) {
  return { kind, time: Date.now(), ...data }
}

// The application view state + layout + painting. It is dsh-agnostic: the
// plugin feeds it events and key presses.
export class App {
  constructor(terminal, { sidebarWidth = 30 } = {}) {
    this.term = terminal
    this.sidebarWidth = sidebarWidth
    this.blocks = []
    this.title = 'DeepSeek Harness'
    this.sessionId = ''
    this.model = ''
    this.provider = ''
    this.status = 'idle'           // idle | running
    this.usage = { input: 0, output: 0 }
    this.sidebarVisible = true
    this.sidebarAgents = []        // [{ id, label }]
    this.sidebarSessions = []      // [{ id, label, time }]
    this.sidebarSelection = -1
    this.inputText = ''
    this.inputCursor = 0
    this.history = []
    this.historyIndex = -1
    this.scroll = 0                // lines scrolled up from bottom (0 = follow)
    this.overlay = null            // 'help' | null
    this.toast = null              // { text, level }
    this.pendingApproval = null    // { toolName, reason, resolve, timer }
  }

  // ---- state mutations -------------------------------------------------

  setSession({ id, title, model, provider }) {
    if (id !== undefined) this.sessionId = id
    if (title !== undefined) this.title = title
    if (model !== undefined) this.model = model
    if (provider !== undefined) this.provider = provider
  }

  setStatus(status) {
    this.status = status
  }

  addSystem(text, level = 'info') {
    this.blocks.push(makeBlock('system', { text, level }))
    this._maybeFollow()
  }

  addUser(text) {
    this.blocks.push(makeBlock('user', { text }))
    this.scroll = 0
  }

  startAssistant() {
    this.blocks.push(makeBlock('assistant', { text: '', reasoning: '', streaming: true }))
    this.scroll = 0
  }

  // Append a stream chunk to the live assistant block.
  streamChunk(chunk) {
    let last = this.blocks[this.blocks.length - 1]
    if (!last || last.kind !== 'assistant' || !last.streaming) {
      this.startAssistant()
      last = this.blocks[this.blocks.length - 1]
    }
    if (chunk.type === 'text-delta') last.text += chunk.text
    else if (chunk.type === 'reasoning-delta') last.reasoning += chunk.text
    this.scroll = 0
  }

  finalizeAssistant() {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]
      if (b.kind === 'assistant' && b.streaming) {
        b.streaming = false
        if (b.text === '' && b.reasoning === '') this.blocks.splice(i, 1)
        break
      }
    }
  }

  // Ensure an assistant block exists (e.g. replay); returns it.
  ensureAssistantBlock(time) {
    const last = this.blocks[this.blocks.length - 1]
    if (last && last.kind === 'assistant') return last
    const b = makeBlock('assistant', { text: '', reasoning: '', streaming: false, time })
    this.blocks.push(b)
    return b
  }

  setAssistantText(text, time) {
    const b = this.ensureAssistantBlock(time)
    b.text = text
    b.streaming = false
    b.time = time ?? b.time
    this.scroll = 0
  }

  startTool({ callId, name, args }) {
    const b = makeBlock('tool', { callId, name, args, status: 'running', result: '' })
    this.blocks.push(b)
    this.scroll = 0
    return b
  }

  updateTool(callId, patch) {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]
      if (b.kind === 'tool' && b.callId === callId) {
        Object.assign(b, patch)
        this.scroll = 0
        return b
      }
    }
    return undefined
  }

  setTodo(todos) {
    const existing = this.blocks.find((b) => b.kind === 'todo')
    if (existing) existing.todos = todos
    else this.blocks.push(makeBlock('todo', { todos }))
    this.scroll = 0
  }

  resetView() {
    this.blocks = []
    this.usage = { input: 0, output: 0 }
    this.scroll = 0
  }

  _maybeFollow() {
    // Only auto-follow when the user has not scrolled up.
    // (Appended content while scroll === 0 keeps following; scroll > 0 stays put.)
  }

  showToast(text, level = 'info') {
    this.toast = { text, level }
  }

  // ---- layout ----------------------------------------------------------

  _layout() {
    const cols = this.term.cols
    const rows = this.term.rows
    const headerH = 1
    const inputH = 1
    const statusH = 1
    const transcriptTop = headerH
    const transcriptBottom = rows - inputH - statusH - 1
    const transcriptH = Math.max(1, transcriptBottom - transcriptTop)
    let sidebarW = this.sidebarVisible ? Math.min(this.sidebarWidth, Math.floor(cols / 3)) : 0
    if (cols - sidebarW < 24) sidebarW = 0
    return { cols, rows, headerH, inputH, statusH, transcriptTop, transcriptBottom, transcriptH, sidebarW }
  }

  // ---- block -> lines --------------------------------------------------

  _blockLines(block, width) {
    const t = THEME
    const out = []
    switch (block.kind) {
      case 'user': {
        out.push([{ text: '  You  ', style: makeStyle({ fg: t.primary, bold: true }) },
          { text: '· ' + timeString(block.time), style: makeStyle({ fg: t.textMuted }) }])
        for (const line of renderMarkdown(block.text, t, width - 2)) {
          out.push([{ text: '  ', style: null }, ...line])
        }
        out.push([])
        break
      }
      case 'assistant': {
        const header = [{ text: '  dsh  ', style: makeStyle({ fg: t.accent, bold: true }) },
          { text: '· ' + timeString(block.time), style: makeStyle({ fg: t.textMuted }) }]
        out.push(header)
        if (block.reasoning) {
          for (const line of renderMarkdown(block.reasoning, t, width - 2)) {
            out.push([{ text: '  ', style: null },
              ...line.map((s) => ({ ...s, style: makeStyle({ fg: t.thinking, italic: true }) }))])
          }
        }
        let text = block.text
        if (block.streaming) text += '▍'
        if (text) {
          const lines = renderMarkdown(text, t, width - 2)
          if (lines.length === 0) lines.push([])
          for (const line of lines) out.push([{ text: '  ', style: null }, ...line])
        }
        out.push([])
        break
      }
      case 'tool': {
        const statusChar = block.status === 'running' ? '…' : block.status === 'error' ? '✗' : '✓'
        const statusColor = block.status === 'running' ? t.warning : block.status === 'error' ? t.error : t.success
        const label = (block.name ?? 'tool') + (block.args ? ' ' + truncateWidth(jsonPreview(block.args), width - 24) : '')
        out.push([{ text: '  ' + statusChar + ' ', style: makeStyle({ fg: statusColor }) },
          { text: label, style: makeStyle({ fg: t.text }) }])
        if (block.status === 'running') {
          out.push([])
          break
        }
        if (block.result) {
          const resultLines = renderMarkdown(block.result, t, width - 4)
          for (const line of resultLines.slice(0, 6)) {
            out.push([{ text: '    ', style: null },
              ...line.map((s) => ({ ...s, style: makeStyle({ fg: t.textMuted }) }))])
          }
          if (resultLines.length > 6) {
            out.push([{ text: '    … ' + (resultLines.length - 6) + ' more lines', style: makeStyle({ fg: t.textMuted, dim: true }) }])
          }
        }
        out.push([])
        break
      }
      case 'todo': {
        out.push([{ text: '  tasks', style: makeStyle({ fg: t.info, bold: true }) }])
        for (const item of block.todos ?? []) {
          const mark = item.status === 'completed' ? '☑' : item.status === 'in_progress' ? '◐' : '□'
          const color = item.status === 'completed' ? t.success : item.status === 'in_progress' ? t.warning : t.textMuted
          out.push([{ text: '  ' + mark + ' ', style: makeStyle({ fg: color }) },
            { text: item.content, style: makeStyle({ fg: t.text }) }])
        }
        out.push([])
        break
      }
      case 'system': {
        const color = block.level === 'error' ? t.error : block.level === 'warn' ? t.warning : t.textMuted
        for (const line of renderMarkdown(block.text, t, width - 2)) {
          out.push([{ text: '  ', style: null }, ...line.map((s) => ({ ...s, style: makeStyle({ fg: color, italic: true }) }))])
        }
        out.push([])
        break
      }
      default:
        break
    }
    return out
  }

  _transcriptLines(width) {
    const lines = []
    for (const block of this.blocks) {
      for (const line of this._blockLines(block, width)) lines.push(line)
    }
    return lines
  }

  // ---- paint -----------------------------------------------------------

  render() {
    const { cols, rows, transcriptTop, transcriptH, sidebarW } = this._layout()
    const screen = new Screen(cols, rows)
    const t = THEME
    screen.clear(makeStyle({ bg: t.background }))

    // Header
    const headerStyle = makeStyle({ fg: t.textMuted, bg: t.backgroundPanel })
    screen.fill(0, 0, cols, ' ', headerStyle)
    let hx = 2
    hx = screen.text(hx, 0, '◈ DeepSeek Harness TUI', makeStyle({ fg: t.primary, bold: true, bg: t.backgroundPanel }))
    const titleText = truncateWidth(this.title, Math.max(8, cols - hx - 22))
    hx = screen.text(hx, 0, '  ' + titleText, headerStyle)
    const modelInfo = this.model ? this.model : '…'
    const modelX = cols - displayWidth(modelInfo) - 2
    if (modelX > hx) {
      screen.text(modelX, 0, modelInfo, makeStyle({ fg: t.accent, bg: t.backgroundPanel }))
      screen.fill(hx, 0, modelX - hx, ' ', headerStyle)
      screen.fillToEnd(modelX + displayWidth(modelInfo), 0, headerStyle)
    } else {
      screen.fillToEnd(hx, 0, headerStyle)
    }

    // Sidebar
    let transcriptX = 0
    if (sidebarW > 0) {
      transcriptX = sidebarW + 1
      const sideStyle = makeStyle({ fg: t.textMuted, bg: t.backgroundPanel })
      screen.fill(0, 1, sidebarW, ' ', sideStyle)
      screen.text(2, 1, 'SESSIONS', makeStyle({ fg: t.textMuted, bold: true, bg: t.backgroundPanel }))
      let sy = 3
      const active = this.sessionId
      for (const agent of this.sidebarAgents) {
        if (sy >= transcriptTop + transcriptH - 1) break
        const selected = agent.id === active
        const st = selected
          ? makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement })
          : sideStyle
        screen.text(1, sy, (selected ? '▸ ' : '  ') + truncateWidth(agent.label, sidebarW - 4), st)
        screen.fillToEnd(0, sy, st)
        sy++
      }
      if (this.sidebarSessions.length > 0) {
        if (sy < transcriptTop + transcriptH - 1) {
          screen.text(2, sy, 'RECENT', makeStyle({ fg: t.textMuted, bold: true, bg: t.backgroundPanel }))
          sy++
        }
        for (let i = 0; i < this.sidebarSessions.length; i++) {
          if (sy >= transcriptTop + transcriptH - 1) break
          const s = this.sidebarSessions[i]
          const selected = s.id === active
          const st = selected
            ? makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement })
            : sideStyle
          screen.text(1, sy, (selected ? '▸ ' : '  ') + truncateWidth(s.label, sidebarW - 4), st)
          screen.fillToEnd(0, sy, st)
          sy++
        }
      }
      // vertical border
      screen.fill(sidebarW, 1, 1, '│', makeStyle({ fg: t.borderSubtle }))
      screen.fill(sidebarW, transcriptTop, 1, '│', makeStyle({ fg: t.borderSubtle }))
    }

    // Transcript
    const transWidth = cols - transcriptX
    const allLines = this._transcriptLines(transWidth)
    const maxScroll = Math.max(0, allLines.length - transcriptH)
    let offset = maxScroll - this.scroll
    if (this.scroll === 0) offset = maxScroll
    offset = Math.max(0, Math.min(offset, maxScroll))
    for (let i = 0; i < transcriptH; i++) {
      const y = transcriptTop + i
      const src = offset + i
      if (src < allLines.length) {
        let x = transcriptX
        for (const seg of allLines[src]) {
          x = screen.text(x, y, seg.text, seg.style)
        }
        screen.fillToEnd(x, y, makeStyle({ fg: t.text }))
      } else {
        screen.fill(transcriptX, y, cols - transcriptX, ' ', makeStyle({ bg: t.background }))
      }
    }

    // Input row
    const inputRow = rows - 2
    screen.fill(0, inputRow, cols, ' ', makeStyle({ bg: t.backgroundPanel }))
    if (this.pendingApproval) {
      screen.text(2, inputRow, '⚠ ' + this.pendingApproval.toolName + ' needs approval — y/n?', makeStyle({ fg: t.warning, bold: true, bg: t.backgroundPanel }))
      screen.fillToEnd(0, inputRow, makeStyle({ bg: t.backgroundPanel }))
    } else {
      screen.text(1, inputRow, PROMPT, makeStyle({ fg: t.primary, bold: true, bg: t.backgroundPanel }))
      const text = this.inputText
      const cursor = this.inputCursor
      const avail = cols - 3
      // Keep the cursor visible by scrolling the visible window.
      let start = 0
      if (cursor > avail) start = cursor - avail + 1
      const visible = truncateWidth(text.slice(start), avail)
      const cursorInVisible = cursor - start
      const before = truncateWidth(visible.slice(0, cursorInVisible), cursorInVisible)
      const after = truncateWidth(visible.slice(before.length), avail - displayWidth(before))
      let x = 3
      x = screen.text(x, inputRow, before, makeStyle({ fg: t.text, bg: t.backgroundPanel }))
      const curCh = after.length > 0 ? after[0] : ' '
      screen.text(x, inputRow, curCh, makeStyle({ fg: t.background, bg: t.primary }))
      x += 1
      x = screen.text(x, inputRow, after.slice(1), makeStyle({ fg: t.text, bg: t.backgroundPanel }))
      screen.fillToEnd(x, inputRow, makeStyle({ bg: t.backgroundPanel }))
    }

    // Status row
    const statusRow = rows - 1
    const statusStyle = makeStyle({ fg: t.textMuted, bg: t.background })
    screen.fill(0, statusRow, cols, ' ', statusStyle)
    const statusDot = this.status === 'running' ? '●' : '○'
    const dotColor = this.status === 'running' ? t.success : t.textMuted
    screen.text(1, statusRow, statusDot, makeStyle({ fg: dotColor, bg: t.background }))
    const tokText = this.usage.input > 0
      ? this.usage.input + '→' + this.usage.output + ' tok'
      : roughTokens(this.inputText) + ' tok'
    const left = ' ' + (this.model || '…') + ' · ' + tokText + ' · ' + this.sessionId
    screen.text(3, statusRow, truncateWidth(left, cols - 6), statusStyle)
    const right = 'Ctrl+C cancel  /help  /quit'
    screen.text(cols - displayWidth(right) - 1, statusRow, right, makeStyle({ fg: t.textMuted, bg: t.background }))
    screen.fillToEnd(0, statusRow, statusStyle)

    // Toast
    if (this.toast) {
      const st = makeStyle({ fg: this.toast.level === 'error' ? t.error : t.info, bg: t.backgroundElement })
      screen.text(1, transcriptTop, ' ' + this.toast.text + ' ', st)
    }

    // Help overlay
    if (this.overlay === 'help') this._paintHelp(screen, cols, rows)

    return screen
  }

  _paintHelp(screen, cols, rows) {
    const t = THEME
    const w = Math.min(64, cols - 4)
    const h = 22
    const x0 = Math.max(0, Math.floor((cols - w) / 2))
    const y0 = Math.max(0, Math.floor((rows - h) / 2))
    const box = makeStyle({ fg: t.text, bg: t.backgroundElement })
    const border = makeStyle({ fg: t.border })
    screen.fill(x0, y0, w, ' ', box)
    for (let i = 0; i < w; i++) {
      screen.set(x0 + i, y0, '─', border)
      screen.set(x0 + i, y0 + h - 1, '─', border)
    }
    for (let i = 0; i < h; i++) {
      screen.set(x0, y0 + i, '│', border)
      screen.set(x0 + w - 1, y0 + i, '│', border)
    }
    screen.set(x0, y0, '┌', border); screen.set(x0 + w - 1, y0, '┐', border)
    screen.set(x0, y0 + h - 1, '└', border); screen.set(x0 + w - 1, y0 + h - 1, '┘', border)
    screen.text(x0 + 2, y0 + 1, 'DeepSeek Harness TUI — help', makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement }))
    const rows2 = [
      ['Enter', 'send message'],
      ['Ctrl+C', 'cancel running turn; press again to quit'],
      ['Ctrl+N', 'new session'],
      ['Ctrl+S', 'toggle sidebar'],
      ['PgUp / PgDn', 'scroll transcript'],
      ['Up / Down', 'input history (in empty input: sidebar nav)'],
      ['Esc', 'close help / cancel'],
    ]
    let yy = y0 + 3
    for (const [key, desc] of rows2) {
      screen.text(x0 + 3, yy, key, makeStyle({ fg: t.success, bg: t.backgroundElement }))
      screen.text(x0 + 3 + 14, yy, desc, makeStyle({ fg: t.text, bg: t.backgroundElement }))
      yy++
    }
    yy++
    screen.text(x0 + 3, yy, 'Commands:', makeStyle({ fg: t.accent, bold: true, bg: t.backgroundElement }))
    yy++
    for (const cmd of ['/help  /new  /resume <id>  /sessions  /model <id>  /clear  /cancel  /quit']) {
      screen.text(x0 + 3, yy, cmd, makeStyle({ fg: t.text, bg: t.backgroundElement }))
      yy++
    }
  }
}