import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SourceId } from '../src/types'

const COMMAND_MARKER = 'AGENT_TRAJECTORY_HOOK=1'
const DSH_BLOCK_START = '# >>> Agent Trajectory session hook >>>'
const DSH_BLOCK_END = '# <<< Agent Trajectory session hook <<<'
const HOOK_INSTALLATION_VERSION = 1

export interface HookInstallLocations {
  codexHome: string
  dshHome: string
  zcodeHome: string
}

export interface HookInstallResult {
  action: 'installed' | 'removed' | 'unchanged'
  file: string
  source: SourceId
}

export interface HookInstallationMetadata {
  installedAt?: string
  packageVersion: string
}

export interface HookInstallation {
  version: number
  packageVersion: string
  platform: NodeJS.Platform
  nodeExecutable: string
  runtimeFile: string
  dataRoot: string
  installedAt: string
}

type JsonObject = Record<string, unknown>

export function hookInstallationFile(dataRoot: string): string {
  return path.join(dataRoot, 'hook-installation.json')
}

export async function pruneHookRuntimeDirectories(
  runtimeBase: string,
  currentRuntime: string,
  keep = 2,
): Promise<string[]> {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error('Hook runtime retention must be a positive integer')
  }
  const base = path.resolve(runtimeBase)
  const current = path.resolve(currentRuntime)
  if (!current.startsWith(`${base}${path.sep}`)) {
    throw new Error('current Hook runtime must be inside the managed runtime directory')
  }
  const entries = await fs.readdir(base, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
  const runtimes = (await Promise.all(entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(async (entry) => {
      const directory = path.join(base, entry.name)
      const executable = path.join(directory, 'agent-trajectory.mjs')
      try {
        const [directoryStat, executableStat] = await Promise.all([
          fs.stat(directory),
          fs.stat(executable),
        ])
        return executableStat.isFile()
          ? { directory, mtimeMs: directoryStat.mtimeMs }
          : undefined
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    }))).filter((entry): entry is {
      directory: string
      mtimeMs: number
    } => entry !== undefined)
  runtimes.sort((left, right) =>
    Number(right.directory === current) - Number(left.directory === current)
    || right.mtimeMs - left.mtimeMs
    || right.directory.localeCompare(left.directory))
  const retained = new Set(runtimes.slice(0, keep).map(entry => entry.directory))
  retained.add(current)
  const removed = runtimes
    .filter(entry => !retained.has(entry.directory))
    .map(entry => entry.directory)
  await Promise.all(removed.map(directory =>
    fs.rm(directory, { recursive: true, force: true })))
  return removed
}

function storedHookInstallation(value: unknown): HookInstallation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid Hook installation record: expected an object')
  }
  const source = value as Record<string, unknown>
  if (source.version !== HOOK_INSTALLATION_VERSION) {
    throw new Error(
      `unsupported Hook installation record version: ${String(source.version)}`,
    )
  }
  if (typeof source.packageVersion !== 'string'
    || typeof source.platform !== 'string'
    || typeof source.nodeExecutable !== 'string'
    || typeof source.runtimeFile !== 'string'
    || typeof source.dataRoot !== 'string'
    || typeof source.installedAt !== 'string') {
    throw new Error('invalid Hook installation record')
  }
  return {
    version: HOOK_INSTALLATION_VERSION,
    packageVersion: source.packageVersion,
    platform: source.platform as NodeJS.Platform,
    nodeExecutable: source.nodeExecutable,
    runtimeFile: source.runtimeFile,
    dataRoot: source.dataRoot,
    installedAt: source.installedAt,
  }
}

