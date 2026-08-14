// The TUI app's command-line provider: parses the dsh --profile tui flag
// family (--resume, --model, --provider, --sidebar) and its --help text, then
// provides the immutable values as the tuiStartup service. Ordinary rows
// inject that service and read it as a lazily-resolved value.
import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

export const name = 'dsh-tui/startup'
export const inject = ['cmdlineArgs']
export const TUI_STARTUP_SERVICE = 'tuiStartup'

function tuiCommand() {
  return new Command()
    .name('dsh --profile tui')
    .description('Boot the DeepSeek Harness terminal UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume <sessionId>', 'resume an existing persisted session by id')
    .option('--model <modelId>', 'default model id for new sessions')
    .option('--provider <provider>', 'default provider route for new sessions')
    .option('--sidebar', 'show the session sidebar (default)')
    .option('--no-sidebar', 'start without the sidebar')
    .addHelpText('after', `
Examples:
  dsh --profile tui                      start a fresh session
  dsh --profile tui --resume abc123      resume a persisted session
  dsh --profile tui --model deepseek-v4-flash
`)
}

export function apply(ctx) {
  const program = tuiCommand()
  program.action(() => {
    const options = program.opts()
    ctx.provide(TUI_STARTUP_SERVICE, {
      resume: options.resume ?? null,
      model: options.model ?? null,
      provider: options.provider ?? null,
      sidebar: options.sidebar !== false,
    })
  })
  parseCmdline(ctx, program)
}
