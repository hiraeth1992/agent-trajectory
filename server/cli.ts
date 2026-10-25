import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import packageMetadata from '../package.json'
import { startAgentTrajectoryServer, type AgentTrajectoryServer } from './app'
import { openBrowser } from './browser-open'
import { BrowserSession } from './browser-session'
import {
  installedAgentHooks,
  installAgentHooks,
  readHookInstallation,
  uninstallAgentHooks,
  type HookInstallLocations,
} from './hook-installation'
import {
  acquireRuntimeLock,
  readRuntimeState,
  removeRuntimeState,
  requestRuntime,
  writeRuntimeState,
} from './runtime-state'
import { SessionActivationHub, type HookPayload } from './session-activation'
import {
  defaultDataRoot,
  portablePath,
  readConfig,
  resolveSourcePaths,
  writeConfig,
  type ResolvedSourcePaths,
  type SourcePathOverrides,
} from './source-paths'
import { createSourceRegistry } from './sources/registry'
import type { SourceId, SourceStatus } from '../src/types'

type Command =
  | 'doctor'
  | 'hook'
  | 'install-hooks'
  | 'open'
  | 'setup'
  | 'start'
  | 'uninstall-hooks'

interface CliArguments {
  command: Command
  dataRoot: string
  noOpen: boolean
  port?: number
  source?: SourceId
  sessionId?: string
  sourcePaths: SourcePathOverrides
}

const distributionRoot = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(distributionRoot, '..')

function configureWorkerLocations(): void {
  process.env.AGENT_TRAJECTORY_PROJECTION_WORKER = path.join(
    distributionRoot,
    'lib',
    'projection-worker.mjs',
  )
  process.env.AGENT_TRAJECTORY_ZCODE_WORKER = path.join(
    distributionRoot,
    'lib',
    'zcode-worker.mjs',
  )
}

function value(arguments_: readonly string[], index: number, option: string): string {
  const selected = arguments_[index + 1]
  if (selected === undefined || selected.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return selected
}

function sourceId(value: string): SourceId | undefined {
  return value === 'codex' || value === 'dsh' || value === 'zcode'
    ? value
    : undefined
}

export function parseCliArguments(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): CliArguments {
  const positionals: string[] = []
  const sourcePaths: SourcePathOverrides = {}
  let dataRoot = path.resolve(
    environment.AGENT_TRAJECTORY_DATA_DIR ?? defaultDataRoot(homeDirectory),
  )
  let noOpen = false
  let port: number | undefined
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!
    if (!argument.startsWith('--')) {
      positionals.push(argument)
      continue
    }
    if (argument === '--no-open') {
      noOpen = true
      continue
    }
    const selected = value(arguments_, index, argument)
    index++
    if (argument === '--data-dir') dataRoot = path.resolve(selected)
    else if (argument === '--port') {
      port = Number(selected)
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error('--port must be an integer from 0 to 65535')
      }
    } else if (argument === '--dsh-dir') sourcePaths.dshSessionsDir = selected
    else if (argument === '--codex-home') sourcePaths.codexHome = selected
    else if (argument === '--codex-sessions-dir') sourcePaths.codexSessionsDir = selected
    else if (argument === '--zcode-db') sourcePaths.zcodeDatabase = selected
    else throw new Error(`unknown option: ${argument}`)
  }
  const commandValue = positionals[0] ?? 'start'
  if (![
    'doctor',
    'hook',
    'install-hooks',
    'open',
    'setup',
    'start',
    'uninstall-hooks',
  ].includes(commandValue)) {
    throw new Error(`unknown command: ${commandValue}`)
  }
  const command = commandValue as Command
  const source = positionals[1] === undefined
    ? undefined
    : sourceId(positionals[1])
  if ((command === 'hook' || command === 'open') && source === undefined) {
    throw new Error(`${command} requires a source: codex, dsh, or zcode`)
  }
  const sessionId = positionals[2]
  if (command === 'open' && sessionId === undefined) {
    throw new Error('open requires a session id')
  }
  return {
    command,
    dataRoot,
    noOpen,
    port,
    source,
    sessionId,
    sourcePaths,
  }
}

