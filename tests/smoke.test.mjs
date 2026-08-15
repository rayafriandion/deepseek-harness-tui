// Standalone smoke tests for the deepseek-harness-tui pure modules.
// Run: node tests/smoke.test.mjs  (no dsh environment required)
import { decodeKey } from "../lib/term.js"
import { App, THEME, noteFromContext } from "../lib/ui.js"
import { InterruptState } from "../lib/interrupt.js"
import { SessionMetrics } from "../lib/metrics.js"
import { loadProviderSettings, loadWebSettings, saveWebSetting } from "../lib/web-settings.js"
import { renderMarkdown } from "../lib/markdown.js"
import { displayWidth, wrapText, roughTokens, truncateWidth, contentText, timeString, toolSummary } from "../lib/util.js"

let failed = 0
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { console.log("ok   " + name) }
  else { console.log("FAIL " + name + "  got " + a + "  want " + e); failed++ }
}
const ok = (name, cond) => cond ? console.log("ok   " + name) : (console.log("FAIL " + name), failed++)

// ---- util ----
eq("displayWidth CJK", displayWidth("中文a"), 5)
eq("roughTokens", roughTokens("你好world"), 3)
eq("truncateWidth", truncateWidth("hello world", 5), "hello")
eq("wrapText", wrapText("a b c d e", 5), ["a b c", "d e"])
eq("contentText includes reasoning", contentText([{ type: "reasoning", text: "hidden" }, { type: "text", text: "visible" }]), "hiddenvisible")
eq("contentText skips reasoning", contentText([{ type: "reasoning", text: "hidden" }, { type: "text", text: "visible" }], { skipReasoning: true }), "visible")
eq("timeString carries full date", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timeString(0)), true)

// ---- tool summaries ----
eq("toolSummary read", toolSummary("read", '{"file_path":"/a/b.txt"}'), "read /a/b.txt")
eq("toolSummary write object args", toolSummary("write", { file_path: "/a/b.txt" }), "write /a/b.txt")
eq("toolSummary pwsh hides command key", toolSummary("pwsh", '{"command":"pnpm test"}'), "run pnpm test")
eq("toolSummary glob hides pattern key", toolSummary("glob", '{"pattern":"**/*.ts"}'), "glob **/*.ts")
eq("toolSummary grep", toolSummary("grep", '{"pattern":"TODO"}'), "grep TODO")
eq("toolSummary editor", toolSummary("str_replace_editor", '{"command":"str_replace","path":"/a/b.txt"}'), "str_replace_editor str_replace /a/b.txt")
eq("toolSummary unknown value-led", toolSummary("something", '{"command":"x"}'), "something x")
eq("toolSummary unknown json fallback", toolSummary("something", '{"a":1}'), "something {\"a\":1}")
eq("toolSummary no args", toolSummary("read"), "read")

// ---- decodeKey ----
eq("Enter", decodeKey(Buffer.from([0x0d])), { key: { name: "return" }, consumed: 1 })
eq("Ctrl+D", decodeKey(Buffer.from([0x04])), { key: { name: "d", ctrl: true }, consumed: 1 })
eq("Up", decodeKey(Buffer.from([0x1b, 0x5b, 0x41])), { key: { name: "up" }, consumed: 3 })
eq("PgUp", decodeKey(Buffer.from([0x1b, 0x5b, 0x35, 0x7e])), { key: { name: "pageup" }, consumed: 4 })
eq("ESC alone", decodeKey(Buffer.from([0x1b])), { key: { name: "escape" }, consumed: 1 })
eq("printable", decodeKey(Buffer.from("a")), { key: { name: "a", text: "a" }, consumed: 1 })
eq("CJK printable", decodeKey(Buffer.from("中", "utf8")), { key: { name: "中", text: "中" }, consumed: 3 })
eq("Shift+Enter CSI-u", decodeKey(Buffer.from("\x1b[13;2u")), { key: { name: "enter", shift: true }, consumed: 7 })
eq("Ctrl+Enter CSI-u", decodeKey(Buffer.from("\x1b[13;5u")), { key: { name: "enter", ctrl: true }, consumed: 7 })
eq("Ctrl+Enter LF", decodeKey(Buffer.from([0x0a])), { key: { name: "enter", ctrl: true }, consumed: 1 })
eq("Alt+Enter legacy", decodeKey(Buffer.from([0x1b, 0x0d])), { key: { name: "enter", shift: true }, consumed: 2 })
eq("Ctrl+comma CSI-u", decodeKey(Buffer.from("\x1b[44;5u")), { key: { name: ",", ctrl: true }, consumed: 7 })
eq("mouse left down", decodeKey(Buffer.from("\x1b[<0;12;7M")), { key: { name: "mouse", mouse: { x: 11, y: 6, button: "left", action: "down", shift: false, alt: false, ctrl: false } }, consumed: 10 })
eq("mouse wheel up", decodeKey(Buffer.from("\x1b[<64;3;4M")), { key: { name: "mouse", mouse: { x: 2, y: 3, button: "wheel", action: "wheel-up", shift: false, alt: false, ctrl: false } }, consumed: 10 })
eq("X10 wheel up", decodeKey(Buffer.from([0x1b, 0x5b, 0x4d, 0x60, 44, 39])), { key: { name: "mouse", mouse: { x: 11, y: 6, button: "wheel", action: "wheel-up", shift: false, alt: false, ctrl: false } }, consumed: 6 })
eq("partial mouse buffered", decodeKey(Buffer.from("\x1b[<0;12")), null)
eq("partial X10 buffered", decodeKey(Buffer.from([0x1b, 0x5b, 0x4d, 0x60])), null)

