// The dsh-tui app plugin: boots a terminal UI inside a dsh profile, drives
// agents through ctx.agents, renders the durable session/event feed, and
// routes human input back via followup/steer.
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { readFile, readdir, rm } from 'node:fs/promises'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { Terminal } from './term.js'
import { App, noteFromContext } from './ui.js'
import { SessionMetrics } from './metrics.js'
import { InterruptState } from './interrupt.js'
import { installWebSettingSchemas, loadProviderSettings, loadWebSettings, saveWebSetting } from './web-settings.js'
import { contentText, formatError, timeString } from './util.js'

async function deleteSessionDirectory(sessionId) {
  const sessionsRoot = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
  const roots = await readdir(sessionsRoot, { withFileTypes: true })
  for (const root of roots) {
    if (!root.isDirectory()) continue
    const rootPath = join(sessionsRoot, root.name)
    const entries = await readdir(rootPath, { withFileTypes: true })
    const match = entries.find((entry) => entry.isDirectory() && entry.name === sessionId)
    if (!match) continue
    await rm(join(rootPath, match.name), { recursive: true, force: false })
    return true
  }
  return false
}

async function gitBranchAt(startPath) {
  let directory = resolve(startPath)
  const root = parse(directory).root
  while (true) {
    const marker = join(directory, '.git')
    try {
      let gitDirectory = marker
      const markerText = await readFile(marker, 'utf8')
      const match = /^gitdir:\s*(.+)$/im.exec(markerText)
      if (match) gitDirectory = isAbsolute(match[1].trim()) ? match[1].trim() : resolve(directory, match[1].trim())
      const head = (await readFile(join(gitDirectory, 'HEAD'), 'utf8')).trim()
      return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : head.slice(0, 12)
    } catch {
      try {
        const head = (await readFile(join(marker, 'HEAD'), 'utf8')).trim()
        return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : head.slice(0, 12)
      } catch { /* continue to parent */ }
    }
    if (directory === root) return ''
    directory = dirname(directory)
  }
}

export const name = 'dsh-tui'

export const inject = ['agents', 'commands', 'sessionPersistence', 'tuiStartup']

export const Config = Schema.object({
  sidebar: Schema.boolean().default(true),
  showReasoning: Schema.boolean().default(true),
  defaultModel: Schema.string(),
  defaultProvider: Schema.string(),
})

