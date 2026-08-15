#!/usr/bin/env node
// dsh-tui: convenience launcher for the DeepSeek Harness terminal UI.
//
// It is equivalent to `dsh --profile tui <args...>`, but it:
//   1. prefers an installed dsh CLI on PATH,
//   2. falls back to npx (@deepseek-ai/dsh) when dsh is not installed,
//   3. verifies that the target profile exists and has this plugin installed,
//      so a missing one-time setup prints the exact command instead of a
//      confusing empty boot,
//   4. accepts --profile <name> (or DSH_TUI_PROFILE) to target a non-default
//      profile; every other argument is forwarded to the TUI app.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const PACKAGE_NAME = 'deepseek-harness-tui'
const DSH_PACKAGE = '@deepseek-ai/dsh'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function printHelp() {
  process.stdout.write(`dsh-tui ${manifest.version} — launch the DeepSeek Harness terminal UI

Usage:
  dsh-tui [--profile <name>] [app args...]

The launcher boots the dsh profile that has ${PACKAGE_NAME} installed and
forwards every other argument to the TUI app (--resume, --model, --provider,
--sidebar, --no-sidebar; see dsh --profile <name> --help).

Options:
  --profile <name>   profile to boot (default: tui; env DSH_TUI_PROFILE)
  -h, --help         show this help
  -V, --version      show the dsh-tui version

One-time setup (requires pnpm on PATH):
  dsh plugin --profile tui add ${PACKAGE_NAME}

Then:
  dsh-tui
`)
}

/**
 * Parse the launcher's own arguments. The TUI app never sees --profile,
 * --help, or --version; everything else is forwarded verbatim.
 */
function parseArgs(argv) {
  let profile = process.env.DSH_TUI_PROFILE || 'tui'
  const forwarded = []
  let help = false
  let version = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      help = true
    } else if (arg === '-V' || arg === '--version') {
      version = true
    } else if (arg === '--profile') {
      const value = argv[++i]
      if (value === undefined || value === '' || value.startsWith('-')) {
        process.stderr.write('dsh-tui: --profile needs a name\n')
        process.exit(1)
      }
      profile = value
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length)
    } else {
      forwarded.push(arg)
    }
  }
  return { profile, forwarded, help, version }
}

/** The harness home directory, matching dsh's own DSH_HOME convention. */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * Check whether `profile` has this plugin installed. The official install path
 * lists the package in dsh.profile.bundles; the zero-install development path
 * restates the rows with absolute paths in the profile's cordis.patch.yml, so
 * either marker counts.
 */
function profileStatus(profile) {
  const profileDir = join(dshHome(), 'profiles', profile)
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return 'missing'
  try {
    const profileManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const bundles = profileManifest?.dsh?.profile?.bundles ?? []
    if (bundles.includes(PACKAGE_NAME)) return 'ready'
  } catch {
    // A broken profile manifest is dsh's error to report, not the launcher's.
    return 'ready'
  }
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (existsSync(patchPath) && readFileSync(patchPath, 'utf8').includes(PACKAGE_NAME)) return 'ready'
  return 'incomplete'
}

function checkProfile(profile, setupCommand) {
  if (process.env.DSH_TUI_SKIP_CHECK === '1') return true
  const status = profileStatus(profile)
  if (status === 'ready') return true
  if (status === 'missing') {
    process.stderr.write(`dsh-tui: profile '${profile}' is not set up.\n`)
    process.stderr.write(`Create it once with (requires pnpm on PATH):\n  ${setupCommand}\n`)
  } else {
    process.stderr.write(`dsh-tui: profile '${profile}' exists but does not have ${PACKAGE_NAME} installed.\n`)
    process.stderr.write(`Add it once with:\n  ${setupCommand}\n`)
  }
  process.stderr.write(`Then run: dsh-tui --profile ${profile}\n`)
  process.stderr.write('Set DSH_TUI_SKIP_CHECK=1 to skip this check.\n')
  return false
}