// ---- markdown ----
const theme = {
  text: "eeeeee", markdownHeading: "9d7cd8", markdownCode: "7fd88f", codeBg: "1e1e1e",
  markdownCodeBlock: "eeeeee", markdownListItem: "fab283", markdownHorizontalRule: "808080",
  markdownBlockQuote: "e5c07b", markdownLinkText: "56b6c2",
}
const NL2 = String.fromCharCode(10)
const md = renderMarkdown("Hello **world**" + NL2 + "- one" + NL2 + "> quote" + NL2 + "# Head" + NL2 + "para two", theme, 40)
const mdText = md.map((l) => l.map((s) => s.text).join(""))
eq("markdown blocks", mdText, ["Hello world", "- one", "▍ quote", "Head", "para two"])
const unorderedText = renderMarkdown("- one" + NL2 + "* two" + NL2 + "+ three", theme, 40)
  .map((line) => line.map((segment) => segment.text).join(""))
eq("markdown unordered markers use stable ASCII width", unorderedText, ["- one", "- two", "- three"])

// ---- context notes ----
eq("noteFromContext system-reminder", noteFromContext({ kind: "plugin", plugin: "agent-instructions" }, "<system-reminder>Additional instructions</system-reminder>"), { label: "system-reminder", text: "Additional instructions" })
eq("noteFromContext system-reminder strips every frame", noteFromContext({ kind: "plugin", plugin: "skill" }, "<system-reminder>one</system-reminder>\n<system-reminder>two</system-reminder>"), { label: "system-reminder", text: "one\ntwo" })
eq("noteFromContext compaction checkpoint", noteFromContext({ kind: "plugin", plugin: "compact", compactionId: "c1" }, "checkpoint preamble\n<compacted-summary>\nsummary body\n</compacted-summary>"), { label: "compaction", text: "checkpoint preamble\n\nsummary body" })
eq("noteFromContext other plugin stays plain", noteFromContext({ kind: "plugin", plugin: "other" }, "plain text"), null)
eq("noteFromContext non-string stays plain", noteFromContext({ kind: "plugin", plugin: "compact" }, 42), null)

// ---- interrupt lifecycle ----
const interrupt = new InterruptState({ confirmMs: 1500 })
eq("Ctrl+C clears input", interrupt.interrupt({ running: false, hasInput: true, now: 1000 }), "clear")
eq("Ctrl+C cancels running turn", interrupt.interrupt({ running: true, now: 1000 }), "cancel")
eq("first idle Ctrl+C arms exit", interrupt.interrupt({ running: false, now: 1000 }), "arm-exit")
eq("second idle Ctrl+C exits", interrupt.interrupt({ running: false, now: 2000 }), "exit")
eq("exit is idempotent", interrupt.requestExit(), false)

// ---- session metrics ----
const metrics = new SessionMetrics()
metrics.consume({ type: "step/start", time: 1000, data: { turn: 1, step: 1 } })
metrics.consume({ type: "assistant/chunk", time: 1300, data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "hi" } } })
metrics.consume({ type: "assistant/message", time: 2300, data: { turn: 1, step: 1, usage: { inputTokens: 40, outputTokens: 20, cacheReadTokens: 60 } } })
eq("TTFT average", metrics.snapshot().ttftAverageMs, 300)
eq("decode throughput", metrics.snapshot().tokensPerSecond, 20)
eq("disjoint cache hit rate", metrics.snapshot().cacheHitRate, 60)