async function resolvedPaths(arguments_: CliArguments): Promise<ResolvedSourcePaths> {
  const config = await readConfig(arguments_.dataRoot)
  return resolveSourcePaths({
    cli: arguments_.sourcePaths,
    config: config.sources,
    configDirectory: arguments_.dataRoot,
  })
}

function sessionPath(source: SourceId, sessionId: string): string {
  const search = new URLSearchParams({
    source,
    session: sessionId,
  })
  return `/?${search}`
}

async function runningState(dataRoot: string) {
  const state = await readRuntimeState(dataRoot)
  if (state === undefined) return undefined
  try {
    const response = await requestRuntime(
      state,
      '/api/integrations/ping',
    )
    return response.ok ? state : undefined
  } catch {
    return undefined
  }
}

async function waitForRuntime(dataRoot: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const state = await runningState(dataRoot)
    if (state !== undefined) return state
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return undefined
}

function spawnRuntime(dataRoot: string): void {
  const child = spawn(process.execPath, [
    process.argv[1]!,
    'start',
    '--no-open',
    '--data-dir',
    dataRoot,
  ], {
    detached: true,
    stdio: 'ignore',
  })
  child.once('error', () => {})
  child.unref()
}

async function hookPayload(): Promise<HookPayload> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of input) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 64 * 1024) throw new Error('hook payload too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('hook payload must be an object')
  }
  return parsed as HookPayload
}

async function forwardHook(
  arguments_: CliArguments,
  payload: HookPayload,
): Promise<void> {
  let state = await runningState(arguments_.dataRoot)
  if (state === undefined) {
    spawnRuntime(arguments_.dataRoot)
    state = await waitForRuntime(arguments_.dataRoot)
  }
  if (state === undefined) throw new Error('Agent Trajectory did not start')
  const response = await requestRuntime(
    state,
    '/api/integrations/session-start',
    payload,
    arguments_.source,
  )
  if (!response.ok) throw new Error(`session activation failed (${response.status})`)
}

async function start(arguments_: CliArguments): Promise<void> {
  const existing = await runningState(arguments_.dataRoot)
  if (existing !== undefined) {
    if (!arguments_.noOpen) {
      await requestRuntime(existing, '/api/integrations/show')
    }
    console.log(`Agent Trajectory is already running: ${existing.url}`)
    return
  }
  const lock = await acquireRuntimeLock(arguments_.dataRoot)
  if (lock === undefined) {
    const started = await waitForRuntime(arguments_.dataRoot)
    if (started === undefined) {
      throw new Error('Agent Trajectory is already starting but did not become ready')
    }
    if (!arguments_.noOpen) {
      await requestRuntime(started, '/api/integrations/show')
    }
    console.log(`Agent Trajectory is already running: ${started.url}`)
    return
  }
  try {
    const rechecked = await runningState(arguments_.dataRoot)
    if (rechecked !== undefined) {
      if (!arguments_.noOpen) {
        await requestRuntime(rechecked, '/api/integrations/show')
      }
      console.log(`Agent Trajectory is already running: ${rechecked.url}`)
      return
    }
    const paths = await resolvedPaths(arguments_)
    const hookToken = randomBytes(32).toString('base64url')
    const browserSession = new BrowserSession()
    const activations = new SessionActivationHub(hookToken)
    configureWorkerLocations()
    let server: AgentTrajectoryServer | undefined
    const show = (source?: SourceId, sessionId?: string) => {
      if (server === undefined) return
      openBrowser(browserSession.createLaunchUrl(
        server.url,
        source === undefined || sessionId === undefined
          ? '/'
          : sessionPath(source, sessionId),
      ))
    }
    activations.setShowHandler(activation =>
      show(activation?.source, activation?.sessionId))
    server = await startAgentTrajectoryServer({
      root,
      staticRoot: path.join(distributionRoot, 'dist'),
      host: '127.0.0.1',
      port: arguments_.port ?? 0,
      development: false,
      summaryDataRoot: arguments_.dataRoot,
      sourcePaths: paths,
      browserSession,
      diagnosisEvidenceCommand: JSON.stringify(path.join(
        distributionRoot,
        'lib',
        'diagnosis-evidence.mjs',
      )),
      diagnosisSkillPath: path.join(
        distributionRoot,
        'skills',
        'trajectory-diagnosis',
        'SKILL.md',
      ),
      sessionActivationHub: activations,
    })
    await writeRuntimeState(arguments_.dataRoot, {
      pid: process.pid,
      url: server.url,
      hookToken,
      startedAt: new Date().toISOString(),
    })
    console.log(`Agent Trajectory: ${server.url}`)
    if (!arguments_.noOpen) show()

    await new Promise<void>((resolve, reject) => {
      let closing = false
      const close = () => {
        if (closing) return
        closing = true
        void server!.close()
          .then(() => removeRuntimeState(arguments_.dataRoot, process.pid))
          .then(resolve, reject)
      }
      process.once('SIGINT', close)
      process.once('SIGTERM', close)
    })
  } finally {
    await lock.release()
  }
}