/** Find an executable by name on PATH, with Windows extension probing. */
function findOnPath(name) {
  const path = process.env.PATH || ''
  const names = process.platform === 'win32' ? [name + '.cmd', name + '.exe', name] : [name]
  for (const directory of path.split(delimiter)) {
    if (directory === '') continue
    for (const candidate of names) {
      const full = join(directory, candidate)
      if (existsSync(full)) return full
    }
  }
  return undefined
}

/**
 * Resolve the dsh package's bin entry from an npm shim next to its install
 * (the shim directory is the npm prefix, so @deepseek-ai/dsh resolves from
 * there). Returning the JS entry lets Windows run it through node directly,
 * which avoids both the .cmd EINVAL hardening and shell-argument quoting.
 */
function resolveDshEntry(dshExecutable) {
  try {
    const packagePath = createRequire(resolve(dshExecutable)).resolve(`${DSH_PACKAGE}/package.json`)
    const packageManifest = JSON.parse(readFileSync(packagePath, 'utf8'))
    const entry = typeof packageManifest.bin === 'string'
      ? packageManifest.bin
      : packageManifest.bin?.dsh
    if (typeof entry === 'string' && entry !== '') return resolve(dirname(packagePath), entry)
  } catch {
    // Not an npm shim beside the dsh install, or a non-npm layout.
  }
  return undefined
}

/** Spawn one resolved command, using node for npm shims on Windows when possible. */
function spawnCommand(command, args) {
  if (process.platform === 'win32') {
    const entry = resolveDshEntry(command)
    if (entry !== undefined) return spawn(process.execPath, [entry, ...args], { stdio: 'inherit' })
    if (/\.(cmd|bat)$/i.test(command)) {
      return spawn('cmd.exe', ['/d', '/s', '/c', command, ...args], { stdio: 'inherit' })
    }
  }
  return spawn(command, args, { stdio: 'inherit' })
}

/** The npx fallback: prefer the npm CLI bundled with this Node, then PATH. */
function npxCommand() {
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')
  if (existsSync(bundled)) return { command: process.execPath, args: [bundled] }
  const onPath = findOnPath('npx')
  if (onPath !== undefined) return { command: onPath, args: [] }
  return undefined
}

function launchDsh(profile, forwarded) {
  const dshArgs = ['--profile', profile, ...forwarded]
  const dshExecutable = findOnPath('dsh')
  if (dshExecutable !== undefined) return spawnCommand(dshExecutable, dshArgs)
  const npx = npxCommand()
  if (npx !== undefined) return spawnCommand(npx.command, [...npx.args, '--yes', DSH_PACKAGE, ...dshArgs])
  return undefined
}

function main() {
  const { profile, forwarded, help, version } = parseArgs(process.argv.slice(2))
  if (help) {
    printHelp()
    process.exit(0)
  }
  if (version) {
    process.stdout.write(manifest.version + '\n')
    process.exit(0)
  }
  if (profile === '' || profile === '.' || profile === '..' || profile === 'node_modules'
    || profile.includes('/') || profile.includes('\\')) {
    process.stderr.write(`dsh-tui: invalid profile name ${JSON.stringify(profile)}\n`)
    process.exit(1)
  }
  const setupCommand = findOnPath('dsh') !== undefined
    ? `dsh plugin --profile ${profile} add ${PACKAGE_NAME}`
    : `npx --yes ${DSH_PACKAGE} plugin --profile ${profile} add ${PACKAGE_NAME}`
  if (!checkProfile(profile, setupCommand)) process.exit(2)

  const child = launchDsh(profile, forwarded)
  if (child === undefined) {
    process.stderr.write(`dsh-tui: could not find dsh or npx on PATH — install ${DSH_PACKAGE} first\n`)
    process.exit(1)
  }
  child.on('error', (error) => {
    process.stderr.write('dsh-tui: failed to launch dsh: ' + error.message + '\n')
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0))
  })
}

main()