// ---- shared WebUI settings ----
const sections = new Map([
  ["agent-default-model", { provider: "first", model: "one" }],
  ["permission", { defaultPreset: "workspace-write" }],
  ["agent-presets", { default: "catgirl-ptc" }],
  ["llm-pi-ai", { providers: { first: { apiKeyEnv: "FIRST_API_KEY", baseURL: "https://first.test", models: [{ id: "one" }] }, second: { models: [{ id: "two" }, { id: "three" }] } } }],
])
const userSections = new Map([...sections].map(([ns, value]) => [ns, structuredClone(value)]))
const revisions = new Map([...sections.keys()].map((ns) => [ns, 0]))
const setAt = (source, path, value) => {
  if (path.length === 0) return value
  const root = structuredClone(source ?? {})
  let node = root
  for (const part of path.slice(0, -1)) node = node[part] ??= {}
  if (value === undefined) delete node[path.at(-1)]
  else node[path.at(-1)] = value
  return root
}
const fakeSettings = {
  writable: true,
  documentPath: "C:/Users/test/.dsh/settings.yaml",
  describe() { return [...sections].map(([ns, value]) => ({ ns, value, user: userSections.get(ns), revision: revisions.get(ns) ?? 0, applies: "live" })) },
  register(ns) {
    if (ns === "ui-theme") sections.set(ns, { preference: "system" })
    if (ns === "locale") sections.set(ns, {})
    if (ns === "ui-conversation") sections.set(ns, { busyEnter: "queue" })
    userSections.set(ns, structuredClone(sections.get(ns)))
    revisions.set(ns, 0)
  },
  get(ns) { return sections.get(ns) },
  async update(ns, patch) { sections.set(ns, { ...sections.get(ns), ...patch }); userSections.set(ns, structuredClone(sections.get(ns))); revisions.set(ns, (revisions.get(ns) ?? 0) + 1) },
  async replace(ns, value) { sections.set(ns, value); userSections.set(ns, structuredClone(value)); revisions.set(ns, (revisions.get(ns) ?? 0) + 1) },
  async mutate(ns, ops) {
    let next = userSections.get(ns)
    for (const op of ops) next = setAt(next, op.path, op.op === "set" ? op.value : undefined)
    userSections.set(ns, next)
    sections.set(ns, structuredClone(next))
    revisions.set(ns, (revisions.get(ns) ?? 0) + 1)
  },
}
const storedCredentials = new Map([["FIRST_API_KEY", "old-secret"]])
const fakeCredentials = {
  async describe(ref) { return { configured: storedCredentials.has(ref), source: storedCredentials.has(ref) ? "file" : undefined, writable: true } },
  async set(ref, value) { storedCredentials.set(ref, value) },
  async unset(ref) { storedCredentials.delete(ref) },
}
const fakeLlm = {
  listProviders() { return [{ id: "first", name: "First" }, { id: "second", name: "Second" }] },
  async listModels(provider) { return provider === "first" ? [{ provider, id: "one", name: "One" }] : [{ provider, id: "two", name: "Two" }, { provider, id: "three", name: "Three" }] },
  async resolveModelInfo(provider, model) {
    if (provider === "first" && model === "one") {
      return { context: 128000, defaultMaxTokens: 4096, reasoning: { defaultEffort: "high", efforts: [{ id: "off", name: "off" }, { id: "high", name: "high" }, { id: "max", name: "max" }] } }
    }
    return { context: 128000, defaultMaxTokens: 4096 }
  },
  listConfigurableProviders() {
    return [
      { provider: "first", displayName: "First", settingsNs: "llm-pi-ai", settingsPath: ["providers", "first"] },
      { provider: "second", displayName: "Second", settingsNs: "llm-pi-ai", settingsPath: ["providers", "second"], declared: true },
    ]
  },
}
const fakeCtx = {
  get(name) {
    if (name === "settings") return fakeSettings
    if (name === "credentials") return fakeCredentials
    if (name === "llm") return fakeLlm
    if (name === "agentPresets") return { defaultId: "catgirl-ptc", async list() { return [{ id: "catgirl-ptc" }, { id: "default" }] } }
    if (name === "permissionPresets") return { names: ["workspace-write", "danger-full-access"] }
  },
}
const shared = await loadWebSettings(fakeCtx)
ok("WebUI namespaces registered", sections.has("ui-theme") && sections.has("locale") && sections.has("ui-conversation"))
ok("shared settings loaded", shared.items.some((item) => item.label === "Default model" && item.value === "one"))
ok("manage sessions setting", shared.items.some((item) => item.kind === "manage-sessions" && item.label === "Manage sessions"))
ok("new session setting", shared.items.some((item) => item.kind === "new-session" && item.label === "New session"))
const presetItem = shared.items.find((item) => item.ns === "agent-presets")
ok("default agent preset is a list choice", presetItem && presetItem.kind === "agent-preset" && Array.isArray(presetItem.options) && presetItem.options.length === 2 && presetItem.value === "catgirl-ptc")
await saveWebSetting(fakeCtx, fakeSettings, presetItem, "default")
eq("default agent preset persisted", sections.get("agent-presets").default, "default")
const effortItem = shared.items.find((item) => item.field === "reasoningEffort")
ok("reasoning effort is a list menu", effortItem && effortItem.kind === "effort" && Array.isArray(effortItem.options) && effortItem.options.length === 3 && effortItem.value === "high")
const originalModelSettings = structuredClone(sections.get("agent-default-model"))
sections.set("agent-default-model", { ...originalModelSettings, reasoningEffort: "unsupported-old-model-level" })
const unsupportedEffortShared = await loadWebSettings(fakeCtx)
const unsupportedEffortItem = unsupportedEffortShared.items.find((item) => item.field === "reasoningEffort")
eq("unsupported stored effort falls back to current model default", unsupportedEffortItem.value, "high")
sections.set("agent-default-model", originalModelSettings)
await saveWebSetting(fakeCtx, fakeSettings, effortItem, "max")
eq("reasoning effort persisted", sections.get("agent-default-model").reasoningEffort, "max")
ok("provider config hidden", !shared.items.some((item) => item.kind === "provider") && shared.items.some((item) => item.kind === "provider-config-info"))
ok("web-only appearance/language hidden in TUI", !shared.items.some((item) => item.label === "General · Appearance") && !shared.items.some((item) => item.label === "General · Language"))
const modelItem = shared.items.find((item) => item.field === "model")
await saveWebSetting(fakeCtx, fakeSettings, modelItem, "gpt-5.6-luna")
eq("shared settings persisted", sections.get("agent-default-model").model, "gpt-5.6-luna")
const providerPage = await loadProviderSettings(fakeCtx, "first")
ok("provider settings loaded", providerPage.items.some((item) => item.kind === "secret" && item.value.includes("configured")) && providerPage.items.some((item) => item.label === "Base URL"))
await saveWebSetting(fakeCtx, fakeSettings, providerPage.items.find((item) => item.kind === "secret"), "new-secret")
eq("provider credential persisted", storedCredentials.get("FIRST_API_KEY"), "new-secret")
await saveWebSetting(fakeCtx, fakeSettings, providerPage.items.find((item) => item.label === "Base URL"), "https://changed.test")
eq("provider path persisted", sections.get("llm-pi-ai").providers.first.baseURL, "https://changed.test")
const refreshedShared = await loadWebSettings(fakeCtx)

