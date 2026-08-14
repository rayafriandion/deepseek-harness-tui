// The dsh-tui app plugin: boots a terminal UI inside a dsh profile, drives
// agents through ctx.agents, renders the durable session/event feed, and
// routes human input back via followup/steer.
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { Terminal } from './term.js'
import { App } from './ui.js'
import { contentText, formatError, timeString } from './util.js'

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
  const term = new Terminal()
  if (!term.isTTY()) {
    console.error('dsh-tui: stdin/stdout are not a TTY; run in an interactive terminal (dsh --profile tui)')
    const exit = ctx.get('appExit')
    if (exit) exit(1)
    return
  }
  term.start()
  const app = new App(term)
  app.sidebarVisible = config.sidebar !== false && startup.sidebar !== false

  // Live session state.
  let handle = null
  let currentAgent = null
  let lastUserText = null
  let lastUserTime = 0
  let quitting = false
  const modelPreference = {
    model: startup.model ?? config.defaultModel ?? undefined,
    provider: startup.provider ?? config.defaultProvider ?? undefined,
  }

  const paint = () => term.paint(app.render())
  term.on('resize', () => paint())
  paint()

  // ---- session lifecycle -------------------------------------------------

  function newSessionId() {
    return 'tui-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  }

  async function openSession({ resume = null, announce = true } = {}) {
    // Tear down the previous agent to quiescence.
    if (handle) {
      const old = handle
      handle = null
      currentAgent = null
      try { await old.dispose() } catch { /* already settling */ }
    }
    lastUserText = null
    app.resetView()
    app.setSession({ title: 'DeepSeek Harness' })
    // Resolve the model selection: explicit preference (flag/config//model)
    // wins, then the deployment's agent-default-model service (settings).
    const agentOptions = {}
    const defaultSelection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (modelPreference.provider ?? defaultSelection?.provider) {
      agentOptions.provider = modelPreference.provider ?? defaultSelection.provider
    }
    if (modelPreference.model ?? defaultSelection?.model) {
      agentOptions.model = modelPreference.model ?? defaultSelection.model
    }
    try {
      if (resume) {
        handle = await ctx.agents.resume({
          resumeSessionId: SessionId(resume),
          agentOptions,
        })
      } else {
        handle = await ctx.agents.create({
          sessionId: SessionId(newSessionId()),
          meta: { cwd: process.cwd() },
          agentOptions,
        })
      }
      currentAgent = handle.agent
      app.setSession({
        id: String(currentAgent.session.id),
        model: currentAgent.options.model ?? '',
        provider: currentAgent.options.provider ?? '',
      })
      replay(currentAgent.session)
      app.addSystem('session ' + currentAgent.session.id + (resume ? ' resumed' : ' started') + ' · ' + process.cwd(), 'info')
      app.setStatus('idle')
      void refreshRecentSessions()
      paint()
    } catch (error) {
      handle = null
      currentAgent = null
      app.addSystem('failed to open session: ' + formatError(error), 'error')
      app.setStatus('idle')
      paint()
    }
  }

  // Build the transcript from a session's durable log (resume/replay path).
  function replay(session) {
    for (const event of session.events) {
      switch (event.type) {
        case 'user/message': {
          const src = event.data.source
          const text = contentText(event.data.content)
          if (src?.kind === 'user') app.addUser(text)
          else app.addSystem('[' + (src?.kind ?? 'context') + '] ' + text, 'dim')
          break
        }
        case 'assistant/message': {
          const msg = event.data.message
          const text = contentText(msg.content)
          const reasoning = msg.content
            .filter((b) => b.type === 'reasoning')
            .map((b) => b.text)
            .join('')
          const asst = app.ensureAssistantBlock(event.time)
          asst.text = text
          asst.reasoning = config.showReasoning !== false ? reasoning : ''
          asst.streaming = false
          asst.time = event.time
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
    const titleEvent = [...session.events].reverse().find((e) => e.type === 'session/title')
    if (titleEvent) app.setSession({ title: titleEvent.data.title })
  }

  // ---- durable event stream ----------------------------------------------

  ctx.on('session/event', (session, event) => {
    if (!currentAgent || session.id !== currentAgent.session.id) return
    handleSessionEvent(event)
    paint()
  })

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
          app.addSystem('[' + (src?.kind ?? 'context') + '] ' + text, 'dim')
        }
        break
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') app.streamChunk(chunk)
        else if (chunk.type === 'reasoning-delta' && config.showReasoning !== false) {
          app.streamChunk(chunk)
        }
        break
      }
      case 'assistant/message': {
        const msg = event.data.message
        const text = contentText(msg.content)
        const reasoning = msg.content
          .filter((b) => b.type === 'reasoning')
          .map((b) => b.text)
          .join('')
        const asst = app.ensureAssistantBlock(event.time)
        asst.text = text
        asst.reasoning = config.showReasoning !== false ? reasoning : ''
        asst.streaming = false
        asst.time = event.time
        if (event.data.usage) {
          app.usage.input += event.data.usage.inputTokens ?? 0
          app.usage.output += event.data.usage.outputTokens ?? 0
        }
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

  function refreshSidebar() {
    app.sidebarAgents = ctx.agents
      .list()
      .map((a) => ({ id: String(a.id), label: String(a.id) }))
    paint()
  }
  ctx.on('agent/created', () => refreshSidebar())
  ctx.on('agent/disposed', () => refreshSidebar())
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

  ctx.on('agent/request', async ({ agent }, next) => {
    const config = await next()
    if (!currentAgent || agent.id !== currentAgent.id) return config
    if (!modelPreference.model && !modelPreference.provider) return config
    return {
      ...config,
      ...modelPreference.provider ? { provider: modelPreference.provider } : {},
      ...modelPreference.model ? { model: modelPreference.model } : {},
    }
  })

  // ---- approval -----------------------------------------------------------

  ctx.on('approval/request', (req, next) => {
    if (!currentAgent || req.agent.id !== currentAgent.id) return next()
    return askApproval(req)
  })

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

  term.on('key', (key) => {
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
    if (app.overlay === 'help') {
      if (key.name === 'escape' || key.name === 'return' || key.name === 'h') {
        app.overlay = null
        paint()
      }
      return
    }
    if (key.name === 'return' || key.name === 'enter') {
      submit()
      return
    }
    if (key.ctrl) {
      handleCtrlKey(key.name)
      return
    }
    switch (key.name) {
      case 'backspace': backspace(); break
      case 'delete': del(); break
      case 'left':
        if (app.inputCursor > 0) app.inputCursor--
        paint()
        break
      case 'right':
        if (app.inputCursor < app.inputText.length) app.inputCursor++
        paint()
        break
      case 'home': app.inputCursor = 0; paint(); break
      case 'end': app.inputCursor = app.inputText.length; paint(); break
      case 'up':
        if (app.inputText === '' && app.sidebarVisible && app.sidebarSessions.length > 0) {
          app.sidebarSelection = app.sidebarSelection < 0
            ? app.sidebarSessions.length - 1
            : Math.max(0, app.sidebarSelection - 1)
          paint()
        } else {
          historyBack()
        }
        break
      case 'down':
        if (app.inputText === '' && app.sidebarVisible && app.sidebarSessions.length > 0) {
          app.sidebarSelection = app.sidebarSelection >= app.sidebarSessions.length - 1
            ? -1
            : app.sidebarSelection + 1
          paint()
        } else {
          historyForward()
        }
        break
      case 'pageup': app.scroll = Math.min(app.scroll + 10, 100000); paint(); break
      case 'pagedown': app.scroll = Math.max(0, app.scroll - 10); paint(); break
      case 'tab': insert('  '); break
      case 'escape': break
      case 'unknown': break
      default:
        if (key.text !== undefined && !key.alt) insert(key.text)
        break
    }
  })

  function handleCtrlKey(name) {
    switch (name) {
      case 'c': {
        if (app.status === 'running') {
          if (currentAgent) currentAgent.cancel({ kind: 'user' })
          app.showToast('cancelling…')
          app.setStatus('idle')
        } else if (quitting) {
          quit()
        } else {
          quitting = true
          app.showToast('press Ctrl+C again to quit')
          setTimeout(() => { quitting = false }, 1500)
        }
        paint()
        break
      }
      case 'd': quit(); break
      case 'n': {
        void openSession()
        break
      }
      case 's': app.sidebarVisible = !app.sidebarVisible; paint(); break
      case 'l': app.resetView(); paint(); break
      case 'u': app.inputText = ''; app.inputCursor = 0; paint(); break
      case 'a': app.inputCursor = 0; paint(); break
      case 'e': app.inputCursor = app.inputText.length; paint(); break
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

  function submit() {
    const text = app.inputText
    if (text.trim() === '' || !currentAgent) return
    // Sidebar selection on Enter with empty-ish input selects a session.
    if (app.sidebarSelection >= 0 && app.sidebarVisible) {
      const target = app.sidebarSessions[app.sidebarSelection]
      if (target && text.trim() === '') {
        app.sidebarSelection = -1
        app.inputText = ''
        app.inputCursor = 0
        void openSession({ resume: target.id })
        return
      }
    }
    app.history.push(text)
    if (app.history.length > 200) app.history.shift()
    app.historyIndex = -1
    app.inputText = ''
    app.inputCursor = 0
    if (text.startsWith('/')) {
      void runCommand(text)
      return
    }
    lastUserText = text
    lastUserTime = Date.now()
    app.addUser(text)
    app.setStatus('running')
    currentAgent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    paint()
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
      case 'help':
        app.overlay = 'help'
        paint()
        break
      case 'new': void openSession(); break
      case 'resume': {
        const id = parsed.rawInput.trim()
        if (!id) {
          app.addSystem('usage: /resume <sessionId> (see /sessions)', 'warn')
          break
        }
        void openSession({ resume: id })
        break
      }
      case 'sessions': {
        void listSessionsCommand()
        break
      }
      case 'model': {
        const id = parsed.rawInput.trim()
        if (!id) {
          app.addSystem('current model: ' + (modelPreference.model || app.model), 'info')
          break
        }
        modelPreference.model = id
        app.addSystem('model set to ' + id + ' (applies to the next request)', 'info')
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
        app.addSystem('provider set to ' + id + ' (applies to the next request)', 'info')
        paint()
        break
      }
      case 'clear': app.resetView(); paint(); break
      case 'cancel': {
        if (currentAgent && app.status === 'running') currentAgent.cancel({ kind: 'user' })
        app.setStatus('idle')
        app.showToast('cancelled')
        paint()
        break
      }
      case 'sidebar': app.sidebarVisible = !app.sidebarVisible; paint(); break
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

  function quit() {
    if (quitting) return
    quitting = true
    term.stop()
    const exit = ctx.get('appExit')
    const cleanup = handle ? handle.dispose().catch(() => undefined) : Promise.resolve()
    cleanup.finally(() => {
      if (exit) exit(0)
      else process.exit(0)
    })
  }

  // ---- startup -----------------------------------------------------------

  void openSession({ resume: startup.resume ?? null }).then(() => {
    void refreshRecentSessions()
  })

  // Restore the terminal whenever this fiber unloads (exit, HMR, fail-loud).
  ctx.effect(() => {
    const restore = () => {
      term.stop()
    }
    const onExit = () => restore()
    process.on('exit', onExit)
    return () => {
      process.off('exit', onExit)
      restore()
    }
  })
}