export async function readHookInstallation(
  dataRoot: string,
): Promise<HookInstallation | undefined> {
  try {
    return storedHookInstallation(JSON.parse(
      await fs.readFile(hookInstallationFile(dataRoot), 'utf8'),
    ))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function installedAgentHooks(
  locations: HookInstallLocations,
): Promise<SourceId[]> {
  const [codex, zcode, dshPatch, dshPlugin] = await Promise.all([
    readJson(path.join(locations.codexHome, 'hooks.json')),
    readJson(path.join(locations.zcodeHome, 'cli', 'config.json')),
    fs.readFile(
      path.join(locations.dshHome, 'profiles', 'desktop', 'cordis.patch.yml'),
      'utf8',
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    }),
    fs.access(path.join(locations.dshHome, 'agent-trajectory-plugin.mjs'))
      .then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false
        throw error
      }),
  ])
  const codexInstalled = hasTrajectoryGroup(object(codex.hooks).SessionStart)
  const zcodeInstalled = hasTrajectoryGroup(
    object(object(zcode.hooks).events).SessionStart,
  )
  const dshInstalled = dshPlugin
    || (dshPatch.includes(DSH_BLOCK_START) && dshPatch.includes(DSH_BLOCK_END))
  return [
    ...(codexInstalled ? ['codex' as const] : []),
    ...(zcodeInstalled ? ['zcode' as const] : []),
    ...(dshInstalled ? ['dsh' as const] : []),
  ]
}

function shellCommand(
  nodeExecutable: string,
  cliFile: string,
  dataRoot: string,
  source: SourceId,
  platform: NodeJS.Platform,
): string {
  const quoted = platform === 'win32'
    ? (value: string) => `"${value.replaceAll('"', '""').replaceAll('%', '%%')}"`
    : (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`
  const command = [
    quoted(nodeExecutable),
    quoted(cliFile),
    'hook',
    source,
    '--data-dir',
    quoted(dataRoot),
  ].join(' ')
  return platform === 'win32'
    ? `set "${COMMAND_MARKER}"&&${command}`
    : `${COMMAND_MARKER} ${command}`
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

async function readJson(file: string): Promise<JsonObject> {
  try {
    return object(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await fs.writeFile(temporary, contents, { mode: 0o600 })
  await fs.rename(temporary, file)
}

interface FileSnapshot {
  contents?: Buffer
  file: string
  mode?: number
}

async function snapshotFile(file: string): Promise<FileSnapshot> {
  try {
    const [contents, stat] = await Promise.all([
      fs.readFile(file),
      fs.stat(file),
    ])
    return { contents, file, mode: stat.mode & 0o777 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file }
    throw error
  }
}

async function restoreFile(snapshot: FileSnapshot): Promise<void> {
  if (snapshot.contents === undefined) {
    await fs.rm(snapshot.file, { force: true })
    return
  }
  await fs.mkdir(path.dirname(snapshot.file), { recursive: true })
  const temporary = `${snapshot.file}.${process.pid}.rollback.tmp`
  await fs.writeFile(temporary, snapshot.contents, {
    mode: snapshot.mode ?? 0o600,
  })
  await fs.rename(temporary, snapshot.file)
  if (process.platform !== 'win32' && snapshot.mode !== undefined) {
    await fs.chmod(snapshot.file, snapshot.mode)
  }
}

async function withFileTransaction<T>(
  files: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const snapshots = await Promise.all([...new Set(files)].map(snapshotFile))
  try {
    return await operation()
  } catch (error) {
    const restored = await Promise.allSettled(
      [...snapshots].reverse().map(restoreFile),
    )
    const failures = restored.flatMap(result =>
      result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) {
      throw new AggregateError(
        [error, ...failures],
        `Hook transaction failed and rollback was incomplete: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    throw error
  }
}

async function writeHookInstallation(
  installation: HookInstallation,
): Promise<void> {
  await atomicWrite(
    hookInstallationFile(installation.dataRoot),
    `${JSON.stringify(installation, null, 2)}\n`,
  )
}