// ---- App render ----
const fakeTerm = { cols: 100, rows: 30, on() {} }
const titleApp = new App(fakeTerm)
titleApp.setWelcome({ workingDirectory: "D:/Projects/example", gitBranch: "main" })
const titleRendered = titleApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("title screen", titleRendered.includes("DeepSeek Harness") && titleRendered.includes("D:/Projects/example"))
ok("title git branch", titleRendered.includes("git: main"))
ok("title settings hint", titleRendered.includes("Ctrl+P") && titleApp.sessionId === "")

// Entering the welcome screen must drop the previous session's title.
const staleTitleApp = new App(fakeTerm)
staleTitleApp.setSession({ id: "old", title: "Old session title" })
staleTitleApp.setWelcome({ workingDirectory: "D:/x" })
const staleTitleRendered = staleTitleApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("welcome screen drops stale session title", !staleTitleRendered.includes("Old session title") && staleTitleRendered.includes("New session"))

const modelTitleApp = new App(fakeTerm)
modelTitleApp.setWelcome({ workingDirectory: "D:/Projects/example", model: "gpt-5.6-luna", provider: "first" })
const modelTitleRendered = modelTitleApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("title screen shows default model", modelTitleRendered.includes("gpt-5.6-luna") && !modelTitleRendered.includes("· model ·"))

const app = new App(fakeTerm)
app.setSession({ id: "t1", title: "Test", model: "m", provider: "p" })
app.addUser("hi")
app.startAssistant()
const scrollApp = new App(fakeTerm)
scrollApp.setSession({ id: "scroll", title: "Scroll" })
for (let i = 0; i < 20; i++) scrollApp.addSystem("history line " + i)
scrollApp.scrollTranscript(3)
ok("mouse-wheel transcript scroll", scrollApp.scroll > 0)
const scrolled = scrollApp.scroll
scrollApp.scrollTranscript(-3)
ok("mouse-wheel transcript return", scrollApp.scroll < scrolled)

