// Standalone smoke tests for the deepseek-harness-tui pure modules.
// Run: node tests/smoke.test.mjs  (no dsh environment required)
import { decodeKey } from "../lib/term.js"
import { App } from "../lib/ui.js"
import { renderMarkdown } from "../lib/markdown.js"
import { displayWidth, wrapText, roughTokens, truncateWidth } from "../lib/util.js"

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

// ---- decodeKey ----
eq("Enter", decodeKey(Buffer.from([0x0d])), { key: { name: "return" }, consumed: 1 })
eq("Ctrl+C", decodeKey(Buffer.from([0x03])), { key: { name: "c", ctrl: true }, consumed: 1 })
eq("Up", decodeKey(Buffer.from([0x1b, 0x5b, 0x41])), { key: { name: "up" }, consumed: 3 })
eq("PgUp", decodeKey(Buffer.from([0x1b, 0x5b, 0x35, 0x7e])), { key: { name: "pageup" }, consumed: 4 })
eq("ESC alone", decodeKey(Buffer.from([0x1b])), { key: { name: "escape" }, consumed: 1 })
eq("printable", decodeKey(Buffer.from("a")), { key: { name: "a", text: "a" }, consumed: 1 })
eq("CJK printable", decodeKey(Buffer.from("中", "utf8")), { key: { name: "中", text: "中" }, consumed: 3 })

// ---- markdown ----
const theme = {
  text: "eeeeee", markdownHeading: "9d7cd8", markdownCode: "7fd88f", codeBg: "1e1e1e",
  markdownCodeBlock: "eeeeee", markdownListItem: "fab283", markdownHorizontalRule: "808080",
  markdownBlockQuote: "e5c07b", markdownLinkText: "56b6c2",
}
const NL2 = String.fromCharCode(10)
const md = renderMarkdown("Hello **world**" + NL2 + "- one" + NL2 + "> quote" + NL2 + "# Head" + NL2 + "para two", theme, 40)
const mdText = md.map((l) => l.map((s) => s.text).join(""))
eq("markdown blocks", mdText, ["Hello world", "• one", "▍ quote", "Head", "para two"])

// ---- App render ----
const fakeTerm = { cols: 100, rows: 30, on() {} }
const app = new App(fakeTerm)
app.setSession({ id: "t1", title: "Test", model: "m", provider: "p" })
app.addUser("hi")
app.startAssistant()
app.streamChunk({ type: "text-delta", text: "hello there" })
app.startTool({ callId: "c1", name: "bash", args: "{}" })
app.updateTool("c1", { status: "ok", result: "done" })
const screen = app.render()
ok("render has rows", screen.rows === 30)
ok("render has cols", screen.cols === 100)
// header
ok("header text", screen.cells[0].slice(0, 20).map((c) => c.ch).join("").includes("DeepSeek"))
// user block
ok("user label", screen.cells.map((r) => r.map((c) => c.ch).join("")).join(NL2).includes("You"))

console.log("")
if (failed > 0) { console.log(failed + " test(s) failed"); process.exit(1) }
console.log("all smoke tests passed")