export function apply(ctx, config) {
  const startup = ctx.tuiStartup ?? {}
  installWebSettingSchemas(ctx)
  const term = new Terminal()
  if (!term.isTTY()) {
    console.error('dsh-tui: stdin/stdout are not a TTY; run in an interactive terminal (dsh --profile tui)')
    const exit = ctx.get('appExit')
    if (exit) exit(1)
    return
  }
  term.start()
  const app = new App(term)
  // Session history is available from Settings -> Manage sessions.
  app.sidebarVisible = false

  // Live session state.
  let handle = null
  let currentAgent = null
  let openingSession = null
  let openingVersion = 0
  let lifecycleVersion = 0
  let lastUserText = null
  let lastUserTime = 0
  const metrics = new SessionMetrics()
  const interrupt = new InterruptState()
  let showReasoning = config.showReasoning !== false
  const modelPreference = {
    model: startup.model ?? config.defaultModel ?? undefined,
    provider: startup.provider ?? config.defaultProvider ?? undefined,
  }
  // Effective default model/provider. The persisted `agent-default-model`
  // settings (what the Settings panel shows and saves) win over the harness
  // composition entry, which `agentDefaultModel.currentSelection()` may still
  // report before the settings scope has been attached. TUI reads the settings
  // service live so the title bar and new sessions agree with the Settings UI.
  function defaultModelSelection() {
    const settings = ctx.get('settings')
    if (settings) {
      try {
        const descriptor = settings.describe({ redactSecrets: true }).find((entry) => String(entry.ns) === 'agent-default-model')
        const value = descriptor?.value
        if (value && typeof value === 'object') {
          return { provider: value.provider, model: value.model, reasoningEffort: value.reasoningEffort }
        }
      } catch { /* settings unavailable; fall back to composition selection */ }
    }
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    return selection ?? {}
  }
  // The effective reasoning effort for the current model's requests: the
  // slider/settings selection, applied through agent/request. `undefined`
  // keeps the provider's own default behavior.
  let effortPreference = undefined
  let effortLoadVersion = 0

  const paint = () => term.paint(app.render())
  // High-frequency paints (streaming chunks, mouse motion) are coalesced so a
  // busy AI turn never starves the event loop — the wheel and keyboard stay
  // responsive while tokens stream in. Interactive actions paint immediately.
  let paintTimer = null
  const paintSoon = () => {
    if (paintTimer) return
    paintTimer = setTimeout(() => {
      paintTimer = null
      if (term.started) paint()
    }, 40)
  }
  const paintNow = () => {
    if (paintTimer) {
      clearTimeout(paintTimer)
      paintTimer = null
    }
    paint()
  }
  term.on('resize', () => paintNow())
  paint()

  // Drive the activity animations (flowing spinners for thinking / running
  // tools like read/write). Paints are cheap (bounded render), and the loop
  // only repaints while something is actually animating.
  const animationTimer = setInterval(() => {
    if (term.started && app.hasAnimation()) paint()
  }, 80)

  // ---- session lifecycle -------------------------------------------------

  function newSessionId() {
    return 'tui-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  }


  async function showTitleScreen() {
    const version = ++lifecycleVersion
    if (handle) {
      const old = handle
      handle = null
      currentAgent = null
      try { await old.dispose() } catch { /* already settling */ }
    }
    if (version !== lifecycleVersion) return
    const workingDirectory = process.cwd()
    app.overlay = null
    app.inputText = ''
    app.inputCursor = 0
    app.resetView()
    // Show the effective default model/provider on the title page (the same
    // resolution used when a session is opened) instead of a bare placeholder.
    const defaultSelection = defaultModelSelection()
    app.setWelcome({
      workingDirectory,
      model: modelPreference.model ?? defaultSelection?.model ?? '',
      provider: modelPreference.provider ?? defaultSelection?.provider ?? '',
    })
    app.setStatus('idle')
    paint()
    let gitBranch = ''
    try { gitBranch = await gitBranchAt(workingDirectory) } catch (error) {
      app.showToast('git: ' + formatError(error), 'warn')
    }
    if (version === lifecycleVersion && !currentAgent) {
      // Re-resolve the default model/provider after the async gap: the settings
      // scope may not have been attached when the title screen first painted.
      const defaultSelection = defaultModelSelection()
      app.setWelcome({
        workingDirectory,
        gitBranch,
        model: modelPreference.model ?? defaultSelection?.model ?? '',
        provider: modelPreference.provider ?? defaultSelection?.provider ?? '',
      })
      paint()
    }
  }

  async function openSession({ resume = null, announce = true } = {}) {
    const version = ++lifecycleVersion
    app.overlay = null
    // Tear down the previous agent to quiescence.
    if (handle) {
      const old = handle
      handle = null
      currentAgent = null
      try { await old.dispose() } catch { /* already settling */ }
    }
    if (version !== lifecycleVersion) return false
    lastUserText = null
    app.inputText = ''
    app.inputCursor = 0
    app.sidebarSelection = -1
    app.resetView()
    app.setSession({ title: 'New session' })
    // Resolve the model selection: explicit preference (flag/config//model)
    // wins, then the deployment's agent-default-model service (settings).
    const agentOptions = {}
    const defaultSelection = defaultModelSelection()
    if (modelPreference.provider ?? defaultSelection?.provider) {
      agentOptions.provider = modelPreference.provider ?? defaultSelection.provider
    }
    if (modelPreference.model ?? defaultSelection?.model) {
      agentOptions.model = modelPreference.model ?? defaultSelection.model
    }
    try {
      const openedHandle = resume
        ? await ctx.agents.resume({
            resumeSessionId: SessionId(resume),
            agentOptions,
          })
        : await ctx.agents.create({
            sessionId: SessionId(newSessionId()),
            meta: { cwd: process.cwd() },
            agentOptions,
          })
      if (version !== lifecycleVersion) {
        try { await openedHandle.dispose() } catch { /* already settling */ }
        return false
      }
      handle = openedHandle
      currentAgent = openedHandle.agent
      app.setSession({
        id: String(currentAgent.session.id),
        model: currentAgent.options.model ?? '',
        provider: currentAgent.options.provider ?? '',
      })
      void loadEffortSlider()
      replay(currentAgent.session)
      app.addSystem('session ' + currentAgent.session.id + (resume ? ' resumed' : ' started') + ' · ' + process.cwd(), 'info')
      app.setStatus('idle')
      void refreshRecentSessions()
      paint()
      return true
    } catch (error) {
      if (version !== lifecycleVersion) return false
      handle = null
      currentAgent = null
      app.addSystem('failed to open session: ' + formatError(error), 'error')
      app.setStatus('idle')
      paint()
      return false
    }
  }

  // A user/message the human never typed: labeled context (system-reminder /
  // compaction) becomes a collapsible note box; anything else stays a dim
  // system line.
  function addContextMessage(src, text) {
    const note = noteFromContext(src, text)
    if (note) app.addNote(note.text, note.label)
    else app.addSystem('[' + (src?.kind ?? 'context') + '] ' + text, 'dim')
  }

  // Build the transcript from a session's durable log (resume/replay path).
  function replay(session) {
    metrics.reset()
    for (const event of session.events) {
      metrics.consume(event)
      switch (event.type) {
        case 'user/message': {
          const src = event.data.source
          const text = contentText(event.data.content)
          if (src?.kind === 'user') app.addUser(text)
          else addContextMessage(src, text)
          break
        }
        case 'assistant/message': {
          const msg = event.data.message
          // Reasoning lives in its own box; never mix it into the visible text.
          const text = contentText(msg.content, { skipReasoning: true })
          const reasoning = msg.content
            .filter((b) => b.type === 'reasoning')
            .map((b) => b.text)
            .join('')
          const asst = app.ensureAssistantBlock(event.time)
          asst.text = text
          if (reasoning) asst.reasoning = showReasoning ? reasoning : ''
          // Otherwise keep whatever reasoning streamed into this block already.
          asst.streaming = false
          asst.time = event.time
          asst.rev = (asst.rev ?? 0) + 1
          if (asst.reasoning && asst.thinkingCollapsed === undefined) asst.thinkingCollapsed = true
          for (const block of msg.content) {
            if (block.type === 'tool-call') {
              app.startTool({ callId: block.id, name: block.name, args: block.arguments })
            }
          }
          break
        }
        case 'tool/result': {
          const msg = event.data.message
          const text = contentText(msg.content)
          const isError = event.data.error !== undefined
            || msg.content[0]?.isError === true
          app.updateTool(msg.source.callId, { status: isError ? 'error' : 'ok', result: text })
          break
        }
        case 'todo/write': {
          app.setTodo(event.data.todos)
          break
        }
        default:
          break
      }
    }
    app.setMetrics(metrics.snapshot())
    const titleEvent = [...session.events].reverse().find((e) => e.type === 'session/title')
    if (titleEvent) app.setSession({ title: titleEvent.data.title })
  }

  // ---- durable event stream ----------------------------------------------

  ctx.on('session/event', (session, event) => {
    if (event.type === 'session/title' || event.type === 'user/message') {
      void Promise.resolve().then(() => refreshRecentSessions())
    }
    if (!currentAgent || session.id !== currentAgent.session.id) return
    metrics.consume(event)
    app.setMetrics(metrics.snapshot())
    handleSessionEvent(event)
    paintSoon()
  }, { global: true })

  ctx.on('session/created', () => {
    void Promise.resolve().then(() => refreshRecentSessions())
  }, { global: true })

  function handleSessionEvent(event) {
    switch (event.type) {
      case 'user/message': {
        const src = event.data.source
        const text = contentText(event.data.content)
        if (src?.kind === 'user') {
          const now = Date.now()
          if (text === lastUserText && now - lastUserTime < 8000) return
          app.addUser(text)
        } else {
          addContextMessage(src, text)
        }
        break
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') app.streamChunk(chunk)
        else if (chunk.type === 'reasoning-delta' && showReasoning) {
          app.streamChunk(chunk)
        }
        break
      }
      case 'assistant/message': {
        const msg = event.data.message
        // Reasoning lives in its own box; never mix it into the visible text.
        const text = contentText(msg.content, { skipReasoning: true })
        const reasoning = msg.content
          .filter((b) => b.type === 'reasoning')
          .map((b) => b.text)
          .join('')
        const asst = app.ensureAssistantBlock(event.time)
        asst.text = text
        if (reasoning) asst.reasoning = showReasoning ? reasoning : ''
        // Otherwise keep whatever reasoning streamed into this block already.
        asst.streaming = false
        asst.time = event.time
        asst.rev = (asst.rev ?? 0) + 1
        if (asst.reasoning && asst.thinkingCollapsed === undefined) asst.thinkingCollapsed = true
        for (const block of msg.content) {
          if (block.type === 'tool-call') {
            app.startTool({ callId: block.id, name: block.name, args: block.arguments })
          }
        }
        break
      }
      case 'tool/call': {
        const d = event.data
        const existing = app.updateTool(d.callId, { name: d.name, args: d.arguments })
        if (!existing) app.startTool({ callId: d.callId, name: d.name, args: d.arguments })
        break
      }
      case 'tool/result': {
        const msg = event.data.message
        const text = contentText(msg.content)
        const isError = event.data.error !== undefined || msg.content[0]?.isError === true
        app.updateTool(msg.source.callId, { status: isError ? 'error' : 'ok', result: text })
        break
      }
      case 'todo/write': {
        app.setTodo(event.data.todos)
        break
      }
      case 'session/title': {
        app.setSession({ title: event.data.title })
        break
      }
      case 'turn/end': {
        app.setStatus('idle')
        break
      }
      default:
        break
    }
  }

  // ---- agent lifecycle / sidebar -----------------------------------------

  ctx.on('agent/status', ({ agent, status }) => {
    if (!currentAgent || agent.id !== currentAgent.id) return
    app.setStatus(status)
    paint()
  })
  ctx.on('agent/error', ({ agent, error }) => {
    if (!currentAgent || agent.id !== currentAgent.id) return
    app.addSystem('error: ' + formatError(error), 'error')
    app.setStatus('idle')
    paint()
  })

  async function refreshRecentSessions() {
    const sq = ctx.get('sessionQuery')
    if (!sq) return
    try {
      const records = await sq.listSessions()
      const top = records.filter((r) => r.header.origin !== 'subagent').slice(0, 25)
      const results = await sq.readTitleSnapshots(top.map((r) => r.header.id))
      const rows = top.map((r, i) => {
        const res = results[i]
        const title = res?.status === 'fulfilled' && res.value.title
          ? res.value.title.title
          : String(r.header.id)
        return { id: String(r.header.id), label: title, time: r.header.createdAt }
      })
      rows.sort((a, b) => b.time - a.time)
      app.sidebarSessions = rows
      paint()
    } catch {
      // Session listing is best-effort; leave the sidebar as-is.
    }
  }

  // ---- model override via agent/request ----------------------------------

  // Load the current model's real reasoning levels into the slider. Levels
  // come from the adapter (resolveModelInfo), so a boolean-thinking model
  // shows exactly its two ends, a full-range one shows every advertised level,
  // and a partial one shows only what the provider exposes — never a blanket
  // none..max mapping.
  async function loadEffortSlider() {
    const version = ++effortLoadVersion
    const clear = () => {
      if (version !== effortLoadVersion) return
      effortPreference = undefined
      app.setEffortSlider(null)
    }
    const llm = ctx.get('llm')
    const defaultSelection = defaultModelSelection()
    const provider = modelPreference.provider ?? defaultSelection?.provider ?? app.provider
    const model = modelPreference.model ?? defaultSelection?.model ?? app.model
    if (!provider || !model || !llm?.resolveModelInfo) {
      clear()
      return
    }
    try {
      const info = await llm.resolveModelInfo(provider, model)
      if (version !== effortLoadVersion) return
      const reasoning = info.reasoning
      if (!reasoning || !Array.isArray(reasoning.efforts) || reasoning.efforts.length === 0) {
        clear()
        return
      }
      const levels = reasoning.efforts.map((effort) => ({ id: String(effort.id), name: effort.name ?? String(effort.id) }))
      const configuredEffort = defaultSelection?.reasoningEffort === undefined ? undefined : String(defaultSelection.reasoningEffort)
      // A stored value can belong to the model selected before this one. Only
      // apply it when the current adapter explicitly advertises that id.
      const settingsEffort = levels.some((level) => level.id === configuredEffort) ? configuredEffort : undefined
      effortPreference = settingsEffort
      app.setEffortSlider({
        levels,
        current: settingsEffort ?? (reasoning.defaultEffort === undefined ? undefined : String(reasoning.defaultEffort)),
      })
    } catch {
      clear()
    }
  }

  function toggleEffortSlider() {
    if (app.effortSliderVisible) {
      app.effortSliderVisible = false
      paint()
      return
    }
    void loadEffortSlider().then(() => {
      if (!app.effortSlider) {
        app.showToast('current model exposes no reasoning levels', 'warn')
        paint()
        return
      }
      app.effortSliderVisible = true
      paint()
    })
  }

  function moveEffort(delta) {
    const slider = app.effortSlider
    if (!slider || slider.levels.length === 0) return
    const index = Math.max(0, slider.levels.findIndex((level) => level.id === slider.current))
    const next = slider.levels[Math.min(Math.max(0, index + delta), slider.levels.length - 1)]
    if (!next || next.id === slider.current) return
    slider.current = next.id
    effortPreference = next.id
    paint()
    void commitEffort(next.id)
  }

  async function commitEffort(id) {
    const settings = ctx.get('settings')
    if (!settings) {
      app.showToast('settings unavailable', 'warn')
      paint()
      return
    }
    try {
      await settings.update('agent-default-model', { reasoningEffort: id })
      app.showToast('reasoning effort: ' + id, 'info')
    } catch (error) {
      app.showToast('settings: ' + formatError(error), 'error')
      await loadEffortSlider()
    }
    paint()
  }

  ctx.on('agent/request', async ({ agent }, next) => {
    const config = await next()
    if (!currentAgent || agent.id !== currentAgent.id) return config
    const overrides = {}
    if (modelPreference.provider) overrides.provider = modelPreference.provider
    if (modelPreference.model) overrides.model = modelPreference.model
    if (effortPreference) overrides.reasoningEffort = effortPreference
    if (Object.keys(overrides).length === 0) return config
    return { ...config, ...overrides }
  })

  // ---- approval -----------------------------------------------------------

  ctx.on('approval/request', (req, next) => {
    if (!currentAgent || req.agent.id !== currentAgent.id) return next()
    if (autoApprovalEnabled(req)) return 'allowed-once'
    return askApproval(req)
  })

  // Keep this live: settings can be changed while the TUI is running.
  function autoApprovalEnabled(req) {
    const settings = ctx.get('settings')
    const descriptor = settings?.describe?.({ redactSecrets: true })?.find((entry) => String(entry.ns) === 'permission')
    const permission = descriptor?.value ?? settings?.get?.('permission')
    const preset = permission?.defaultPreset ?? permission?.preset
    const mode = permission?.approvalMode ?? permission?.autoApproval ?? permission?.approval
    const autoField = permission && Object.entries(permission).some(([key, value]) =>
      /auto|approval/i.test(key) && (value === true || value === 'auto' || value === 'always' || value === 'enabled'))
    return preset === 'danger-full-access'
      || preset === 'auto'
      || preset === 'always'
      || mode === 'auto'
      || mode === 'always'
      || mode === 'enabled'
      || mode === true
      || autoField
      || req?.autoApprove === true
      || req?.approvalMode === 'auto'
  }

  function askApproval(req) {
    return new Promise((resolve) => {
      let settled = false
      const settle = (outcome) => {
        if (settled) return
        settled = true
        if (req.signal) req.signal.removeEventListener('abort', onAbort)
        if (app.pendingApproval?.id === state.id) app.pendingApproval = null
        resolve(outcome)
      }
      const onAbort = () => settle('cancelled')
      const state = {
        id: Math.random().toString(36).slice(2, 8),
        toolName: req.toolName,
        reason: req.reason,
        settle,
      }
      if (req.signal) {
        if (req.signal.aborted) {
          resolve('cancelled')
          return
        }
        req.signal.addEventListener('abort', onAbort, { once: true })
      }
      app.pendingApproval = state
      paint()
    })
  }

  // ---- input handling -----------------------------------------------------

  function insert(ch) {
    const { inputText, inputCursor } = app
    app.inputText = inputText.slice(0, inputCursor) + ch + inputText.slice(inputCursor)
    app.inputCursor += ch.length
    paint()
  }
  function backspace() {
    const { inputText, inputCursor } = app
    if (inputCursor <= 0) return
    // Delete one code point.
    const before = inputText.slice(0, inputCursor)
    const removed = [...before].pop()
    app.inputText = before.slice(0, before.length - removed.length) + inputText.slice(inputCursor)
    app.inputCursor -= removed.length
    paint()
  }
  function del() {
    const { inputText, inputCursor } = app
    if (inputCursor >= inputText.length) return
    const after = inputText.slice(inputCursor)
    const removed = [...after].shift()
    app.inputText = inputText.slice(0, inputCursor) + after.slice(removed.length)
    paint()
  }

  // Track the last hovered interactive target so motion events don't repaint
  // the whole screen on every mouse move (a major blocker during AI turns).
  let lastHover = ''

  function handleMouse(mouse) {
    if (mouse.action === 'move') {
      const region = app.hitTest(mouse.x, mouse.y)
      const target = region
        ? region.kind + ':' + (region.settingsIndex ?? region.sessionIndex ?? '')
        : ''
      if (target !== lastHover) {
        lastHover = target
        if (region) {
          app.focusedRegion = 'mouse'
          if (region.kind === 'settings-item') app.settingsSelection = region.settingsIndex
          if (region.kind === 'session') app.sidebarSelection = region.sessionIndex
          paint()
        }
      }
      return
    }
    if (mouse.action === 'wheel-up' || mouse.action === 'wheel-down') {
      const direction = mouse.action === 'wheel-up' ? -1 : 1
      if (app.overlay === 'settings') {
        const count = app.settingsItems.length
        if (count > 0) app.settingsSelection = Math.max(0, Math.min(count - 1, app.settingsSelection + direction))
      } else {
        app.scrollTranscript(-direction * 3)
      }
      paint()
      return
    }
    if (mouse.action !== 'down' || mouse.button !== 'left') return
    if (app.pendingApproval) return
    if (app.overlay === 'settings') {
      const region = app.hitTest(mouse.x, mouse.y, ['settings-item'])
      if (!region) return
      app.settingsSelection = region.settingsIndex
      handleSettingsKey({ name: 'return' })
      return
    }
    if (app.overlay === 'help') {
      app.overlay = null
      paint()
      return
    }
    const region = app.hitTest(mouse.x, mouse.y)
    if (region?.kind === 'thinking') {
      app.toggleThinking(region.thinkingBlock)
      paint()
      return
    }
    if (region?.kind === 'note') {
      app.toggleNote(region.noteBlock)
      paint()
      return
    }
    if (region?.kind === 'composer' && app.placeInputCursor(mouse.x, mouse.y)) paint()
  }

  term.on('key', (key) => {
     if (key.name === 'mouse') {
       handleMouse(key.mouse)
       return
     }
     app.focusedRegion = 'keyboard'
     // Approval prompt has its own mini-mode.
     if (false) {
       if (key.name === 'y' || key.name === 'Y' || key.name === 'return' || key.name === 'enter') {

       } else if (key.name === 'n' || key.name === 'N' || key.name === 'escape') {

         app.showToast('delete cancelled')
         paint()
       }
       return
     }
     // Approval prompt has its own mini-mode.
    if (app.pendingApproval) {
      if (key.name === 'y' || key.name === 'Y' || key.name === 'return') {
        app.pendingApproval.settle('allowed-once')
      } else if (key.name === 'n' || key.name === 'N') {
        app.pendingApproval.settle('rejected')
      } else if (key.name === 'escape') {
        app.pendingApproval.settle('cancelled')
      }
      paint()
      return
    }
    if (app.overlay === 'settings') {
      handleSettingsKey(key)
      return
    }
    if (app.overlay === 'help') {
      if (key.name === 'escape' || key.name === 'return' || key.name === 'h') {
        app.overlay = null
        paint()
      }
      return
    }
    if (key.name === 'return' || key.name === 'enter') {
      if (key.shift || key.ctrl) insert('\n')
      else submit()
      return
    }
    if (key.ctrl) {
      handleCtrlKey(key.name)
      return
    }
    switch (key.name) {
      case 'backspace': backspace(); break
      case 'left':
        if (app.effortSliderVisible && app.effortSlider) moveEffort(-1)
        else if (app.inputCursor > 0) app.inputCursor--
        paint()
        break
      case 'right':
        if (app.effortSliderVisible && app.effortSlider) moveEffort(1)
        else if (app.inputCursor < app.inputText.length) app.inputCursor++
        paint()
        break
      case 'home': app.inputCursor = 0; paint(); break
      case 'end': app.inputCursor = app.inputText.length; paint(); break
      case 'up': historyBack(); break
      case 'down': historyForward(); break
      case 'pageup': app.scroll = Math.min(app.scroll + 10, 100000); paint(); break
      case 'pagedown': app.scroll = Math.max(0, app.scroll - 10); paint(); break
      case 'tab': insert('  '); break
      case 'escape':
        if (app.effortSliderVisible) {
          app.effortSliderVisible = false
          paint()
        }
        break
      case 'unknown': break
      default:
        if (key.text !== undefined && !key.alt) insert(key.text)
        break
    }
  })

  let sharedSettings = null
  let settingsView = { kind: 'root' }

  function showSettings(loaded, selection = 0) {
    sharedSettings = loaded.settings
    app.openSettings(loaded.items, { title: loaded.title, subtitle: loaded.subtitle })
    app.settingsSelection = Math.min(selection, Math.max(0, loaded.items.length - 1))
  }

  async function openSettings(selection = 0) {
    settingsView = { kind: 'root' }
    try {
      showSettings(await loadWebSettings(ctx), selection)
    } catch (error) {
      sharedSettings = null
      app.openSettings([{ label: 'DSH settings', value: formatError(error), disabled: true }])
    }
    paint()
  }

  async function openSessionManager(selection = 0) {
    settingsView = { kind: 'sessions' }
    await refreshRecentSessions()
    const items = app.sidebarSessions.map((session) => ({
      kind: 'session',
      label: session.label,
      value: timeString(session.time),
      sessionId: session.id,
      disabled: false,
    }))
    app.openSettings(items.length > 0 ? items : [{ kind: 'session-empty', label: 'No saved sessions', value: '', disabled: true }], {
      title: 'Manage sessions',
      subtitle: 'Enter open · Ctrl+D delete · Esc back',
    })
    app.settingsSelection = Math.min(selection, Math.max(0, app.settingsItems.length - 1))
    paint()
  }

  async function deleteManagedSession(item) {
    const services = [
      ctx.get('sessionPersistence'), ctx.get('sessionQuery'),
      ctx.get('sessionStore'), ctx.get('sessionStorage'),
    ].filter(Boolean)
    const candidates = []
    for (const service of services) {
      const names = new Set([
        ...Object.keys(service),
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(service) ?? {}),
      ])
      for (const name of names) {
        if (!/^(delete|remove|unlink|purge|drop|destroy)(Session|ById)?$/i.test(name)) continue
        if (typeof service[name] === 'function') candidates.push([service, service[name]])
      }
    }
    const [owner, remover] = candidates[0] ?? []
    const deletingCurrent = item.sessionId === app.sessionId
    try {
      if (!remover && deletingCurrent && handle) {
        const currentHandle = handle
        handle = null
        currentAgent = null
        await currentHandle.dispose()
      }
      if (remover) {
        await remover.call(owner, SessionId(item.sessionId))
      } else if (!await deleteSessionDirectory(item.sessionId)) {
        throw new Error('persisted session directory was not found')
      }
      app.settingsConfirm = null
      app.showToast('deleted session ' + item.label)
      if (item.sessionId === app.sessionId) await showTitleScreen()
      else await openSessionManager(Math.max(0, app.settingsSelection - 1))
    } catch (error) {
      if (deletingCurrent && !handle) await showTitleScreen()
      app.settingsConfirm = null
      app.showToast('delete session: ' + formatError(error), 'error')
      paint()
    }
  }

  async function openProviderSettings(provider, selection = 0) {
    try {
      showSettings(await loadProviderSettings(ctx, provider), selection)
    } catch (error) {
      app.showToast('settings: ' + formatError(error), 'error')
    }
    paint()
  }

  async function refreshSettings(selection = 0) {
    if (settingsView.kind === 'provider') await openProviderSettings(settingsView.provider, selection)
    else if (settingsView.kind === 'sessions') await openSessionManager(selection)
    else await openSettings(selection)
  }

  function openSettingChoices(item, parentSelection) {
    if (!Array.isArray(item.options) || item.options.length === 0) {
      app.showToast('no available options for ' + item.label, 'warn')
      paint()
      return
    }
    settingsView = { kind: 'choice', parentSelection }
    const settingItem = { ...item, returnSelection: parentSelection }
    const items = item.options.map((value) => ({
      kind: 'setting-option',
      label: value,
      value: value === item.value ? 'selected' : '',
      optionValue: value,
      settingItem,
      disabled: false,
    }))
    app.openSettings(items, { title: item.label, subtitle: 'Enter select · Esc back' })
    app.settingsSelection = Math.max(0, item.options.indexOf(item.value))
    paint()
  }

  function requestSettingCommit(item, value) {
    if (item.confirmValue === value || item.kind === 'remove-provider') {
      app.settingsConfirm = { item, value, text: item.confirmText ?? 'Confirm this change?' }
      paint()
      return
    }
    void commitSetting(value, item)
  }

  function handleSettingsKey(key) {
    if (settingsView.kind === 'sessions' && key.ctrl && key.name === 'd') {
      const item = app.settingsItems[app.settingsSelection]
      if (item?.kind === 'session') {
        app.settingsConfirm = { item, value: '', text: 'Delete ' + item.label + '?' }
      } else {
        app.showToast('no session selected', 'warn')
      }
      paint()
      return
    }
    const count = app.settingsItems.length
    if (count === 0) {
      app.showToast('no sessions available', 'warn')
      paint()
      return
    }
    if (app.settingsConfirm) {
      if (key.name === 'y' || key.text?.toLowerCase() === 'y' || key.name === 'return' || key.name === 'enter') {
        const pending = app.settingsConfirm
        app.settingsConfirm = null
        if (pending.item.kind === 'session') void deleteManagedSession(pending.item)
        else void commitSetting(pending.value, pending.item)
      } else if (key.name === 'n' || key.text?.toLowerCase() === 'n' || key.name === 'escape') {
        app.settingsConfirm = null
        paint()
      }
      return
    }
    if (app.settingsEditing !== null) {
      if (key.name === 'escape') {
        app.settingsEditing = null
        app.settingsDraft = ''
        app.settingsSecret = false
      } else if (key.name === 'return' || key.name === 'enter') {
        const item = app.settingsItems[app.settingsEditing]
        requestSettingCommit(item, app.settingsDraft)
        return
      } else if (key.name === 'backspace') {
        app.settingsDraft = Array.from(app.settingsDraft).slice(0, -1).join('')
      } else if (key.text !== undefined && !key.ctrl && !key.alt) {
        app.settingsDraft += key.text
      }
      paint()
      return
    }

    if (key.name === 'escape') {
      if (settingsView.kind === 'choice') void openSettings(settingsView.parentSelection)
      else if (settingsView.kind === 'provider' || settingsView.kind === 'sessions') void openSettings()
      else app.overlay = null
    } else if (key.name === 'up') {
      app.settingsSelection = (app.settingsSelection + count - 1) % count
    } else if (key.name === 'down' || key.name === 'tab') {
      app.settingsSelection = (app.settingsSelection + 1) % count
    } else if (key.name === 'return' || key.name === 'enter' || key.name === 'left' || key.name === 'right') {
      const item = app.settingsItems[app.settingsSelection]
      if (item.kind === 'new-session' && (key.name === 'return' || key.name === 'enter')) {
        void showTitleScreen()
        return
      }
      if (item.kind === 'manage-sessions' && (key.name === 'return' || key.name === 'enter')) {
        void openSessionManager()
        return
      }
      if (item.kind === 'session' && (key.name === 'return' || key.name === 'enter')) {
        void openSession({ resume: item.sessionId })
        return
      }
      if (item.kind === 'setting-option' && (key.name === 'return' || key.name === 'enter')) {
        settingsView = { kind: 'root' }
        void commitSetting(item.optionValue, item.settingItem)
        return
      }
      if ((item.kind === 'default-provider' || item.kind === 'default-model' || item.kind === 'agent-preset' || item.kind === 'effort') && (key.name === 'return' || key.name === 'enter')) {
        openSettingChoices(item, app.settingsSelection)
        return
      }
      if ((item.kind === 'default-provider' || item.kind === 'default-model' || item.kind === 'agent-preset' || item.kind === 'effort') && (key.name === 'left' || key.name === 'right')) return
      if (item.kind === 'provider' && (key.name === 'return' || key.name === 'enter')) {
        void openProviderSettings(item.provider)
        return
      }
      if (!item.disabled && item.options?.length > 0) {
        const current = Math.max(0, item.options.indexOf(item.value))
        const direction = key.name === 'left' ? -1 : 1
        const next = item.options[(current + direction + item.options.length) % item.options.length]
        requestSettingCommit(item, next)
        return
      }
      if (!item.disabled && (item.kind === 'enable-provider' || item.kind === 'remove-provider')) {
        requestSettingCommit(item, '')
        return
      }
      if (!item.disabled && (key.name === 'return' || key.name === 'enter')) {
        app.settingsEditing = app.settingsSelection
        app.settingsSecret = item.kind === 'secret'
        app.settingsDraft = item.kind === 'secret' || item.value === 'system' || item.value === 'default' ? '' : item.value
      }
    }
    paint()
  }

  async function commitSetting(value, item = app.settingsItems[app.settingsSelection]) {
    const selection = item?.returnSelection ?? app.settingsSelection
    app.settingsEditing = null
    app.settingsDraft = ''
    app.settingsSecret = false
    if (!sharedSettings || !item || (value.trim() === '' && !['path', 'enable-provider', 'remove-provider'].includes(item.kind))) {
      paint()
      return
    }
    try {
      await saveWebSetting(ctx, sharedSettings, item, value)
      if (item.ns === 'agent-default-model' && item.field === 'model') {
        modelPreference.model = value
        app.setSession({ model: value })
      }
      if (item.ns === 'agent-default-model' && item.field === 'provider') {
        const selection = defaultModelSelection()
        modelPreference.provider = selection?.provider ?? value
        modelPreference.model = selection?.model
        app.setSession({ provider: modelPreference.provider, model: modelPreference.model ?? '' })
      }
      if (item.ns === 'agent-default-model') void loadEffortSlider()
      app.showToast(item.kind === 'remove-provider' ? 'provider removed' : 'saved to DSH settings')
      if (item.kind === 'remove-provider') await openSettings()
      else await refreshSettings(selection)
    } catch (error) {
      const conflict = error?.code === 'SETTINGS_CONFLICT' ? 'settings changed elsewhere; reloaded' : formatError(error)
      app.showToast('settings: ' + conflict, 'error')
      await refreshSettings(selection)
    }
  }

  function handleCtrlKey(name) {
    switch (name) {
      case 'c': {
        const action = interrupt.interrupt({
          running: app.status === 'running',
          hasInput: app.inputText.length > 0,
        })
        if (action === 'clear') {
          app.inputText = ''
          app.inputCursor = 0
          app.showToast('prompt cleared')
        } else if (action === 'cancel') {
          if (currentAgent) currentAgent.cancel({ kind: 'user' })
          app.showToast('interrupt requested')
        } else if (action === 'arm-exit') {
          app.showToast('press Ctrl+C again to exit')
        } else if (action === 'exit') {
          quit(true)
          return
        }
        paint()
        break
      }
      case 'p': openSettings(); break
      case 'd': quit(); break
      case 'n': {
        void showTitleScreen()
        break
      }
      case 's': break
      case 'l': app.resetView(); paint(); break
      case 'u': app.inputText = ''; app.inputCursor = 0; paint(); break
      case 'a': app.inputCursor = 0; paint(); break
      case 'e': toggleEffortSlider(); break
      case 'j': insert('\n'); break
      default: break
    }
  }

  function historyBack() {
    if (app.history.length === 0) return
    if (app.historyIndex < 0) {
      app.historyIndex = app.history.length - 1
      app.inputText = app.history[app.historyIndex]
    } else if (app.historyIndex > 0) {
      app.historyIndex--
      app.inputText = app.history[app.historyIndex]
    }
    app.inputCursor = app.inputText.length
    paint()
  }
  function historyForward() {
    if (app.historyIndex < 0) return
    app.historyIndex++
    if (app.historyIndex >= app.history.length) {
      app.historyIndex = -1
      app.inputText = ''
    } else {
      app.inputText = app.history[app.historyIndex]
    }
    app.inputCursor = app.inputText.length
    paint()
  }

  // ---- submit / commands --------------------------------------------------

  function sendMessage(text) {
    if (!currentAgent) return
    const wasRunning = app.status === 'running'
    lastUserText = text
    lastUserTime = Date.now()
    app.addUser(text)
    app.setStatus('running')
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    const busyEnter = ctx.get('settings')?.get('ui-conversation')?.busyEnter ?? 'queue'
    if (wasRunning && busyEnter === 'steer') currentAgent.steer(message)
    else currentAgent.followup(message)
    paint()
  }

  async function createSessionAndSend(text) {
    app.setStatus('running')
    paint()
    let pending = openingSession
    let pendingVersion = openingVersion
    if (!pending) {
      pending = openSession()
      pendingVersion = lifecycleVersion
      openingSession = pending
      openingVersion = pendingVersion
      void pending.finally(() => {
        if (openingSession === pending) {
          openingSession = null
          openingVersion = 0
        }
      })
    }
    const intendedVersion = lifecycleVersion
    if (await pending) {
      if (intendedVersion === lifecycleVersion) sendMessage(text)
      return
    }
    if (intendedVersion === lifecycleVersion && intendedVersion !== pendingVersion && !currentAgent) {
      if (openingSession === pending) {
        openingSession = null
        openingVersion = 0
      }
      await createSessionAndSend(text)
    }
  }

  function submit() {
    const text = app.inputText
    if (text.trim() === '') return
    app.history.push(text)
    if (app.history.length > 200) app.history.shift()
    app.historyIndex = -1
    app.inputText = ''
    app.inputCursor = 0
    if (text.startsWith('/')) {
      if (!currentAgent) {
        const parsed = parseCommand(text)
        if (parsed?.name === 'settings') openSettings()
        else if (parsed?.name === 'help') { app.overlay = 'help'; paint() }
        else if (parsed?.name === 'new') void showTitleScreen()
        else { app.showToast('send a message to start a session', 'warn'); paint() }
      } else {
        void runCommand(text)
      }
      return
    }
    if (!currentAgent) {
      void createSessionAndSend(text)
      return
    }
    sendMessage(text)
  }

  async function runCommand(line) {
    if (!currentAgent) return
    const parsed = parseCommand(line)
    if (!parsed) return
    // Let the harness own its human commands (/compact, /goal, /model…).
    if (ctx.commands.find(currentAgent, parsed.name)) {
      try {
        const res = await ctx.commands.execute(currentAgent, line, new AbortController().signal)
        if (res?.result?.kind === 'error') {
          app.addSystem('/' + parsed.name + ': ' + res.result.text, 'error')
        } else if (res?.result?.text) {
          app.addSystem('/' + parsed.name + ': ' + res.result.text, 'info')
        }
      } catch (error) {
        app.addSystem('/' + parsed.name + ': ' + formatError(error), 'error')
      }
      paint()
      return
    }
    switch (parsed.name) {
      case 'settings':
        openSettings()
        break
      case 'help':
        app.overlay = 'help'
        paint()
        break
      case 'new': void showTitleScreen(); break
      case 'resume': {
        const id = parsed.rawInput.trim()
        if (!id) {
          app.addSystem('usage: /resume <sessionId>', 'warn')
          break
        }
        void openSession({ resume: id })
        break
      }
      case 'model': {
        const id = parsed.rawInput.trim()
        if (!id) {
          app.addSystem('current model: ' + (modelPreference.model || app.model), 'info')
          break
        }
        modelPreference.model = id
        app.setSession({ model: id })
        app.addSystem('model set to ' + id + ' (applies to the next request)', 'info')
        void loadEffortSlider()
        paint()
        break
      }
      case 'provider': {
        const id = parsed.rawInput.trim()
        if (!id) {
          app.addSystem('current provider: ' + (modelPreference.provider || app.provider), 'info')
          break
        }
        modelPreference.provider = id
        app.setSession({ provider: id })
        app.addSystem('provider set to ' + id + ' (applies to the next request)', 'info')
        void loadEffortSlider()
        paint()
        break
      }
      case 'clear': app.resetView(); paint(); break
      case 'cancel': {
        if (currentAgent && app.status === 'running') currentAgent.cancel({ kind: 'user' })
        app.showToast('interrupt requested')
        paint()
        break
      }
      case 'quit':
      case 'exit': quit(); break
      default:
        app.addSystem('unknown command /' + parsed.name + ' — try /help', 'warn')
        paint()
    }
  }

  async function listSessionsCommand() {
    const sq = ctx.get('sessionQuery')
    if (!sq) {
      app.addSystem('session query is not mounted in this profile', 'warn')
      paint()
      return
    }
    try {
      const records = await sq.listSessions()
      const top = records.filter((r) => r.header.origin !== 'subagent').slice(0, 40)
      const results = await sq.readTitleSnapshots(top.map((r) => r.header.id))
      const lines = top.map((r, i) => {
        const res = results[i]
        const title = res?.status === 'fulfilled' && res.value.title
          ? res.value.title.title
          : String(r.header.id)
        return timeString(r.header.createdAt) + '  ' + String(r.header.id).slice(0, 20).padEnd(20, ' ')
          + '  ' + title
      })
      app.addSystem(lines.length > 0 ? 'sessions:\n' + lines.join('\n') : 'no persisted sessions', 'info')
    } catch (error) {
      app.addSystem('failed to list sessions: ' + formatError(error), 'error')
    }
    paint()
  }

  function quit(alreadyRequested = false) {
    if (!alreadyRequested && !interrupt.requestExit()) return
    term.stop()
    const exit = ctx.get('appExit')
    const cleanup = handle ? handle.dispose().catch(() => undefined) : Promise.resolve()
    cleanup.finally(() => {
      if (exit) exit(0)
      else process.exit(0)
    })
  }

  // ---- startup -----------------------------------------------------------

  if (startup.resume) {
    void openSession({ resume: startup.resume }).then(() => refreshRecentSessions())
  } else {
    void showTitleScreen()
    void refreshRecentSessions()
  }
  void loadEffortSlider()

  // Restore the terminal whenever this fiber unloads (exit, HMR, fail-loud).
  ctx.effect(() => {
    const restore = () => {
      term.stop()
    }
    const onExit = () => restore()
    const onSigint = () => handleCtrlKey('c')
    process.on('exit', onExit)
    process.on('SIGINT', onSigint)
    return () => {
      clearInterval(animationTimer)
      process.off('exit', onExit)
      process.off('SIGINT', onSigint)
      restore()
    }
  })
}