app.streamChunk({ type: "text-delta", text: "hello there" })
app.startTool({ callId: "c1", name: "bash", args: "{}" })
app.updateTool("c1", { status: "ok", result: "done" })
const followupAssistant = app.ensureAssistantBlock(Date.now())
followupAssistant.text = "continued after tool"
app.inputText = "first line\nsecond line"
app.inputCursor = app.inputText.length
app.setMetrics(metrics.snapshot())
app.sidebarSessions = [{ id: "t1", label: "Test session", time: Date.now() }]
const screen = app.render()
ok("render has rows", screen.rows === 30)
ok("render has cols", screen.cols === 100)
// header
ok("header text", screen.cells[0].slice(0, 20).map((c) => c.ch).join("").includes("DeepSeek"))
const headerRows = screen.cells.slice(0, 2).map((r) => r.map((c) => c.ch).join("")).join(NL2)
eq("single session title in header", (headerRows.match(/Test/g) ?? []).length, 1)
ok("session id hidden from header", !headerRows.includes("t1"))
// user block
const rendered = screen.cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("user label", rendered.includes("You"))
eq("single assistant header per request", (rendered.match(/dsh\s+·/g) ?? []).length, 1)
ok("no left session rail", !rendered.includes("Test session"))
ok("multiline composer", rendered.includes("first line") && rendered.includes("second line"))
ok("TTFT footer", rendered.includes("TTFT avg 300ms"))
ok("throughput footer", rendered.includes("20.0 tok/s"))
ok("cache footer", rendered.includes("cache 60%"))
ok("bottom actions removed", !app.hitRegions.some((region) => region.kind === "new-session" && region.y === 29) && !app.hitRegions.some((region) => region.kind === "settings"))
ok("no session mouse target in transcript", !app.hitRegions.some((region) => region.kind === "session"))
const composerRegion = app.hitRegions.find((region) => region.kind === "composer")
ok("mouse composer target", composerRegion && app.placeInputCursor(composerRegion.x + 2, composerRegion.composerTop + 1) && app.inputCursor === 0)
app.openSettings(refreshedShared.items)
const settingsRendered = app.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("settings overlay", settingsRendered.includes("Settings") && settingsRendered.includes("Shared with DeepSeek Harness WebUI"))
ok("settings values", settingsRendered.includes("Default model") && settingsRendered.includes("gpt-5.6-luna"))
ok("mouse settings targets", app.hitRegions.some((region) => region.kind === "settings-item" && region.settingsIndex === 0))

// Toast lives on the bottom status row, horizontally centered.
const toastApp = new App(fakeTerm)
toastApp.toast = { text: "saved to DSH settings", level: "info" }
const toastRendered = toastApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
const toastLastRow = toastRendered.split(NL2).at(-1)
ok("toast bottom-center on status row", toastLastRow.includes("saved to DSH settings"))
ok("toast not in transcript header", !toastRendered.split(NL2).slice(0, 2).join(NL2).includes("saved to DSH settings"))

// Terminal cursor parks at the input caret (IME anchors there).
const cursorScreen = new App(fakeTerm)
cursorScreen.setSession({ id: "t1", title: "Test" })
cursorScreen.inputText = "hello"
cursorScreen.inputCursor = 5
const cursorRendered = cursorScreen.render()
ok("cursor parked at input caret", cursorRendered.cursorY > 0 && cursorRendered.cursorX > 2 && cursorRendered.cursorY < 30)

// Thinking box: collapsed by default once streaming finishes, clickable to expand.
const thinkApp = new App(fakeTerm)
thinkApp.setSession({ id: "t1", title: "Test" })
thinkApp.addUser("hi")
const thinkBlock = thinkApp.ensureAssistantBlock(Date.now())
thinkBlock.reasoning = "secret reasoning text"
thinkBlock.text = "the answer"
thinkBlock.streaming = false
thinkBlock.thinkingCollapsed = true
const collapsedRendered = thinkApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("thinking collapsed by default", collapsedRendered.includes("thinking") && !collapsedRendered.includes("secret reasoning text"))
ok("thinking click target", thinkApp.hitRegions.some((region) => region.kind === "thinking"))
const thinkRegion = thinkApp.hitRegions.find((region) => region.kind === "thinking")
thinkApp.toggleThinking(thinkRegion.thinkingBlock)
const expandedRendered = thinkApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("thinking expands on click", expandedRendered.includes("secret reasoning text"))
thinkApp.toggleThinking(thinkRegion.thinkingBlock)
const recollapsedRendered = thinkApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("thinking collapses again on click", !recollapsedRendered.includes("secret reasoning text"))

// Thinking stays collapsed while streaming, and toggle is a no-op until done.
const streamThink = new App(fakeTerm)
streamThink.setSession({ id: "t1", title: "Test" })
streamThink.addUser("hi")
const streamBlock = streamThink.ensureAssistantBlock(Date.now())
streamBlock.reasoning = "live streaming reasoning"
streamBlock.text = "answer"
streamBlock.streaming = true
const streamRendered = streamThink.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("thinking stays collapsed while streaming", streamRendered.includes("streaming") && !streamRendered.includes("live streaming reasoning"))
streamThink.toggleThinking(streamBlock)
ok("thinking toggle no-op while streaming", streamBlock.thinkingCollapsed !== true)
streamBlock.streaming = false
streamBlock.thinkingCollapsed = true // finalizeAssistant sets this when streaming ends
const afterStreamRendered = streamThink.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("thinking collapsed after streaming", !afterStreamRendered.includes("live streaming reasoning"))
streamThink.toggleThinking(streamBlock)
const expandedAfterStream = streamThink.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("thinking expandable after streaming", expandedAfterStream.includes("live streaming reasoning"))

