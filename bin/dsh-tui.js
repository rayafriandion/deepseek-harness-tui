#!/usr/bin/env node
// Convenience launcher for the DeepSeek Harness TUI. Equivalent to running
//   npx @deepseek-ai/dsh --profile tui <args...>
// but needs no dsh CLI on PATH. Forwarded arguments reach the TUI app.
import { spawn } from 'node:child_process'

const args = ['--yes', '@deepseek-ai/dsh', '--profile', 'tui', ...process.argv.slice(2)]
// Node >= 18 runs .cmd files directly; no shell, so no arg-concatenation warning.
const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { stdio: 'inherit' })
child.on('error', (error) => {
  process.stderr.write('dsh-tui: failed to launch dsh: ' + error.message + '\n')
  process.exit(1)
})
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})