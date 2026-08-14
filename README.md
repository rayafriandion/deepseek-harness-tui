# deepseek-harness-tui

An opencode-inspired **terminal UI (TUI)** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), shipped as a dsh profile app plugin. It boots a chat client inside the dsh process: it creates/resumes agents through `ctx.agents`, renders the durable `session/event` stream (user messages, streaming assistant tokens, tool cards, todo lists), routes human input back via `agent.followup()`, and answers `approval/request` prompts inline.

The UI follows opencode's dark design language (see [the reference TUI](https://github.com/anomalyco/opencode)): a session sidebar, a chat transcript with markdown rendering, an input row, and a status bar.

> **Launch command.** The stock dsh launcher only hardcodes `web` as a bare subcommand alias; `tui` cannot be registered as a subcommand by a plugin without editing the launcher. The canonical invocation is therefore:

```sh
npx @deepseek-ai/dsh --profile tui
```

(The launcher's own help even documents `--profile tui` as the intended shape.) If you want the exact string `dsh tui`, add a one-line shell alias/function (e.g. `doskey tui=dsh --profile tui $*` in CMD) or install the bundled `dsh-tui` bin (`npx dsh-tui`).

## Requirements

- Node.js >= 22, an installed `@deepseek-ai/dsh` (this machine: 0.1.0-rc.6), and an interactive terminal (Windows Terminal / ConPTY, iTerm2, GNOME Terminal, ...).
- A configured model route: the profile reuses the machine's `$DSH_HOME/settings.yaml` (`llm-pi-ai` providers or `llm-deepseek`) and `$DSH_HOME/.credentials.yaml` — the same setup the Web GUI uses.

## Install

### On this machine (already done)

The `tui` profile was created at `C:/Users/Sanchess/.dsh/profiles/tui` (bundle `@deepseek-ai/dsh-base` + TUI rows) and the plugin's `node_modules` is a junction to `$DSH_HOME/profiles/node_modules` so its dsh imports resolve without pnpm. Just run:

```sh
npx @deepseek-ai/dsh --profile tui
```

### On another machine

1. Place this directory anywhere (e.g. `D:/Projects/DeepSeekHarnessPlugins/deepseek-harness-tui`).
2. Create the profile: `npx @deepseek-ai/dsh --profile tui --dump-config` (boots an empty base once).
3. Add the TUI rows to `$DSH_HOME/profiles/tui/cordis.patch.yml`, replacing the absolute paths with your own:

```yaml
- insert:
    - id: tui-startup
      name: 'file:///D:/Projects/DeepSeekHarnessPlugins/deepseek-harness-tui/lib/startup.js'
    - id: tui-app
      name: 'file:///D:/Projects/DeepSeekHarnessPlugins/deepseek-harness-tui/lib/index.js'
      config:
        sidebar: true
        showReasoning: true
```

4. Make the plugin's dsh imports resolvable. The zero-install trick used here:

```powershell
# junction the plugin's node_modules to the harness' shared profile closure
New-Item -ItemType Junction -Path "<this-dir>/node_modules" -Target "$env:USERPROFILE/.dsh/profiles/node_modules"
```

Alternatively, with pnpm installed, use the canonical bundle install:

```sh
cd $DSH_HOME/profiles/tui
pnpm add -w D:/path/to/deepseek-harness-tui
# then add "deepseek-harness-tui" to dsh.profile.bundles in package.json
# and remove the two rows above from cordis.patch.yml (the bundle supplies them)
```

## Usage

```sh
dsh --profile tui                       # fresh session
dsh --profile tui --resume <sessionId>  # resume a persisted session
dsh --profile tui --model <modelId>     # default model for new sessions
dsh --profile tui --provider <route>    # default provider route
dsh --profile tui --no-sidebar          # start without the sidebar
dsh --profile tui --help                # the TUI's own flags
```

### Keybindings

| Key | Action |
| --- | --- |
| Enter | send message |
| Ctrl+C | cancel the running turn; press again (idle) to quit |
| Ctrl+N | new session |
| Ctrl+S | toggle sidebar |
| Ctrl+L | clear the transcript view |
| Up / Down | input history (empty input + sidebar: navigate sessions) |
| PgUp / PgDn | scroll the transcript |
| Esc | close help / cancel an approval prompt |
| y / n | answer an inline approval prompt |

### Commands

`/help` `/new` `/resume <id>` `/sessions` `/model <id>` `/provider <route>` `/clear` `/cancel` `/sidebar` `/quit`

Harness human commands (`/compact`, `/goal`, ...) are forwarded to `ctx.commands` and run without a model turn.

## How it works

- The plugin is a Cordis function plugin loaded by the `tui` profile. `lib/startup.js` parses the app's flags and provides the `tuiStartup` service; `lib/index.js` owns the UI loop.
- `lib/term.js` is a zero-dependency terminal engine: raw mode, alternate screen, a diffing cell buffer, and a key decoder (truecolor ANSI, CJK-aware widths).
- `lib/ui.js` is the view model + renderer (opencode-style theme, sidebar, transcript, input, status bar, help overlay).
- `lib/markdown.js` renders model output (headings, lists, quotes, code, inline spans) to styled lines.
- Agents are created/resumed through `ctx.agents`, the transcript is rebuilt from `session.surface` on resume and fed live by `session/event` (including `assistant/chunk` streaming), model defaults come from `ctx.agentDefaultModel`, and approvals answer the `approval/request` waterfall inline.

## Development

```sh
node tests/smoke.test.mjs     # standalone pure-module tests (no dsh needed)
node --check lib/*.js         # syntax
```

The full end-to-end path (profile boot -> session -> live LLM streaming -> commands -> clean exit) was verified through a pseudo-terminal (node-pty + ConPTY) on Windows against this machine's dsh install.

## Known limitations

- Single-line input (Alt+Enter inserts a newline; no multi-line editing yet).
- The sidebar is read-only navigation over recent sessions; live per-agent switching is not exposed.
- `dsh tui` as a bare subcommand needs a shell alias — the stock launcher hardcodes only `web` and `plugin` subcommands.
- Editing the plugin source does not hot-reload (the profile's HMR root is the profile dir, not the plugin dir); restart the profile to pick up changes.
- The `--resume` and sidebar flows require the shared `sessionQuery` service (mounted by `dsh-base`).

## Layout

```
lib/index.js        plugin entry: agents, events, input, commands, approvals
lib/startup.js      command-line provider (tuiStartup service)
lib/term.js         terminal engine (raw mode, screen, key decoding)
lib/ui.js           view model + renderer
lib/markdown.js     markdown -> styled lines
lib/util.js         text/display helpers
bin/dsh-tui.js      optional npx launcher for `dsh --profile tui`
cordis.patch.yml    bundle patch layer (TUI rows, for the pnpm install path)
tests/smoke.test.mjs  standalone smoke tests
```