function statusLine(status: SourceStatus, sourcePath: string): string {
  const state = status.availability.padEnd(9)
  const sessions = `${status.sessionCount} sessions`.padEnd(13)
  return `${status.source.padEnd(6)} ${state} ${sessions} ${sourcePath}${
    status.detail === undefined ? '' : `\n       ${status.detail}`}`
}

function hookLocations(paths: ResolvedSourcePaths): HookInstallLocations {
  return {
    codexHome: paths.codexHome,
    dshHome: path.resolve(process.env.DSH_HOME ?? path.join(homedir(), '.dsh')),
    zcodeHome: path.resolve(process.env.ZCODE_HOME ?? path.join(homedir(), '.zcode')),
  }
}

async function doctor(arguments_: CliArguments): Promise<void> {
  configureWorkerLocations()
  const paths = await resolvedPaths(arguments_)
  const registry = createSourceRegistry(paths)
  try {
    const statuses = await registry.listSources(true)
    const bySource: Record<SourceId, string> = {
      codex: paths.codexSessionsDir,
      dsh: paths.dshSessionsDir,
      zcode: paths.zcodeDatabase,
    }
    for (const status of statuses) {
      console.log(statusLine(status, bySource[status.source]))
    }
  } finally {
    await registry.close()
  }
  const hookIssues: string[] = []
  try {
    const [installation, installedHooks] = await Promise.all([
      readHookInstallation(arguments_.dataRoot),
      installedAgentHooks(hookLocations(paths)),
    ])
    if (installation === undefined && installedHooks.length > 0) {
      hookIssues.push('Hook installation record is missing')
      hookIssues.push(`Detected installed Hooks: ${installedHooks.join(', ')}`)
    } else if (installation !== undefined) {
      const missingHooks = (['codex', 'zcode', 'dsh'] as const)
        .filter(source => !installedHooks.includes(source))
      if (missingHooks.length > 0) {
        hookIssues.push(`Installed Hook entries are missing: ${missingHooks.join(', ')}`)
      }
      const expectedRuntime = path.join(
        arguments_.dataRoot,
        'runtime',
        'agent-trajectory.mjs',
      )
      if (installation.platform !== process.platform) {
        hookIssues.push(
          `Platform changed: installed ${installation.platform}, current ${process.platform}`,
        )
      }
      if (path.resolve(installation.nodeExecutable) !== path.resolve(process.execPath)) {
        hookIssues.push(
          `Node executable changed: installed ${installation.nodeExecutable}, current ${process.execPath}`,
        )
      }
      if (path.resolve(installation.runtimeFile) !== path.resolve(expectedRuntime)) {
        hookIssues.push(
          `Hook runtime location changed: installed ${installation.runtimeFile}, current ${expectedRuntime}`,
        )
      }
      if (path.resolve(installation.dataRoot) !== path.resolve(arguments_.dataRoot)) {
        hookIssues.push(
          `Data directory changed: installed ${installation.dataRoot}, current ${arguments_.dataRoot}`,
        )
      }
      if (installation.packageVersion !== packageMetadata.version) {
        hookIssues.push(
          `Package version changed: installed ${installation.packageVersion}, current ${packageMetadata.version}`,
        )
      }
      try {
        await fs.access(installation.nodeExecutable)
      } catch {
        hookIssues.push(`Node executable is missing: ${installation.nodeExecutable}`)
      }
      try {
        await fs.access(installation.runtimeFile)
      } catch {
        hookIssues.push(`Hook runtime is missing: ${installation.runtimeFile}`)
      }
    }
  } catch (error) {
    hookIssues.push(
      `Hook installation record is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (hookIssues.length > 0) {
    const quotedDataRoot = process.platform === 'win32'
      ? `"${arguments_.dataRoot.replaceAll('"', '""').replaceAll('%', '%%')}"`
      : `'${arguments_.dataRoot.replaceAll("'", "'\"'\"'")}'`
    console.log([
      'hooks  stale',
      ...hookIssues.map(issue => `       ${issue}`),
      `       Repair: agent-trajectory install-hooks --data-dir ${quotedDataRoot}`,
    ].join('\n'))
  }
}

async function setup(arguments_: CliArguments): Promise<void> {
  const current = await readConfig(arguments_.dataRoot)
  let next: SourcePathOverrides = {
    ...current.sources,
    ...arguments_.sourcePaths,
  }
  if (input.isTTY && Object.keys(arguments_.sourcePaths).length === 0) {
    const defaults = resolveSourcePaths({
      config: current.sources,
      configDirectory: arguments_.dataRoot,
    })
    const prompt = createInterface({ input, output })
    try {
      const ask = async (label: string, fallback: string): Promise<string> =>
        (await prompt.question(`${label} [${fallback}]: `)).trim() || fallback
      next = {
        dshSessionsDir: portablePath(await ask('DSH sessions', defaults.dshSessionsDir)),
        codexHome: portablePath(await ask('Codex home', defaults.codexHome)),
        codexSessionsDir: portablePath(
          await ask('Codex sessions', defaults.codexSessionsDir),
        ),
        zcodeDatabase: portablePath(await ask('ZCode database', defaults.zcodeDatabase)),
      }
    } finally {
      prompt.close()
    }
  }
  const file = await writeConfig(arguments_.dataRoot, next)
  console.log(`Saved source configuration: ${file}`)
  await doctor({ ...arguments_, sourcePaths: {} })
}

async function updateHooks(
  arguments_: CliArguments,
  remove: boolean,
): Promise<void> {
  const paths = await resolvedPaths(arguments_)
  const runtimeRoot = path.join(arguments_.dataRoot, 'runtime')
  const sourceRuntime = path.resolve(process.argv[1]!) === path.resolve(
    path.join(runtimeRoot, 'agent-trajectory.mjs'),
  )
    ? runtimeRoot
    : distributionRoot
  if (!remove && sourceRuntime !== runtimeRoot) {
    const temporary = `${runtimeRoot}.${process.pid}.tmp`
    await fs.rm(temporary, { recursive: true, force: true })
    await fs.cp(sourceRuntime, temporary, { recursive: true })
    await fs.rm(runtimeRoot, { recursive: true, force: true })
    await fs.rename(temporary, runtimeRoot)
  }
  const locations = hookLocations(paths)
  const results = remove
    ? await uninstallAgentHooks(locations, arguments_.dataRoot)
    : await installAgentHooks(
        locations,
        process.execPath,
        path.join(runtimeRoot, 'agent-trajectory.mjs'),
        arguments_.dataRoot,
        process.platform,
        { packageVersion: packageMetadata.version },
      )
  for (const result of results) {
    console.log(`${result.source.padEnd(6)} ${result.action.padEnd(9)} ${result.file}`)
  }
  if (!remove) {
    console.log('Restart DSH and ZCode, and review/trust the new Codex hook with /hooks.')
  } else {
    await fs.rm(runtimeRoot, { recursive: true, force: true })
  }
}

export async function runCli(arguments_ = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArguments(arguments_)
  if (parsed.command === 'start') await start(parsed)
  else if (parsed.command === 'doctor') await doctor(parsed)
  else if (parsed.command === 'setup') await setup(parsed)
  else if (parsed.command === 'install-hooks') await updateHooks(parsed, false)
  else if (parsed.command === 'uninstall-hooks') await updateHooks(parsed, true)
  else if (parsed.command === 'open') {
    await forwardHook(parsed, {
      hook_event_name: 'SessionStart',
      session_id: parsed.sessionId,
      session_start_source: 'startup',
    })
  } else {
    await forwardHook(parsed, await hookPayload())
  }
}