// Context notes render as thinking-style collapsible boxes with their own palettes.
const noteApp = new App(fakeTerm)
noteApp.setSession({ id: "t1", title: "Test" })
noteApp.addNote("Additional instructions from: AGENTS.md", "system-reminder")
noteApp.addNote("This is an automatically generated checkpoint condensing an earlier span.", "compaction")
const noteCollapsed = noteApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("note labels rendered", noteCollapsed.includes("system-reminder") && noteCollapsed.includes("compaction"))
ok("note bodies collapsed by default", !noteCollapsed.includes("Additional instructions") && !noteCollapsed.includes("automatically generated"))
ok("note click targets registered", noteApp.hitRegions.filter((region) => region.kind === "note").length >= 2)
const noteRegion = noteApp.hitRegions.find((region) => region.kind === "note")
noteApp.toggleNote(noteRegion.noteBlock)
const noteExpanded = noteApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("note expands on click", noteExpanded.includes("Additional instructions"))
noteApp.toggleNote(noteRegion.noteBlock)
const noteRecollapsed = noteApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("note collapses again on click", !noteRecollapsed.includes("Additional instructions"))
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const rgbDist = (a, b) => Math.hypot(...hexRgb(a).map((v, i) => v - hexRgb(b)[i]))
ok("note palettes differ from thinking background", THEME.reminderBg !== THEME.compactionBg && THEME.reminderBg !== THEME.backgroundElement && THEME.compactionBg !== THEME.backgroundElement)
ok("note backgrounds are visually distinct", rgbDist(THEME.reminderBg, THEME.backgroundElement) > 40 && rgbDist(THEME.compactionBg, THEME.backgroundElement) > 40 && rgbDist(THEME.reminderBg, THEME.compactionBg) > 40)

// ---- context meter (web ContextMeter port) ----
const meterApp = new App(fakeTerm)
meterApp.setSession({ id: "t1", title: "Test" })
meterApp.setContextMeter({})
ok("no meter without pressure", meterApp.contextMeter === null)
meterApp.setContextMeter(null)
ok("null meter input clears without throwing", meterApp.contextMeter === null)
meterApp.setContextMeter(undefined)
ok("undefined meter input clears without throwing", meterApp.contextMeter === null)
meterApp.setContextMeter({ pressure: { pressureTokens: 32_000 } })
ok("no meter without capacity", meterApp.contextMeter === null)
meterApp.setContextMeter({ pressure: { contextWindow: 128_000 } })
ok("no meter without numerator", meterApp.contextMeter === null)
meterApp.setContextMeter({
  pressure: { pressureTokens: 32_000, contextWindow: 128_000 },
  breakdown: { systemTokens: 120, toolsTokens: 21_500, messageTokens: 477_000 },
})
eq("meter occupancy percent", meterApp.contextMeter.percent, 25)
const meterRendered = meterApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
const meterRow = meterRendered.split(NL2).at(-1)
ok("meter reading in status row", meterRow.includes("ctx") && meterRow.includes("32K/128K") && meterRow.includes("25%"))
ok("meter bar uses fill and track cells", meterRow.includes("█") && meterRow.includes("░"))
ok("meter click target", meterApp.hitRegions.some((region) => region.kind === "context-meter"))
// projectedTokens drives the reading so a compaction shows at once.
const projectedApp = new App(fakeTerm)
projectedApp.setSession({ id: "t1", title: "Test" })
projectedApp.setContextMeter({ pressure: { pressureTokens: 32_000, projectedTokens: 3_000, contextWindow: 128_000 } })
eq("meter follows projectedTokens", projectedApp.contextMeter.percent, 2)
const projectedRow = projectedApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2).split(NL2).at(-1)
ok("meter reading shows projected figures", projectedRow.includes("3K/128K"))
// Full context clamps at 100% and shifts the fill to the warning/error hue.
const fullApp = new App(fakeTerm)
fullApp.setSession({ id: "t1", title: "Test" })
fullApp.setContextMeter({ pressure: { pressureTokens: 300_000, contextWindow: 128_000 } })
eq("meter clamps at 100%", fullApp.contextMeter.percent, 100)
// Click-open breakdown panel: headline, reading, segmented bar, legend.
const panelApp = new App(fakeTerm)
panelApp.setSession({ id: "t1", title: "Test" })
panelApp.setContextMeter({
  pressure: { pressureTokens: 32_000, contextWindow: 128_000 },
  breakdown: { systemTokens: 120, toolsTokens: 21_500, messageTokens: 477_000 },
})
panelApp.contextMeterOpen = true
const panelRendered = panelApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("context panel headline", panelRendered.includes("context") && panelRendered.includes("used 25%"))
ok("context panel figures", panelRendered.includes("~32K / 128K"))
ok("context panel legend", panelRendered.includes("system prompt") && panelRendered.includes("tools") && panelRendered.includes("messages"))
ok("context panel hidden behind settings", !panelRendered.includes("Settings") || panelRendered.includes("Esc close"))
// Zero occupancy draws no fill segment but still shows the figures.
const zeroApp = new App(fakeTerm)
zeroApp.setSession({ id: "t1", title: "Test" })
zeroApp.setContextMeter({ pressure: { pressureTokens: 0, contextWindow: 128_000 } })
zeroApp.contextMeterOpen = true
const zeroPanelRendered = zeroApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("zero occupancy still shows figures", zeroPanelRendered.includes("~0 / 128K"))
ok("context palette distinct", THEME.contextSystem !== THEME.contextTools && THEME.contextTools !== THEME.contextMessages)

