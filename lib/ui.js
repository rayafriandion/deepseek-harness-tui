// The TUI view model and renderer: opencode-inspired layout with a dark
// theme, session sidebar, chat transcript, input row, and status bar.
import { Screen, makeStyle, mergeStyle, hexToAnsi } from './term.js'
import { renderMarkdown } from './markdown.js'
import { displayWidth, truncateWidth, timeString, toolSummary, roughTokens, formatTokens } from './util.js'

// DeepSeek brand palette: deep blue accents on a blue-tinted dark canvas.
export const THEME = {
  primary: '4d6bfe',      // DeepSeek blue
  secondary: '6c9cff',    // light blue
  accent: '7c9cff',       // light blue accent
  error: 'e06c75',
  warning: 'e8c468',      // soft gold (no orange)
  success: '7fd88f',
  info: '56b6c2',
  text: 'f0f4ff',         // blue-white text
  textMuted: '8a93a8',
  background: '0a0e18',   // blue-tinted dark background
  backgroundPanel: '111a2c',
  backgroundElement: '1b2740',
  border: '3d4d73',
  borderSubtle: '2b3a5c',
  markdownHeading: '7c9cff',
  markdownLinkText: '6c9cff',
  markdownCode: '7fd88f',
  markdownCodeBlock: 'f0f4ff',
  markdownBlockQuote: '9fb0d8',
  markdownListItem: '4d6bfe',
  markdownHorizontalRule: '46547a',
  codeBg: '1b2740',
  thinking: '9aa6c2',
  reminder: 'c5bdf7',       // system-reminder box text (pale violet)
  reminderBg: '3a2f66',     // system-reminder box background (violet)
  compaction: '95d8c0',     // compaction box text (pale mint)
  compactionBg: '1f5241',   // compaction box background (green)
  // Context-meter segments (web ContextMeter port): heuristic composition
  // shares get distinct hues so the breakdown bar reads at a glance.
  contextSystem: '7fd88f',
  contextTools: 'e8c468',
  contextMessages: '56b6c2',
}

// Flowing activity indicator frames (clockwise Braille flow).
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const COMMAND_HINTS = [
  ['/new', 'new session'], ['/resume', 'resume session'],
  ['/model', 'select model'], ['/provider', 'select provider'], ['/compact', 'compact context'],
  ['/goal', 'manage goal'], ['/settings', 'open settings'],
  ['/clear', 'clear view'], ['/quit', 'exit'],
]

function inputRows(text, cursor, width) {
  const rows = ['']
  let row = 0
  let col = 0
  let cursorRow = 0
  let cursorCol = 0
  let offset = 0
  for (const ch of text) {
    if (offset === cursor) {
      cursorRow = row
      cursorCol = col
    }
    if (ch === '\n') {
      rows.push('')
      row++
      col = 0
      offset += ch.length
      continue
    }
    const rune = displayWidth(ch)
    if (col > 0 && col + rune > width) {
      rows.push('')
      row++
      col = 0
    }
    rows[row] += ch
    col += rune
    offset += ch.length
  }
  if (cursor >= offset) {
    cursorRow = row
    cursorCol = col
  }
  return { rows, cursorRow, cursorCol }
}

function cursorAtVisual(text, width, targetRow, targetCol) {
  let row = 0
  let col = 0
  let offset = 0
  let lastOnRow = 0
  for (const ch of text) {
    if (ch === '\n') {
      if (row === targetRow) return targetCol >= col ? offset : lastOnRow
      row++
      col = 0
      offset += ch.length
      lastOnRow = offset
      continue
    }
    const rune = displayWidth(ch)
    if (col > 0 && col + rune > width) {
      if (row === targetRow) return offset
      row++
      col = 0
      lastOnRow = offset
    }
    if (row === targetRow && targetCol <= col) return offset
    col += rune
    offset += ch.length
    if (row === targetRow) lastOnRow = offset
  }
  return row < targetRow ? text.length : lastOnRow
}

function formatDuration(ms) {
  return ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) + 's'
}

function formatMetric(value) {
  return value >= 100 ? Math.round(value).toString() : value.toFixed(1)
}

// Pad a line's segments to the full transcript width with a background fill
// so a "boxed" region (e.g. thinking) keeps its emphasized background even in
// cells that carry no text.
function boxPad(segs, width, bg) {
  let w = 0
  for (const s of segs) w += displayWidth(s.text)
  if (w >= width) return segs
  return [...segs, { text: ' '.repeat(width - w), style: makeStyle({ bg }) }]
}

// Interpolate between two hex colors; t in [0, 1].
function mixColor(a, b, t) {
  const ca = hexToAnsi(a)
  const cb = hexToAnsi(b)
  const ch = [0, 1, 2].map((i) => {
    const v = [ca.r, ca.g, ca.b][i] + ([cb.r, cb.g, cb.b][i] - [ca.r, ca.g, ca.b][i]) * t
    return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  })
  return '#' + ch.join('')
}

// Draw text with a per-character color gradient from `from` to `to`.
function gradientText(screen, x, y, text, from, to, base = {}) {
  const chars = Array.from(text)
  let cx = x
  for (let i = 0; i < chars.length; i++) {
    const t = chars.length > 1 ? i / (chars.length - 1) : 0
    cx = screen.text(cx, y, chars[i], makeStyle({ ...base, fg: mixColor(from, to, t) }))
  }
  return cx
}

// A transcript block. Fields vary by kind.
// user:      { kind, text, time }
// assistant: { kind, text, reasoning, streaming, thinkingCollapsed, time }
// tool:      { kind, callId, name, args, status, result, time }
// todo:      { kind, todos, time }
// system:    { kind, text, level }
// note:      { kind, text, label, collapsed, time }
export function makeBlock(kind, data = {}) {
  return { kind, time: Date.now(), rev: 0, ...data }
}

// Classify a non-user context message into a labeled collapsible note.
// `system-reminder` frames and compaction checkpoints get labeled boxes;
// everything else stays a plain system line.
export function noteFromContext(src, text) {
  if (typeof text !== 'string') return null
  if (text.includes('<system-reminder>')) {
    return { label: 'system-reminder', text: stripTag(text, 'system-reminder') }
  }
  if (src && src.kind === 'plugin' && src.plugin === 'compact') {
    return { label: 'compaction', text: stripTag(text, 'compacted-summary') }
  }
  return null
}

function stripTag(text, name) {
  return text.replace(new RegExp('<\\s*/?\\s*' + name + '\\s*>', 'g'), '').trim()
}