async function backupOnce(file: string): Promise<void> {
  const backup = `${file}.agent-trajectory.bak`
  try {
    await fs.access(backup)
    return
  } catch {}
  try {
    await fs.copyFile(file, backup)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function isTrajectoryHandler(value: unknown): boolean {
  const handler = object(value)
  return typeof handler.command === 'string'
    && handler.command.includes(COMMAND_MARKER)
}

function withoutTrajectoryGroups(value: unknown): unknown[] {
  return Array.isArray(value)
    ? value.flatMap((candidate) => {
        const group = object(candidate)
        const hooks = Array.isArray(group.hooks)
          ? group.hooks.filter(handler => !isTrajectoryHandler(handler))
          : []
        return hooks.length === 0 ? [] : [{ ...group, hooks }]
      })
    : []
}

function hasTrajectoryGroup(value: unknown): boolean {
  return Array.isArray(value) && value.some((candidate) => {
    const hooks = object(candidate).hooks
    return Array.isArray(hooks) && hooks.some(isTrajectoryHandler)
  })
}

async function updateJsonHooks(
  file: string,
  source: 'codex' | 'zcode',
  command: string,
  remove: boolean,
): Promise<HookInstallResult> {
  const before = await readJson(file)
  const hooks = source === 'zcode'
    ? object(before.hooks)
    : before
  const events = source === 'zcode'
    ? object(hooks.events)
    : object(hooks.hooks)
  const hasInstalledHook = hasTrajectoryGroup(events.SessionStart)
  if (remove && !hasInstalledHook) {
    return { source, file, action: 'unchanged' }
  }
  const current = withoutTrajectoryGroups(events.SessionStart)
  const nextEvents = { ...events }
  if (remove) {
    if (current.length === 0) delete nextEvents.SessionStart
    else nextEvents.SessionStart = current
  } else {
    nextEvents.SessionStart = [
      ...current,
      {
        matcher: source === 'codex' ? 'startup|resume|fork' : '*',
        hooks: [{
          type: 'command',
          command,
          ...(source === 'zcode' ? { timeoutMs: 5_000 } : { async: true, timeout: 5 }),
        }],
      },
    ]
  }
  const next = source === 'zcode'
    ? {
        ...before,
        hooks: {
          ...hooks,
          events: nextEvents,
          enabled: true,
        },
      }
    : {
        ...before,
        hooks: nextEvents,
      }
  const beforeText = `${JSON.stringify(before, null, 2)}\n`
  const nextText = `${JSON.stringify(next, null, 2)}\n`
  if (beforeText === nextText) return { source, file, action: 'unchanged' }
  await backupOnce(file)
  await atomicWrite(file, nextText)
  return { source, file, action: remove ? 'removed' : 'installed' }
}

function dshPlugin(
  nodeExecutable: string,
  cliFile: string,
  dataRoot: string,
): string {
  return `// Generated by Agent Trajectory. Reinstalling replaces this file.
import { spawn } from 'node:child_process'

const executable = ${JSON.stringify(nodeExecutable)}
const args = ${JSON.stringify([cliFile, 'hook', 'dsh', '--data-dir', dataRoot])}
export const name = 'agent-trajectory-session-hook'

function fire(ctx, agent, source) {
  try {
    const header = agent && agent.session && agent.session.header
    if (!header || header.origin === 'subagent' || header.parentSession) return
    const persistence = ctx.get('sessionPersistence')
    const located = persistence && persistence.locate
      ? persistence.locate(header)
      : undefined
    const payload = JSON.stringify({
      session_id: header.id || '',
      hook_event_name: 'SessionStart',
      session_start_source: source,
      cwd: header.cwd || process.cwd(),
      transcript_path: located && located.path || '',
    })
    const child = spawn(executable, args, {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, AGENT_TRAJECTORY_HOOK: '1' },
    })
    child.on('error', () => {})
    child.stdin.on('error', () => {})
    child.stdin.end(payload)
    child.unref()
  } catch {}
}

export function apply(ctx) {
  ctx.on('agent/session-start', ({ agent, source }) => fire(ctx, agent, source))
}
`
}

function replaceDshBlock(contents: string, block: string | undefined): string {
  const start = contents.indexOf(DSH_BLOCK_START)
  const end = contents.indexOf(DSH_BLOCK_END)
  let base = start >= 0 && end >= start
    ? `${contents.slice(0, start)}${contents.slice(end + DSH_BLOCK_END.length)}`
    : contents
  base = base.trimEnd()
  return block === undefined
    ? `${base}\n`
    : `${base}\n\n${block}\n`
}

async function updateDshHook(
  dshHome: string,
  runtime: {
    nodeExecutable: string
    cliFile: string
    dataRoot: string
  } | undefined,
  remove: boolean,
): Promise<HookInstallResult> {
  const plugin = path.join(dshHome, 'agent-trajectory-plugin.mjs')
  const patch = path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml')
  let current = ''
  try {
    current = await fs.readFile(patch, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const block = remove
    ? undefined
    : `${DSH_BLOCK_START}
- insert:
    - id: agent-trajectory-session-hook
      name: ${JSON.stringify(plugin)}
${DSH_BLOCK_END}`
  const next = replaceDshBlock(current, block)
  const pluginExists = await fs.access(plugin).then(() => true, () => false)
  const hasBlock = current.includes(DSH_BLOCK_START)
    && current.includes(DSH_BLOCK_END)
  if (remove) {
    if (!hasBlock && !pluginExists) {
      return { source: 'dsh', file: patch, action: 'unchanged' }
    }
    await backupOnce(patch)
    await atomicWrite(patch, next)
    await fs.rm(plugin, { force: true })
    return { source: 'dsh', file: patch, action: 'removed' }
  }
  await backupOnce(patch)
  await Promise.all([
    atomicWrite(patch, next),
    atomicWrite(plugin, dshPlugin(
      runtime!.nodeExecutable,
      runtime!.cliFile,
      runtime!.dataRoot,
    )),
  ])
  return { source: 'dsh', file: patch, action: 'installed' }
}

export async function installAgentHooks(
  locations: HookInstallLocations,
  nodeExecutable: string,
  cliFile: string,
  dataRoot: string,
  platform: NodeJS.Platform = process.platform,
  metadata: HookInstallationMetadata = { packageVersion: 'unknown' },
): Promise<HookInstallResult[]> {
  const codexFile = path.join(locations.codexHome, 'hooks.json')
  const zcodeFile = path.join(locations.zcodeHome, 'cli', 'config.json')
  const dshPatch = path.join(locations.dshHome, 'profiles', 'desktop', 'cordis.patch.yml')
  const dshPlugin = path.join(locations.dshHome, 'agent-trajectory-plugin.mjs')
  const installationFile = hookInstallationFile(dataRoot)
  return withFileTransaction([
    codexFile,
    `${codexFile}.agent-trajectory.bak`,
    zcodeFile,
    `${zcodeFile}.agent-trajectory.bak`,
    dshPatch,
    `${dshPatch}.agent-trajectory.bak`,
    dshPlugin,
    installationFile,
  ], async () => {
    const results = [
      await updateJsonHooks(
        codexFile,
        'codex',
        shellCommand(nodeExecutable, cliFile, dataRoot, 'codex', platform),
        false,
      ),
      await updateJsonHooks(
        zcodeFile,
        'zcode',
        shellCommand(nodeExecutable, cliFile, dataRoot, 'zcode', platform),
        false,
      ),
      await updateDshHook(
        locations.dshHome,
        { nodeExecutable, cliFile, dataRoot },
        false,
      ),
    ]
    await writeHookInstallation({
      version: HOOK_INSTALLATION_VERSION,
      packageVersion: metadata.packageVersion,
      platform,
      nodeExecutable,
      runtimeFile: cliFile,
      dataRoot,
      installedAt: metadata.installedAt ?? new Date().toISOString(),
    })
    return results
  })
}

export async function uninstallAgentHooks(
  locations: HookInstallLocations,
  dataRoot?: string,
): Promise<HookInstallResult[]> {
  const codexFile = path.join(locations.codexHome, 'hooks.json')
  const zcodeFile = path.join(locations.zcodeHome, 'cli', 'config.json')
  const dshPatch = path.join(locations.dshHome, 'profiles', 'desktop', 'cordis.patch.yml')
  const dshPlugin = path.join(locations.dshHome, 'agent-trajectory-plugin.mjs')
  const installationFile = dataRoot === undefined
    ? undefined
    : hookInstallationFile(dataRoot)
  return withFileTransaction([
    codexFile,
    `${codexFile}.agent-trajectory.bak`,
    zcodeFile,
    `${zcodeFile}.agent-trajectory.bak`,
    dshPatch,
    `${dshPatch}.agent-trajectory.bak`,
    dshPlugin,
    ...(installationFile === undefined ? [] : [installationFile]),
  ], async () => {
    const results = [
      await updateJsonHooks(codexFile, 'codex', '', true),
      await updateJsonHooks(zcodeFile, 'zcode', '', true),
      await updateDshHook(locations.dshHome, undefined, true),
    ]
    if (installationFile !== undefined) {
      await fs.rm(installationFile, { force: true })
    }
    return results
  })
}