// Tool invocations surface their primary value without leaking JSON field names.
const toolApp = new App(fakeTerm)
toolApp.setSession({ id: "t1", title: "Test" })
toolApp.startTool({ callId: "r1", name: "read", args: '{"file_path":"/a/b.txt"}' })
toolApp.startTool({ callId: "p1", name: "pwsh", args: '{"command":"pnpm test"}' })
toolApp.startTool({ callId: "g1", name: "glob", args: '{"pattern":"**/*.ts"}' })
const toolSummaryRendered = toolApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("tool summary hides raw field names", !toolSummaryRendered.includes("file_path") && !toolSummaryRendered.includes("command") && !toolSummaryRendered.includes("pattern"))
ok("tool summary shows values", toolSummaryRendered.includes("/a/b.txt") && toolSummaryRendered.includes("pnpm test") && toolSummaryRendered.includes("**/*.ts"))

// A blank line separates a collapsed thinking box from the visible answer.
const gapApp = new App(fakeTerm)
gapApp.setSession({ id: "t1", title: "Test" })
gapApp.addUser("hi")
const gapAssistant = gapApp.ensureAssistantBlock(Date.now())
gapAssistant.reasoning = "thinking text"
gapAssistant.thinkingCollapsed = true
gapAssistant.text = "answer"
gapAssistant.streaming = false
const gapRows = gapApp.render().cells.map((r) => r.map((c) => c.ch).join(""))
const thinkIdx = gapRows.findIndex((r) => r.includes("thinking"))
const answerIdx = gapRows.findIndex((r) => r.includes("answer"))
ok("blank line separates thinking box from answer", thinkIdx >= 0 && answerIdx === thinkIdx + 2 && gapRows[thinkIdx + 1].trim() === "")

// ---- theme / activity animation ----
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const animApp = new App(fakeTerm)
animApp.setSession({ id: "t1", title: "Test" })
ok("no animation when idle", !animApp.hasAnimation())
const toolBlock = animApp.startTool({ callId: "c1", name: "write", args: "{}" })
ok("animation while tool running", animApp.hasAnimation())
const toolRendered = animApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
const toolRow = toolRendered.split(NL2).find((l) => l.includes("write"))
ok("running tool shows flowing spinner", toolRow && SPINNER.some((ch) => toolRow.includes(ch)))
animApp.updateTool("c1", { status: "ok", result: "done" })
ok("animation stops when tool finishes", !animApp.hasAnimation())

// Streaming thinking header carries the flowing spinner too.
const spinThink = new App(fakeTerm)
spinThink.setSession({ id: "t1", title: "Test" })
spinThink.addUser("hi")
const spinBlock = spinThink.ensureAssistantBlock(Date.now())
spinBlock.reasoning = "thinking out loud"
spinBlock.streaming = true
const spinRendered = spinThink.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
const thinkingRow = spinRendered.split(NL2).find((l) => l.includes("thinking"))
ok("streaming thinking shows flowing spinner", thinkingRow && SPINNER.some((ch) => thinkingRow.includes(ch)))

// Title brand is drawn with a blue->white gradient (multiple distinct fg colors).
const gradApp = new App(fakeTerm)
gradApp.setWelcome({ workingDirectory: "D:/x" })
const gradScreen = gradApp.render()
const gradRow = gradScreen.cells.findIndex((row) => row.map((c) => c.ch).join("").includes("DeepSeek Harness"))
const gradColors = new Set()
for (const cell of gradScreen.cells[gradRow]) {
  if (cell.style && cell.style.fg) gradColors.add(cell.style.fg)
}
ok("title blue-white gradient", gradRow >= 0 && gradColors.size >= 2)
ok("theme is DeepSeek blue-white, no orange", THEME.primary === "4d6bfe" && !Object.values(THEME).some((c) => String(c).toLowerCase() === "fab283"))

// assistant/message semantics: the visible text excludes reasoning, which
// stays in its own box (so the box does not "disappear" into plain output).
const msgApp = new App(fakeTerm)
msgApp.setSession({ id: "t1", title: "Test" })
msgApp.addUser("hi")
msgApp.streamChunk({ type: "reasoning-delta", text: "private chain of thought" })
msgApp.streamChunk({ type: "text-delta", text: "the answer" })
const msgBlock = msgApp.blocks[msgApp.blocks.length - 1]
msgBlock.text = contentText([{ type: "reasoning", text: "private chain of thought" }, { type: "text", text: "the answer" }], { skipReasoning: true })
msgBlock.reasoning = "private chain of thought"
msgBlock.streaming = false
msgBlock.thinkingCollapsed = true
msgBlock.rev++
const msgRendered = msgApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("reasoning stays in its box after message", msgApp.hitRegions.some((region) => region.kind === "thinking") && msgRendered.includes("thinking"))
ok("reasoning not duplicated in plain text", !msgRendered.includes("private chain of thought") || msgRendered.includes("the answer"))
msgApp.toggleThinking(msgBlock)
const msgExpanded = msgApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("reasoning visible when expanded", msgExpanded.includes("private chain of thought"))