// The application view state + layout + painting. It is dsh-agnostic: the
// plugin feeds it events and key presses.
export class App {
  constructor(terminal, { sidebarWidth = 30 } = {}) {
    this.term = terminal
    this.sidebarWidth = sidebarWidth
    this.blocks = []
    this.assistantHeaderPending = true
    this.title = 'DeepSeek Harness'
    this.titleScreen = true
    this.workingDirectory = ''
    this.gitBranch = ''
    this.sessionId = ''
    this.model = ''
    this.provider = ''
    this.status = 'idle'           // idle | running
    this.usage = { input: 0, output: 0 }
    this.metrics = {}
    this.contextMeter = null       // { percent, usedTokens, contextWindow, breakdown } — web ContextMeter port
    this.contextMeterOpen = false  // click-open breakdown panel
    this.sidebarVisible = false
    this.sidebarAgents = []        // [{ id, label }]
    this.sidebarSessions = []      // [{ id, label, time }]
    this.sidebarSelection = -1
    this.inputText = ''
    this.inputCursor = 0
    this.history = []
    this.historyIndex = -1
    this.scroll = 0                // lines scrolled up from bottom (0 = follow)
    this.overlay = null            // 'help' | 'settings' | null
    this.settingsSelection = 0
    this.settingsEditing = null
    this.settingsDraft = ''
    this.settingsSecret = false
    this.settingsConfirm = null
    this.settingsTitle = 'Settings'
    this.settingsSubtitle = ''
    this.settingsItems = []
    this.toast = null              // { text, level }
    this.effortSlider = null       // { levels: [{id, name}], current } — the current model's real reasoning levels
    this.effortSliderVisible = false
    this.pendingApproval = null    // { toolName, reason, resolve, timer }
    this.focusedRegion = 'keyboard' // mouse hover temporarily owns focus
    this._lastHover = ''            // last hovered target (focus-follows-mouse cache)
    this.hitRegions = []           // topmost interactive regions from the latest render
    this._blockLineCache = new Map() // rendered lines per block, keyed by rev+width
    this._streamingRenderAt = 0    // last time the live streaming block was re-rendered
  }

  addHitRegion(kind, x, y, width, height = 1, data = {}) {
    if (width <= 0 || height <= 0) return
    this.hitRegions.push({ kind, x, y, width, height, ...data })
  }

  hitTest(x, y, kinds) {
    for (let i = this.hitRegions.length - 1; i >= 0; i--) {
      const region = this.hitRegions[i]
      if (kinds && !kinds.includes(region.kind)) continue
      if (x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height) return region
    }
    return undefined
  }

  placeInputCursor(x, y) {
    const region = this.hitTest(x, y, ['composer'])
    if (!region) return false
    const visualRow = region.firstVisual + Math.max(0, y - region.composerTop - 1)
    const visualCol = Math.max(0, x - region.x - 2)
    this.inputCursor = cursorAtVisual(this.inputText, Math.max(1, region.width - 4), visualRow, visualCol)
    return true
  }

  // Focus follows the cursor: hovering an interactive row (settings item,
  // sidebar session) moves the keyboard selection there. Returns true when
  // the pointer moved the focus (or left it stale relative to the current
  // selection), so the caller repaints; returns false when nothing changed.
  // The last-hover cache alone is not enough — the selection can move away
  // (keyboard, click, reopened list) while the pointer never leaves the row,
  // and re-hovering that row must move the focus back even though the target
  // did not change.
  hoverFocus(x, y) {
    const region = this.hitTest(x, y)
    const target = region ? region.kind + ':' + (region.settingsIndex ?? region.sessionIndex ?? '') : ''
    const focusIndex = region ? (region.settingsIndex ?? region.sessionIndex ?? -1) : -1
    const focusDiffers = focusIndex >= 0 && focusIndex !== (region.kind === 'settings-item' ? this.settingsSelection : this.sidebarSelection)
    if (target === this._lastHover && !focusDiffers) return false
    this._lastHover = target
    if (!region) return false
    this.focusedRegion = 'mouse'
    if (region.kind === 'settings-item') this.settingsSelection = region.settingsIndex
    if (region.kind === 'session') this.sidebarSelection = region.sessionIndex
    return true
  }

  // ---- state mutations -------------------------------------------------

  setWelcome({ workingDirectory = '', gitBranch = '', model, provider } = {}) {
    this.titleScreen = true
    this.workingDirectory = workingDirectory
    this.gitBranch = gitBranch
    this.sessionId = ''
    // No active session: the top bar names the empty workspace instead of
    // leaking the previous session's title.
    this.title = 'New session'
    if (model !== undefined) this.model = model
    if (provider !== undefined) this.provider = provider
  }

  setSession({ id, title, model, provider }) {
    if (id !== undefined) {
      this.sessionId = id
      if (id) this.titleScreen = false
    }
    if (title !== undefined) this.title = title
    if (model !== undefined) this.model = model
    if (provider !== undefined) this.provider = provider
  }

  setStatus(status) {
    this.status = status
  }

  // The reasoning-effort slider data: the current model's ACTUAL selectable
  // levels (in provider order, weakest -> strongest — a boolean-thinking model
  // exposes two, a full-range one exposes every level the provider advertises)
  // plus the selected id. `null` means the current model exposes no reasoning.
  setEffortSlider(slider) {
    this.effortSlider = slider
  }

  _effortIndex() {
    const slider = this.effortSlider
    if (!slider) return -1
    return Math.max(0, slider.levels.findIndex((level) => level.id === slider.current))
  }

  _effortLevel() {
    const slider = this.effortSlider
    if (!slider || slider.levels.length === 0) return null
    return slider.levels[this._effortIndex()] ?? null
  }

  // The animation/styling is reserved for the strongest level the model
  // actually exposes. A one-level model (e.g. Off-only, thinking disabled)
  // has no meaningful max and never animates.
  _effortAtMax() {
    const slider = this.effortSlider
    if (!slider || slider.levels.length <= 1) return false
    return this._effortIndex() === slider.levels.length - 1
  }

  setMetrics(metrics) {
    this.metrics = metrics
    this.usage = { input: metrics.inputTokens ?? 0, output: metrics.outputTokens ?? 0 }
  }

  // Port of the web composer's ContextMeter data: the token-meter
  // `contextPressure` projection (current context length over the context
  // window limit) plus the heuristic `contextBreakdown` composition. The
  // numerator is `projectedTokens` (the provider sample carried over the
  // surface's movement since) so a compaction shows at once; it falls back to
  // the bare sample only for a projection that predates that field. Renders
  // nothing until the provider reports both a numerator and a capacity.
  setContextMeter(meter = {}) {
    const { pressure, breakdown } = meter ?? {}
    const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
    if (usedTokens === undefined || pressure?.contextWindow === undefined) {
      this.contextMeter = null
      this.contextMeterOpen = false
      return
    }
    const partsTotal = breakdown?.systemTokens + breakdown?.toolsTokens + breakdown?.messageTokens
    this.contextMeter = {
      percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
      usedTokens,
      contextWindow: pressure.contextWindow,
      breakdown: breakdown && partsTotal > 0 ? breakdown : null,
    }
  }

  openSettings(items, { title = 'Settings', subtitle = '' } = {}) {
    this.settingsItems = items
    this.settingsSelection = 0
    this.settingsEditing = null
    this.settingsDraft = ''
    this.settingsSecret = false
    this.settingsConfirm = null
    this.settingsTitle = title
    this.settingsSubtitle = subtitle
    this.overlay = 'settings'
  }

  addSystem(text, level = 'info') {
    this.blocks.push(makeBlock('system', { text, level }))
    this._maybeFollow()
  }

  addNote(text, label = 'context') {
    this.blocks.push(makeBlock('note', { text, label, collapsed: true }))
    this.scroll = 0
  }

  addUser(text) {
    this.blocks.push(makeBlock('user', { text }))
    this.assistantHeaderPending = true
    this.scroll = 0
  }

  startAssistant() {
    const showHeader = this.assistantHeaderPending
    this.assistantHeaderPending = false
    this.blocks.push(makeBlock('assistant', { text: '', reasoning: '', streaming: true, showHeader }))
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
    last.rev++
    this.scroll = 0
  }