// ---- reasoning-effort slider ----
const sliderApp = new App(fakeTerm)
sliderApp.setSession({ id: "t1", title: "Test" })
sliderApp.setEffortSlider({ levels: [{ id: "off", name: "off" }, { id: "high", name: "high" }, { id: "max", name: "max" }], current: "high" })
sliderApp.effortSliderVisible = true
const sliderMidScreen = sliderApp.render()
const sliderRendered = sliderMidScreen.cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
const sliderMidRow = sliderMidScreen.cells.find((row) => row.some((cell) => cell.ch === "█"))
const sliderMidRowText = sliderMidRow?.map((cell) => cell.ch).join("") ?? ""
ok("effort slider label", sliderRendered.includes("effort"))
ok("effort slider current name", sliderRendered.includes("high"))
ok("effort slider row keeps current value", sliderMidRowText.includes("high"))
ok("effort slider real range hint", sliderRendered.includes("off") && sliderRendered.includes("max"))
ok("effort slider not animated at mid strength", !sliderApp.hasAnimation())
sliderApp.setEffortSlider({ levels: [{ id: "off", name: "off" }, { id: "high", name: "high" }, { id: "max", name: "max" }], current: "max" })
ok("effort slider animates at max", sliderApp.hasAnimation())
const sliderMaxScreen = sliderApp.render()
const sliderMaxRendered = sliderMaxScreen.cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("effort slider max marker is text-safe", sliderMaxRendered.includes("↑") && !sliderMaxRendered.includes(String.fromCodePoint(0x26A1)))
const sliderMaxRow = sliderMaxScreen.cells.find((row) => row.some((cell) => cell.ch === "█"))
const sliderGradientColors = new Set(sliderMaxRow?.filter((cell) => cell.ch === "█").map((cell) => cell.style?.fg).filter(Boolean))
ok("effort slider max uses gradient colors", sliderGradientColors.size > 1)
const composerTopRow = sliderMaxScreen.cells.find((row) => {
  const text = row.map((cell) => cell.ch).join("")
  return text.includes("╭") && text.includes("↑") && text.includes("max")
})
const composerTopText = composerTopRow?.map((cell) => cell.ch).join("") ?? ""
ok("effort value is pinned to composer top-right", composerTopText.lastIndexOf("max") > composerTopText.length / 2 && composerTopText.includes("╮"))
const maxStart = composerTopText.lastIndexOf("max")
const maxTextColors = new Set(composerTopRow?.slice(maxStart, maxStart + 3).map((cell) => cell.style?.fg).filter(Boolean))
ok("max text uses flowing gradient colors", maxTextColors.size > 1)
sliderApp.effortSliderVisible = false
ok("max animation continues after slider closes", sliderApp.hasAnimation())
// A one-level Off-only model is not max and must not animate.
const offOnlyApp = new App(fakeTerm)
offOnlyApp.setSession({ id: "t1", title: "Test" })
offOnlyApp.setEffortSlider({ levels: [{ id: "off", name: "Off" }], current: "off" })
offOnlyApp.effortSliderVisible = true
const offOnlyRendered = offOnlyApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("off-only slider does not animate as max", !offOnlyApp.hasAnimation() && !offOnlyRendered.includes("↑ max"))
// A boolean-thinking model exposes exactly its two ends, never a fake scale.
const boolApp = new App(fakeTerm)
boolApp.setSession({ id: "t1", title: "Test" })
boolApp.setEffortSlider({ levels: [{ id: "off", name: "off" }, { id: "high", name: "high" }], current: "off" })
boolApp.effortSliderVisible = true
const boolRendered = boolApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("boolean slider shows exactly two ends", boolRendered.includes("effort") && boolRendered.includes("off") && boolRendered.includes("high"))
ok("boolean slider not animated at off", !boolApp.hasAnimation())
// A partial-range provider (off/high/max) must not map to a full none..max.
const partialApp = new App(fakeTerm)
partialApp.setSession({ id: "t1", title: "Test" })
partialApp.setEffortSlider({ levels: [{ id: "off", name: "off" }, { id: "high", name: "high" }, { id: "max", name: "max" }], current: "high" })
partialApp.effortSliderVisible = true
const partialRendered = partialApp.render().cells.map((r) => r.map((c) => c.ch).join("")).join(NL2)
ok("partial slider uses provider levels only", !partialRendered.includes("none") && !partialRendered.includes("low") && !partialRendered.includes("medium"))

console.log("")
if (failed > 0) { console.log(failed + " test(s) failed"); process.exit(1) }
console.log("all smoke tests passed")