  finalizeAssistant() {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]
      if (b.kind === 'assistant' && b.streaming) {
        b.streaming = false
        b.rev++
        // Thinking is collapsed by default once it has finished streaming.
        if (b.reasoning && b.thinkingCollapsed === undefined) b.thinkingCollapsed = true
        if (b.text === '' && b.reasoning === '') this.blocks.splice(i, 1)
        break
      }
    }
  }

  // Ensure an assistant block exists (e.g. replay); returns it.
  ensureAssistantBlock(time) {
    const last = this.blocks[this.blocks.length - 1]
    if (last && last.kind === 'assistant') return last
    const showHeader = this.assistantHeaderPending
    this.assistantHeaderPending = false
    const b = makeBlock('assistant', { text: '', reasoning: '', streaming: false, time, showHeader })
    this.blocks.push(b)
    return b
  }

  setAssistantText(text, time) {
    const b = this.ensureAssistantBlock(time)
    b.text = text
    b.streaming = false
    b.rev++
    if (b.reasoning && b.thinkingCollapsed === undefined) b.thinkingCollapsed = true
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
        b.rev++
        this.scroll = 0
        return b
      }
    }
    return undefined
  }

  setTodo(todos) {
    const existing = this.blocks.find((b) => b.kind === 'todo')
    if (existing) {
      existing.todos = todos
      existing.rev++
    } else {
      this.blocks.push(makeBlock('todo', { todos }))
    }
    this.scroll = 0
  }

  resetView() {
    this.blocks = []
    this.usage = { input: 0, output: 0 }
    this.metrics = {}
    this.scroll = 0
    this._blockLineCache.clear()
  }

  // Toggle a completed thinking box between collapsed and expanded. Thinking
  // stays collapsed while it is still streaming.
  toggleThinking(block) {
    if (!block || block.kind !== 'assistant' || !block.reasoning || block.streaming) return
    block.thinkingCollapsed = block.thinkingCollapsed !== true
    block.rev++
  }

  // Toggle a context note (system-reminder / compaction) between collapsed
  // and expanded.
  toggleNote(block) {
    if (!block || block.kind !== 'note') return
    block.collapsed = block.collapsed !== true
    block.rev++
  }

  // Current flowing-spinner frame (time-based so it animates across paints
  // without any per-frame state).
  animChar(interval = 80) {
    return SPINNER[Math.floor(Date.now() / interval) % SPINNER.length]
  }

  // True while anything is still animating: a streaming turn or a running
  // tool (read/write/bash/...). The UI loop keeps repainting while this is
  // true so spinners keep flowing even when no events are arriving.
  hasAnimation() {
    if (this.status === 'running') return true
    // The max effort effect keeps flowing even after the slider is closed —
    // the composer's top-right effort label stays animated at the strongest
    // level.
    if (this.effortSlider && this._effortAtMax()) return true
    for (const block of this.blocks) {
      if (block.kind === 'assistant' && block.streaming) return true
      if (block.kind === 'tool' && block.status === 'running') return true
    }
    return false
  }


  scrollTranscript(delta) {
    const layout = this._layout()
    const width = layout.cols - layout.sidebarW - (layout.sidebarW > 0 ? 1 : 0)
    const maxScroll = Math.max(0, this._transcriptTotal(width) - layout.transcriptH)
    this.scroll = Math.max(0, Math.min(maxScroll, this.scroll + delta))
  }

  _maybeFollow() {
    // Only auto-follow when the user has not scrolled up.
    // (Appended content while scroll === 0 keeps following; scroll > 0 stays put.)
  }

  showToast(text, level = 'info') {
    this.toast = { text, level }
    if (this._toastTimer) clearTimeout(this._toastTimer)
    this._toastTimer = null
    // Auto-dismiss only makes sense when we can repaint to clear it; in
    // headless/test use (no term.paint) the toast stays for the caller to
    // inspect.
    if (!this.term || typeof this.term.paint !== 'function') return
    this._toastTimer = setTimeout(() => {
      this._toastTimer = null
      if (this.toast) {
        this.toast = null
        if (this.term.started) this.term.paint(this.render())
      }
    }, 2000)
  }

  // ---- layout ----------------------------------------------------------

  _layout() {
    const cols = this.term.cols
    const rows = this.term.rows
    const headerH = rows >= 20 ? 2 : 1
    const statusH = 1
    const sliderH = this.effortSliderVisible && this.effortSlider ? 1 : 0
    let sidebarW = this.sidebarVisible && cols >= 92 ? Math.min(this.sidebarWidth, Math.floor(cols / 3)) : 0
    if (cols - sidebarW < 52) sidebarW = 0
    const composerWidth = Math.max(20, cols - sidebarW - 6)
    const visual = inputRows(this.inputText, this.inputCursor, composerWidth)
    const inputRowsVisible = Math.min(Math.max(1, visual.rows.length), rows >= 28 ? 6 : 3)
    const suggestions = this.inputText.startsWith('/') && !this.inputText.includes(' ') ? Math.min(4, COMMAND_HINTS.filter(([command]) => command.startsWith(this.inputText)).length) : 0
    const inputH = inputRowsVisible + 2 + suggestions
    const transcriptTop = headerH
    const transcriptBottom = rows - inputH - statusH - sliderH
    const transcriptH = Math.max(1, transcriptBottom - transcriptTop)
    return { cols, rows, headerH, inputH, inputRowsVisible, suggestions, statusH, sliderH, transcriptTop, transcriptBottom, transcriptH, sidebarW, visual }
  }

  // ---- block -> lines --------------------------------------------------

  _blockLines(block, width) {
    const t = THEME
    const out = []
    switch (block.kind) {
      case 'user': {
        out.push({ segs: [{ text: '  You  ', style: makeStyle({ fg: t.primary, bold: true }) },
          { text: '· ' + timeString(block.time), style: makeStyle({ fg: t.textMuted }) }] })
        for (const line of renderMarkdown(block.text, t, width - 2)) {
          out.push({ segs: [{ text: '  ', style: null }, ...line] })
        }
        out.push({ segs: [] })
        break
      }
      case 'assistant': {
        if (block.showHeader !== false) {
          const header = [{ text: '  dsh  ', style: makeStyle({ fg: t.accent, bold: true }) },
            { text: '· ' + timeString(block.time), style: makeStyle({ fg: t.textMuted }) }]
          out.push({ segs: header })
        }
        // Thinking is rendered as a gray-emphasised box (no solid border).
        // It stays collapsed while streaming and collapses by default once
        // streaming finishes; the whole box is a click target that toggles
        // between collapsed and expanded (only after it has finished).
        if (block.reasoning) {
          const boxBg = t.backgroundElement
          const streaming = block.streaming === true
          const collapsed = block.thinkingCollapsed === true || streaming
          const hint = streaming ? ' · streaming…' : (collapsed ? ' · click to expand' : ' · click to collapse')
          // While streaming, a flowing spinner leads the header (replaced at
          // draw time so the cached lines can stay static between frames).
          const marker = streaming
            ? { text: '⠿', style: makeStyle({ fg: t.primary, bg: boxBg, bold: true }), anim: 'spinner' }
            : { text: collapsed ? '▸' : '▾', style: makeStyle({ fg: t.thinking, bg: boxBg, bold: true }) }
          const headerSegs = [
            { text: '  ', style: makeStyle({ fg: t.thinking, bg: boxBg }) },
            marker,
            { text: ' thinking' + hint, style: makeStyle({ fg: t.thinking, bg: boxBg, bold: true }) },
          ]
          out.push({ segs: boxPad(headerSegs, width, boxBg), thinking: { block } })
          if (!collapsed) {
            for (const line of renderMarkdown(block.reasoning, t, width - 4)) {
              const segs = boxPad([
                { text: '  ', style: makeStyle({ fg: t.thinking, bg: boxBg }) },
                ...line.map((s) => ({
                  ...s,
                  style: mergeStyle(s.style, { fg: t.thinking, italic: true, bg: boxBg }),
                })),
              ], width, boxBg)
              out.push({ segs, thinking: { block } })
            }
          }
        }
        let text = block.text
        if (block.streaming) text += '▍'
        // A blank line separates the thinking box from the visible answer so
        // the two never run together; skipped when there is no visible answer
        // (pure reasoning) to avoid doubling the block's trailing gap.
        if (block.reasoning && text) out.push({ segs: [] })
        if (text) {
          const lines = renderMarkdown(text, t, width - 2)
          if (lines.length === 0) lines.push([])
          for (const line of lines) out.push({ segs: [{ text: '  ', style: null }, ...line] })
        }
        out.push({ segs: [] })
        break
      }
      case 'tool': {
        const running = block.status === 'running'
        const statusColor = running ? t.warning : block.status === 'error' ? t.error : t.success
        const label = truncateWidth(toolSummary(block.name, block.args), width - 24)
        // A running tool shows a flowing spinner instead of a static marker.
        out.push({ segs: [
          { text: '  ', style: null },
          ...(running
            ? [{ text: '⠿', style: makeStyle({ fg: statusColor }), anim: 'spinner' }]
            : [{ text: (block.status === 'error' ? '✗' : '✓'), style: makeStyle({ fg: statusColor }) }]),
          { text: ' ', style: null },
          { text: label, style: makeStyle({ fg: t.text }) },
        ] })
        if (running) {
          out.push({ segs: [] })
          break
        }
        if (block.result) {
          const resultLines = renderMarkdown(block.result, t, width - 4)
          for (const line of resultLines.slice(0, 6)) {
            out.push({ segs: [{ text: '    ', style: null },
              ...line.map((s) => ({ ...s, style: makeStyle({ fg: t.textMuted }) }))] })
          }
          if (resultLines.length > 6) {
            out.push({ segs: [{ text: '    … ' + (resultLines.length - 6) + ' more lines', style: makeStyle({ fg: t.textMuted, dim: true }) }] })
          }
        }
        out.push({ segs: [] })
        break
      }
      case 'todo': {
        out.push({ segs: [{ text: '  tasks', style: makeStyle({ fg: t.info, bold: true }) }] })
        for (const item of block.todos ?? []) {
          const mark = item.status === 'completed' ? '☑' : item.status === 'in_progress' ? '◐' : '□'
          const color = item.status === 'completed' ? t.success : item.status === 'in_progress' ? t.warning : t.textMuted
          out.push({ segs: [{ text: '  ' + mark + ' ', style: makeStyle({ fg: color }) },
            { text: item.content, style: makeStyle({ fg: t.text }) }] })
        }
        out.push({ segs: [] })
        break
      }
      case 'note': {
        // Context notes (system-reminder / compaction) reuse the thinking-box
        // treatment: full-width emphasized background, collapsed by default,
        // whole box clickable to toggle — each label gets its own palette.
        const palette = block.label === 'compaction'
          ? { fg: t.compaction, bg: t.compactionBg }
          : { fg: t.reminder, bg: t.reminderBg }
        const collapsed = block.collapsed === true
        const hint = collapsed ? ' · click to expand' : ' · click to collapse'
        const headerSegs = [
          { text: '  ', style: makeStyle({ fg: palette.fg, bg: palette.bg }) },
          { text: collapsed ? '▸' : '▾', style: makeStyle({ fg: palette.fg, bg: palette.bg, bold: true }) },
          { text: ' ' + block.label + hint, style: makeStyle({ fg: palette.fg, bg: palette.bg, bold: true }) },
        ]
        out.push({ segs: boxPad(headerSegs, width, palette.bg), note: { block } })
        if (!collapsed) {
          for (const line of renderMarkdown(block.text, t, width - 4)) {
            const segs = boxPad([
              { text: '  ', style: makeStyle({ fg: palette.fg, bg: palette.bg }) },
              ...line.map((s) => ({ ...s, style: mergeStyle(s.style, { fg: palette.fg, bg: palette.bg }) })),
            ], width, palette.bg)
            out.push({ segs, note: { block } })
          }
        }
        out.push({ segs: [] })
        break
      }
      case 'system': {
        const color = block.level === 'error' ? t.error : block.level === 'warn' ? t.warning : t.textMuted
        for (const line of renderMarkdown(block.text, t, width - 2)) {
          out.push({ segs: [{ text: '  ', style: null }, ...line.map((s) => ({ ...s, style: makeStyle({ fg: color, italic: true }) }))] })
        }
        out.push({ segs: [] })
        break
      }
      default:
        break
    }
    return out
  }

  // Return the cached rendered lines for a block, re-rendering only when its
  // content (rev) changed. The live streaming block is re-rendered at a
  // throttled rate: re-parsing its whole markdown on every paint is the main
  // cost that grows with output, so short frames reuse the previous render.
  _ensureBlockLines(block, width) {
    const key = block.rev + ':' + width
    const cached = this._blockLineCache.get(block)
    if (cached && cached.key === key) return cached.lines
    if (block.streaming && cached && Date.now() - this._streamingRenderAt < 120) {
      return cached.lines
    }
    const rendered = this._blockLines(block, width)
    if (block.streaming) this._streamingRenderAt = Date.now()
    this._blockLineCache.set(block, { key, lines: rendered })
    return rendered
  }

  // Total rendered line count for the transcript at a given width.
  _transcriptTotal(width) {
    let total = 0
    for (const block of this.blocks) total += this._ensureBlockLines(block, width).length
    return total
  }

  // ---- paint -----------------------------------------------------------

  render() {
    const { cols, rows, headerH, inputRowsVisible, suggestions, transcriptTop, transcriptBottom, transcriptH, sidebarW, visual } = this._layout()
    this.hitRegions = []
    const screen = new Screen(cols, rows)
    const t = THEME
    screen.clear(makeStyle({ bg: t.background }))

    // Header: brand + session name live in the top bar; model at the right.
    const headerStyle = makeStyle({ fg: t.textMuted, bg: t.backgroundPanel })
    screen.fill(0, 0, cols, ' ', headerStyle)
    const modelInfo = this.model ? this.model : '…'
    const modelX = cols - displayWidth(modelInfo) - 2
    let hx = 2
    hx = screen.text(hx, 0, '◈ ', makeStyle({ fg: t.primary, bold: true, bg: t.backgroundPanel }))
    hx = gradientText(screen, hx, 0, 'DeepSeek Harness TUI', t.primary, '#dce6ff', { bold: true, bg: t.backgroundPanel })
    if (this.title && this.title !== 'DeepSeek Harness') {
      hx = screen.text(hx, 0, '  ·  ', makeStyle({ fg: t.textMuted, bg: t.backgroundPanel }))
      hx = screen.text(hx, 0, truncateWidth(this.title, Math.max(1, modelX - hx - 1)), makeStyle({ fg: t.text, bold: true, bg: t.backgroundPanel }))
    }
    if (modelX > hx) {
      screen.text(modelX, 0, modelInfo, makeStyle({ fg: t.accent, bg: t.backgroundPanel }))
      screen.fill(hx, 0, modelX - hx, ' ', headerStyle)
      screen.fillToEnd(modelX + displayWidth(modelInfo), 0, headerStyle)
    } else {
      screen.fillToEnd(hx, 0, headerStyle)
    }
    if (headerH > 1) {
      screen.fill(0, 1, cols, ' ', makeStyle({ bg: t.background }))
    }

    // Sidebar
    let transcriptX = 0
    if (sidebarW > 0) {
      transcriptX = sidebarW + 1
      const sideStyle = makeStyle({ fg: t.textMuted, bg: t.backgroundPanel })
      for (let y = headerH; y < transcriptBottom; y++) screen.fill(0, y, sidebarW, ' ', sideStyle)
      screen.text(2, headerH, 'SESSIONS', makeStyle({ fg: t.textMuted, bold: true, bg: t.backgroundPanel }))
      const newSessionStyle = makeStyle({ fg: t.primary, bold: true, bg: t.backgroundPanel })
      screen.text(1, headerH + 1, '＋ New session', newSessionStyle)
      this.addHitRegion('new-session', 0, headerH + 1, sidebarW)
      let sy = headerH + 3
      const active = this.sessionId
      for (const agent of this.sidebarAgents) {
        if (sy >= transcriptTop + transcriptH - 1) break
        const selected = agent.id === active
        const st = selected
          ? makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement })
          : sideStyle
        if (selected) screen.fill(0, sy, sidebarW, ' ', st)
        screen.text(1, sy, (selected ? '▸ ' : '  ') + truncateWidth(agent.label, sidebarW - 4), st)
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
          const selected = s.id === active || i === this.sidebarSelection
          const st = selected
            ? makeStyle({ fg: s.id === active ? t.primary : t.text, bold: true, bg: t.backgroundElement })
            : sideStyle
          if (selected) screen.fill(0, sy, sidebarW, ' ', st)
          screen.text(1, sy, (selected ? '▸ ' : '  ') + truncateWidth(s.label, sidebarW - 4), st)
          this.addHitRegion('session', 0, sy, sidebarW, 1, { sessionIndex: i, sessionId: s.id })
          sy++
        }
      }
      // vertical border
      for (let y = 1; y < transcriptBottom; y++) screen.set(sidebarW, y, '│', makeStyle({ fg: t.borderSubtle }))
    }

    // Transcript. Only the visible window is materialised (never the whole
    // history), so render cost stays bounded no matter how long the session is.
    const transWidth = cols - transcriptX
    this.addHitRegion('transcript', transcriptX, transcriptTop, transWidth, transcriptH)
    const total = this._transcriptTotal(transWidth)
    const maxScroll = Math.max(0, total - transcriptH)
    let offset = maxScroll - this.scroll
    if (this.scroll === 0) offset = maxScroll
    offset = Math.max(0, Math.min(offset, maxScroll))
    const endIndex = Math.min(total, offset + transcriptH)
    let cursor = 0
    let row = 0
    for (const block of this.blocks) {
      const lines = this._ensureBlockLines(block, transWidth)
      const blockEnd = cursor + lines.length
      if (blockEnd > offset && cursor < endIndex) {
        const from = Math.max(0, offset - cursor)
        const to = Math.min(lines.length, endIndex - cursor)
        for (let i = from; i < to; i++) {
          const y = transcriptTop + row
          const line = lines[i]
          let x = transcriptX
          for (const seg of line.segs) {
            // Animated placeholders (spinners) are resolved at draw time so
            // the cached lines stay static between animation frames.
            x = screen.text(x, y, seg.anim ? this.animChar() : seg.text, seg.style)
          }
          screen.fillToEnd(x, y, makeStyle({ fg: t.text }))
          // The whole thinking box is a click target that toggles expand/collapse.
          if (line.thinking) {
            this.addHitRegion('thinking', transcriptX, y, transWidth, 1, { thinkingBlock: line.thinking.block })
          }
          // Context notes (system-reminder / compaction) toggle the same way.
          if (line.note) {
            this.addHitRegion('note', transcriptX, y, transWidth, 1, { noteBlock: line.note.block })
          }
          row++
        }
      }
      cursor = blockEnd
      if (cursor >= endIndex) break
    }
    for (; row < transcriptH; row++) {
      const y = transcriptTop + row
      screen.fill(transcriptX, y, cols - transcriptX, ' ', makeStyle({ bg: t.background }))
    }

    if (this.titleScreen && this.blocks.length === 0) {
      const centerX = transcriptX + Math.floor(transWidth / 2)
      const desiredY = transcriptTop + Math.max(2, Math.floor(transcriptH / 2) - 3)
      const centerY = Math.max(transcriptTop, Math.min(desiredY, transcriptBottom - 6))
      const brand = 'DeepSeek Harness'
      // Blue → white gradient title.
      gradientText(screen, centerX - Math.floor(displayWidth(brand) / 2), centerY, brand,
        t.primary, '#ffffff', { bold: true, bg: t.background })
      const cwd = truncateWidth(this.workingDirectory, Math.max(12, transWidth - 8))
      screen.text(centerX - Math.floor(displayWidth(cwd) / 2), centerY + 2, cwd, makeStyle({ fg: t.text, bg: t.background }))
      if (this.gitBranch) {
        const branch = 'git: ' + this.gitBranch
        screen.text(centerX - Math.floor(displayWidth(branch) / 2), centerY + 3, branch, makeStyle({ fg: t.success, bg: t.background }))
      }
      const hint = 'Ctrl+P  Settings · Ctrl+E  effort'
      screen.text(centerX - Math.floor(displayWidth(hint) / 2), centerY + 5, hint, makeStyle({ fg: t.textMuted, bg: t.background }))
    }

    // Composer
    const composerX = sidebarW > 0 ? sidebarW + 2 : 1
    const composerW = cols - composerX - 1
    let composerTop = transcriptBottom
    if (suggestions > 0) {
      const matches = COMMAND_HINTS.filter(([command]) => command.startsWith(this.inputText)).slice(0, suggestions)
      for (const [command, description] of matches) {
        screen.fill(composerX, composerTop, composerW, ' ', makeStyle({ bg: t.backgroundElement }))
        screen.text(composerX + 2, composerTop, command, makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement }))
        screen.text(composerX + 18, composerTop, description, makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
        composerTop++
      }
    }
    const borderStyle = makeStyle({ fg: this.status === 'running' ? t.warning : t.border })
    screen.text(composerX, composerTop, '╭' + '─'.repeat(Math.max(0, composerW - 2)) + '╮', borderStyle)
    this._paintEffortLabel(screen, composerX, composerTop, composerW)
    const firstVisual = Math.max(0, visual.cursorRow - inputRowsVisible + 1)
    for (let i = 0; i < inputRowsVisible; i++) {
      const y = composerTop + 1 + i
      const visualIndex = firstVisual + i
      screen.fill(composerX, y, composerW, ' ', makeStyle({ bg: t.backgroundPanel }))
      screen.text(composerX, y, '│', borderStyle)
      screen.text(composerX + composerW - 1, y, '│', borderStyle)
      if (this.pendingApproval) {
        if (i === 0) screen.text(composerX + 2, y, 'Approval · ' + this.pendingApproval.toolName + ' · y allow / n deny', makeStyle({ fg: t.warning, bold: true, bg: t.backgroundPanel }))
        continue
      }
      const line = visual.rows[visualIndex] ?? ''
      screen.text(composerX + 2, y, line, makeStyle({ fg: t.text, bg: t.backgroundPanel }))
      if (visualIndex === visual.cursorRow) {
        const cursorX = composerX + 2 + visual.cursorCol
        const current = Array.from(this.inputText.slice(this.inputCursor))[0] ?? ' '
        screen.text(cursorX, y, current === '\n' ? ' ' : current, makeStyle({ fg: t.background, bg: t.primary }))
      }
    }
    const bottom = composerTop + inputRowsVisible + 1
    this.addHitRegion('composer', composerX, composerTop, composerW, inputRowsVisible + 2, { composerTop, firstVisual })
    screen.text(composerX, bottom, '╰' + '─'.repeat(Math.max(0, composerW - 2)) + '╯', borderStyle)
    const mode = this.status === 'running' ? 'interrupt: ctrl+c' : (this.provider ? this.provider + ' · ' : '') + (this.model || 'model')
    screen.text(composerX + 2, bottom, ' ' + truncateWidth(mode, Math.max(0, composerW - 6)) + ' ', makeStyle({ fg: this.status === 'running' ? t.warning : t.textMuted, bg: t.background }))

    // Reasoning-effort slider: one row between the composer and the status
    // row, driven by the current model's real selectable levels.
    if (this.effortSliderVisible) this._paintEffortSlider(screen, cols, rows)

    // Status row
    const statusRow = rows - 1
    const statusStyle = makeStyle({ fg: t.textMuted, bg: t.background })
    screen.fill(0, statusRow, cols, ' ', statusStyle)
    let leftX = 3
    if (this.status === 'running' && this.hasAnimation()) {
      // Flowing wave indicator while the agent is working (read/write/tools/
      // thinking): consecutive spinner frames render side by side so the
      // pattern visibly flows left to right.
      const phase = Math.floor(Date.now() / 70) % SPINNER.length
      const flow = SPINNER[phase] + SPINNER[(phase + 1) % SPINNER.length] + SPINNER[(phase + 2) % SPINNER.length]
      screen.text(1, statusRow, flow, makeStyle({ fg: t.primary, bg: t.background }))
      leftX = 4
    } else {
      const statusDot = this.status === 'running' ? '▮' : '·'
      const dotColor = this.status === 'running' ? t.success : t.textMuted
      screen.text(1, statusRow, statusDot, makeStyle({ fg: dotColor, bg: t.background }))
    }
    const tokText = this.usage.input > 0
      ? '↑' + this.usage.input + ' ↓' + this.usage.output
      : roughTokens(this.inputText) + ' draft tok'
    const modelName = this.model || 'model'
    const leftBase = ' ' + modelName
    const leftWithTokens = leftBase + ' · ' + tokText
    const readings = []
    if (this.metrics.ttftAverageMs !== undefined) readings.push('TTFT avg ' + formatDuration(this.metrics.ttftAverageMs))
    if (this.metrics.tokensPerSecond !== undefined) readings.push(formatMetric(this.metrics.tokensPerSecond) + ' tok/s')
    if (this.metrics.cacheHitRate !== undefined) readings.push('cache ' + this.metrics.cacheHitRate + '%')
    const right = readings.join(' · ')
    const metricRight = cols - 2
    const metricLeft = 3 + Math.floor(cols * 0.42)
    let metricsWidth = 0
    if (right && metricRight > metricLeft) {
      const clipped = truncateWidth(right, metricRight - metricLeft)
      metricsWidth = displayWidth(clipped)
      screen.text(Math.max(metricLeft, metricRight - metricsWidth), statusRow, clipped, makeStyle({ fg: t.secondary, bg: t.background }))
    }
    // The context meter has priority over the model/token cluster and the
    // metrics: it sits just left of the metrics (or the row's right edge), and
    // the left cluster is sized to whatever space remains — the model name
    // survives before the token counts do when the row is crowded.
    const meterGeom = this._contextMeterGeometry(statusRow, leftX + 1,
      metricsWidth > 0 ? metricRight - metricsWidth - 1 : metricRight)
    const leftBudget = meterGeom
      ? Math.max(0, meterGeom.x0 - leftX - 1)
      : Math.max(0, Math.floor(cols * 0.42))
    const leftClipped = displayWidth(leftWithTokens) <= leftBudget
      ? leftWithTokens
      : displayWidth(leftBase) <= leftBudget
        ? leftBase
        : truncateWidth(leftBase, leftBudget)
    screen.text(leftX, statusRow, leftClipped, statusStyle)
    if (meterGeom) this._paintContextMeter(screen, statusRow, meterGeom)

    // Toast: bottom-center, on the same status row as the model/metrics
    // readings; it auto-dismisses after 2 seconds.
    if (this.toast) {
      const st = makeStyle({ fg: this.toast.level === 'error' ? t.error : t.info, bg: t.backgroundElement })
      const toastText = ' ' + this.toast.text + ' '
      const toastX = Math.max(0, Math.floor((cols - displayWidth(toastText)) / 2))
      screen.fill(toastX, statusRow, displayWidth(toastText), ' ', st)
      screen.text(toastX, statusRow, toastText, st)
    }

    // Overlays
    if (this.overlay === 'help') this._paintHelp(screen, cols, rows)
    if (this.overlay === 'settings') this._paintSettings(screen, cols, rows)
    if (this.contextMeterOpen && !this.overlay) this._paintContextPanel(screen, cols, rows)

    // Remember the input caret's screen position so term.paint can park the
    // (hidden) terminal cursor there — the OS IME composition window then
    // anchors inside the composer instead of at the bottom-left corner.
    screen.cursorX = composerX + 2 + visual.cursorCol
    screen.cursorY = composerTop + 1 + (visual.cursorRow - firstVisual)

    return screen
  }

  _paintEffortSlider(screen, cols, rows) {
    const t = THEME
    const slider = this.effortSlider
    if (!slider || slider.levels.length === 0) return
    const y = rows - 2
    const bg = t.background
    screen.fill(0, y, cols, ' ', makeStyle({ bg }))
    const levels = slider.levels
    const index = Math.min(this._effortIndex(), levels.length - 1)
    const atMax = this._effortAtMax()
    const label = 'effort'
    const labelX = 2
    screen.text(labelX, y, label, makeStyle({ fg: t.textMuted, bold: true, bg }))
    const left = labelX + displayWidth(label) + 2
    const trackWidth = Math.max(10, Math.min(26, cols - left - 48))
    const fill = levels.length <= 1 ? 1 : Math.max(1, Math.round((index / (levels.length - 1)) * trackWidth))
    const phase = Math.floor(Date.now() / 60)
    const head = atMax ? phase % fill : -1
    for (let i = 0; i < trackWidth; i++) {
      if (i < fill) {
        // Filled segment: flat primary, or at max a gradient that flows
        // left -> right (wave index shrinks with position: (phase - i)), with
        // a bright comet head sweeping across the fill and a short trail.
        let color = t.primary
        if (atMax) {
          const wave = ((phase - i) % (fill + 1) + (fill + 1)) % (fill + 1) / Math.max(1, fill)
          const base = mixColor(t.primary, t.accent, wave)
          const dist = Math.abs(head - i)
          color = dist === 0 ? mixColor(base, '#ffffff', 0.85)
            : dist === 1 ? mixColor(base, '#ffffff', 0.45)
              : dist === 2 ? mixColor(base, '#ffffff', 0.2)
                : base
        }
        screen.text(left + i, y, '█', makeStyle({ fg: color, bg }))
      } else {
        // Empty segment: at max the cells shimmer, moving rightward too.
        const ch = atMax && ((phase - i) % 2 + 2) % 2 === 0 ? '▒' : '░'
        screen.text(left + i, y, ch, makeStyle({ fg: t.border, bg }))
      }
    }
    // Text-safe slider thumb on the right edge of the fill.
    screen.text(left + Math.min(fill, trackWidth) - 1, y, '▮', makeStyle({ fg: atMax ? '#ffffff' : t.secondary, bold: true, bg }))
    // Keep the current effort value in its original slider-row position as
    // well as in the composer's top-right corner.
    const current = levels[index] ?? levels[0]
    const name = truncateWidth(String(current?.name ?? current?.id ?? '—'), 18)
    let x = left + trackWidth + 2
    screen.text(x, y, name, makeStyle({ fg: atMax ? t.warning : t.secondary, bold: true, bg }))
    x += displayWidth(name)
    // The real range the provider exposed, so a boolean-thinking model shows
    // exactly its two ends rather than a fake none..max scale.
    if (levels.length > 1) {
      const range = ' · ' + String(levels[0]?.name ?? levels[0]?.id) + ' → ' + String(levels[levels.length - 1]?.name ?? levels[levels.length - 1]?.id)
      const clipped = truncateWidth(range, Math.max(4, cols - x - 22))
      if (displayWidth(clipped) > 4) {
        screen.text(x, y, clipped, makeStyle({ fg: t.textMuted, bg }))
        x += displayWidth(clipped)
      }
    }
    const hint = '←/→ adjust · Esc close'
    const hintX = cols - displayWidth(hint) - 1
    if (hintX > x + 2) screen.text(hintX, y, hint, makeStyle({ fg: t.textMuted, dim: true, bg }))
  }

  // The current effort value, pinned to the top-right corner of the composer
  // box — diagonally opposite the `provider · model` label at bottom-left.
  // `↑ max` gets a blinking text arrow and per-letter flowing gradient; any
  // other level is a static bold label.
  _paintEffortLabel(screen, composerX, composerTop, composerW) {
    const t = THEME
    const level = this._effortLevel()
    if (!level || composerW < 16) return
    const atMax = this._effortAtMax()
    const name = truncateWidth(String(level.name ?? level.id), Math.max(4, composerW - 16))
    const bg = t.background
    if (atMax) {
      const text = '↑ ' + name
      const x = composerX + composerW - displayWidth(text) - 2
      const phase = Math.floor(Date.now() / 60)
      const blink = Math.floor(Date.now() / 130) % 2 === 0 ? t.warning : mixColor(t.warning, '#ffffff', 0.75)
      screen.text(x, composerTop, '↑', makeStyle({ fg: blink, bold: true, bg }))
      let cx = x + 2
      let glyphIndex = 0
      for (const ch of Array.from(name)) {
        const wave = (((phase - glyphIndex * 3) % 10) + 10) % 10 / 10
        screen.text(cx, composerTop, ch, makeStyle({ fg: mixColor(t.primary, t.accent, wave), bold: true, bg }))
        cx += displayWidth(ch)
        glyphIndex++
      }
    } else {
      const text = 'effort ' + name
      const x = composerX + composerW - displayWidth(text) - 2
      screen.text(x, composerTop, text, makeStyle({ fg: t.secondary, bold: true, bg }))
    }
  }

  // Port of the web composer's ContextMeter ring: an always-visible occupancy
  // bar in the status row (`ctx ▓▓░░ 32K/128K 25%`) fed by the token-meter
  // `contextPressure` projection. The whole meter is a click target that
  // toggles the breakdown panel (`_paintContextPanel`). Renders nothing until
  // both a numerator and a capacity are known; the fill shifts toward the
  // warning/error palette as occupancy climbs.
  _contextMeterGeometry(y, leftFloor, rightLimit) {
    const meter = this.contextMeter
    if (!meter) return null
    const used = formatTokens(meter.usedTokens)
    const cap = formatTokens(meter.contextWindow)
    const pct = meter.percent
    const available = rightLimit - leftFloor
    if (available < 6) return null
    const barW = Math.max(3, Math.min(12, Math.floor(available * 0.4)))
    const text = ' ' + used + '/' + cap + ' ' + pct + '%'
    const total = displayWidth('ctx') + 1 + barW + displayWidth(text)
    const x0 = rightLimit - total
    if (x0 < leftFloor) return null
    return {
      x0, y, total, barW, used, cap, pct,
      fillColor: pct >= 100 ? THEME.error : pct >= 90 ? THEME.warning : THEME.primary,
    }
  }

  _paintContextMeter(screen, y, geom) {
    const t = THEME
    let x = geom.x0
    x = screen.text(x, y, 'ctx', makeStyle({ fg: t.textMuted, bold: true, bg: t.background }))
    x += 1
    const fillW = Math.min(geom.barW, Math.max(0, Math.round(geom.pct / 100 * geom.barW)))
    for (let i = 0; i < geom.barW; i++) {
      if (i < fillW) {
        screen.text(x + i, y, '█', makeStyle({ fg: mixColor(geom.fillColor, t.accent, Math.min(1, i / Math.max(1, geom.barW - 1))), bg: t.background }))
      } else {
        screen.text(x + i, y, '░', makeStyle({ fg: t.borderSubtle, bg: t.background }))
      }
    }
    x += geom.barW
    screen.text(x, y, ' ' + geom.used + '/' + geom.cap + ' ' + geom.pct + '%',
      makeStyle({ fg: geom.pct >= 90 ? geom.fillColor : t.textMuted, bg: t.background }))
    this.addHitRegion('context-meter', geom.x0, y, geom.total, 1)
  }

  // Click-open breakdown panel, ported from the web ContextMeter dialog:
  // headline occupancy, the current/limit reading, an occupancy bar whose
  // colored parts are proportioned by the heuristic `contextBreakdown`
  // composition (system prompt, tools, messages), and a per-part legend. The
  // bar's overall length stays the provider-exact percent; the breakdown only
  // proportions its colored parts (a zero-width part is dropped).
  _paintContextPanel(screen, cols, rows) {
    const t = THEME
    const meter = this.contextMeter
    if (!meter) return
    const w = Math.min(46, cols - 4)
    const h = meter.breakdown ? 10 : 8
    const x0 = Math.max(0, Math.floor((cols - w) / 2))
    const y0 = Math.max(1, Math.floor((rows - h) / 2) - 2)
    const box = makeStyle({ fg: t.text, bg: t.backgroundElement })
    const border = makeStyle({ fg: t.border })
    screen.fill(x0, y0, w, ' ', box)
    for (let x = 0; x < w; x++) {
      screen.set(x0 + x, y0, '─', border)
      screen.set(x0 + x, y0 + h - 1, '─', border)
    }
    for (let y = 0; y < h; y++) {
      screen.set(x0, y0 + y, '│', border)
      screen.set(x0 + w - 1, y0 + y, '│', border)
    }
    screen.set(x0, y0, '┌', border); screen.set(x0 + w - 1, y0, '┐', border)
    screen.set(x0, y0 + h - 1, '└', border); screen.set(x0 + w - 1, y0 + h - 1, '┘', border)
    screen.text(x0 + 3, y0 + 1, 'context', makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement }))
    screen.text(x0 + w - displayWidth('Esc close') - 3, y0 + 1, 'Esc close', makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
    screen.text(x0 + 3, y0 + 2, 'used ' + meter.percent + '%  ~' + formatTokens(meter.usedTokens) + ' / ' + formatTokens(meter.contextWindow),
      makeStyle({ fg: t.text, bold: true, bg: t.backgroundElement }))
    const barX = x0 + 3
    const barW = w - 8
    const fillTotal = Math.min(barW, Math.max(0, Math.round(meter.percent / 100 * barW)))
    const parts = meter.breakdown
      ? [
          { tokens: meter.breakdown.systemTokens, color: t.contextSystem, label: 'system prompt' },
          { tokens: meter.breakdown.toolsTokens, color: t.contextTools, label: 'tools' },
          { tokens: meter.breakdown.messageTokens, color: t.contextMessages, label: 'messages' },
        ].filter((p) => p.tokens > 0)
      : null
    const partTotal = parts ? parts.reduce((sum, p) => sum + p.tokens, 0) : 0
    if (parts && partTotal > 0 && fillTotal > 0) {
      let cx = barX
      for (const part of parts) {
        const partW = Math.max(1, Math.round(part.tokens / partTotal * fillTotal))
        screen.fill(cx, y0 + 3, Math.min(partW, barX + fillTotal - cx), '█', makeStyle({ fg: part.color, bg: t.backgroundElement }))
        cx += partW
      }
      screen.fill(Math.min(cx, barX + fillTotal), y0 + 3, Math.max(0, barX + barW - Math.min(cx, barX + fillTotal)), '░', makeStyle({ fg: t.borderSubtle, bg: t.backgroundElement }))
    } else {
      screen.fill(barX, y0 + 3, fillTotal, '█', makeStyle({ fg: t.primary, bg: t.backgroundElement }))
      screen.fill(barX + fillTotal, y0 + 3, barW - fillTotal, '░', makeStyle({ fg: t.borderSubtle, bg: t.backgroundElement }))
    }
    if (parts && partTotal > 0) {
      let yy = y0 + 5
      for (const part of parts) {
        screen.text(x0 + 3, yy, '■', makeStyle({ fg: part.color, bg: t.backgroundElement }))
        screen.text(x0 + 6, yy, part.label, makeStyle({ fg: t.text, bg: t.backgroundElement }))
        screen.text(x0 + 26, yy, '~' + formatTokens(part.tokens), makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
        yy++
      }
    } else {
      screen.text(x0 + 3, y0 + 5, 'composition unavailable', makeStyle({ fg: t.textMuted, italic: true, bg: t.backgroundElement }))
    }
  }

  _paintSettings(screen, cols, rows) {
    const t = THEME
    const w = Math.min(68, cols - 4)
    const h = Math.min(rows - 4, Math.max(11, this.settingsItems.length * 2 + 6))
    const x0 = Math.max(0, Math.floor((cols - w) / 2))
    const y0 = Math.max(0, Math.floor((rows - h) / 2))
    const box = makeStyle({ fg: t.text, bg: t.backgroundElement })
    const border = makeStyle({ fg: t.border })
    for (let y = y0; y < y0 + h; y++) screen.fill(x0, y, w, ' ', box)
    for (let x = 0; x < w; x++) {
      screen.set(x0 + x, y0, '─', border)
      screen.set(x0 + x, y0 + h - 1, '─', border)
    }
    for (let y = 0; y < h; y++) {
      screen.set(x0, y0 + y, '│', border)
      screen.set(x0 + w - 1, y0 + y, '│', border)
    }
    screen.set(x0, y0, '┌', border); screen.set(x0 + w - 1, y0, '┐', border)
    screen.set(x0, y0 + h - 1, '└', border); screen.set(x0 + w - 1, y0 + h - 1, '┘', border)
    screen.text(x0 + 3, y0 + 1, truncateWidth(this.settingsTitle, w - 6), makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement }))

    screen.text(x0 + 3, y0 + 2, truncateWidth(this.settingsSubtitle || 'Shared with DeepSeek Harness WebUI', w - 6), makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
    const visibleCount = Math.max(1, Math.floor((h - 6) / 2))
    const first = Math.max(0, Math.min(this.settingsSelection - visibleCount + 1, this.settingsItems.length - visibleCount))
    const items = this.settingsItems.slice(first, first + visibleCount)
    for (let offset = 0; offset < items.length; offset++) {
      const i = first + offset
      const item = items[offset]
      const y = y0 + 4 + offset * 2
      const selected = i === this.settingsSelection
      const style = makeStyle({
        fg: item.disabled ? t.textMuted : selected ? t.text : t.textMuted,
        bg: selected ? t.backgroundPanel : t.backgroundElement,
        bold: selected && !item.disabled,
      })
      if (selected) screen.fill(x0 + 2, y, w - 4, ' ', style)
      this.addHitRegion('settings-item', x0 + 2, y, w - 4, 1, { settingsIndex: i })
      screen.text(x0 + 3, y, selected ? '› ' : '  ', makeStyle({ fg: item.disabled ? t.textMuted : t.primary, bg: style.bg }))
      screen.text(x0 + 6, y, truncateWidth(item.label, 29), style)
      const draft = this.settingsSecret ? '•'.repeat(Array.from(this.settingsDraft).length) : this.settingsDraft
      const confirming = this.settingsConfirm?.item === item
      const confirmHint = confirming && this.settingsConfirm.item.kind === 'session' ? 'Ctrl+D again to delete' : 'Y confirm · N cancel'
      const value = confirming ? confirmHint : this.settingsEditing === i ? draft + '█' : item.value
      screen.text(x0 + 36, y, truncateWidth(value, w - 41), makeStyle({ fg: confirming ? t.warning : selected && !item.disabled ? t.secondary : t.textMuted, bg: style.bg }))
    }
    const footer = this.settingsEditing === null ? '↑/↓ move · Enter open/change · Esc back' : 'Enter save · Esc cancel'
    screen.text(x0 + 3, y0 + h - 2, footer, makeStyle({ fg: this.settingsConfirm ? t.warning : t.textMuted, bg: t.backgroundElement }))
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
      ['Ctrl+Enter', 'insert newline'],
      ['Ctrl+C', 'cancel running turn; press again to quit'],
      ['Ctrl+P', 'open settings'],
      ['Ctrl+E', 'toggle reasoning-effort slider'],
      ['Ctrl+N', 'new session'],
      ['Ctrl+D', 'delete session in Manage sessions (press twice)'],
      ['PgUp / PgDn', 'scroll transcript'],
      ['Up / Down', 'input history'],
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
    for (const cmd of ['/help  /settings  /new  /resume <id>', '/model <id>  /provider <route>  /clear  /cancel  /quit']) {
      screen.text(x0 + 3, yy, cmd, makeStyle({ fg: t.text, bg: t.backgroundElement }))
      yy++
    }
  }
}