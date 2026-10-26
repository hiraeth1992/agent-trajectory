import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const CONFIG_VERSION = 1

export interface SourcePathOverrides {
  claudeProjectsDir?: string
  codexHome?: string
  codexSessionsDir?: string
  doubaoWorkSessionsDir?: string
  dshSessionsDir?: string
  openCodeDatabase?: string
  qoderProjectsDir?: string
  workbuddyHome?: string
  zcodeDatabase?: string
}

export interface AgentTrajectoryConfig {
  version: number
  sources: SourcePathOverrides
}

export interface ResolvedSourcePaths {
  claudeProjectsDir: string
  codexHome: string
  codexSessionIndex: string
  codexSessionsDir: string
  doubaoWorkSessionsDir: string
  dshSessionsDir: string
  openCodeDatabase: string
  qoderProjectsDir: string
  workbuddyDatabase: string
  workbuddyHome: string
  workbuddyProjectsDir: string
  zcodeDatabase: string
}

export interface SourcePathResolutionOptions {
  cli?: SourcePathOverrides
  config?: SourcePathOverrides
  configDirectory: string
  environment?: NodeJS.ProcessEnv
  homeDirectory?: string
}

function configuredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined
}

function normalizedOverrides(value: unknown): SourcePathOverrides {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  const entries = [
    ['claudeProjectsDir', configuredString(source.claudeProjectsDir)],
    ['codexHome', configuredString(source.codexHome)],
    ['codexSessionsDir', configuredString(source.codexSessionsDir)],
    ['doubaoWorkSessionsDir', configuredString(source.doubaoWorkSessionsDir)],
    ['dshSessionsDir', configuredString(source.dshSessionsDir)],
    ['openCodeDatabase', configuredString(source.openCodeDatabase)],
    ['qoderProjectsDir', configuredString(source.qoderProjectsDir)],
    ['workbuddyHome', configuredString(source.workbuddyHome)],
    ['zcodeDatabase', configuredString(source.zcodeDatabase)],
  ] as const
  return Object.fromEntries(entries.filter((entry): entry is [
    typeof entry[0],
    string,
  ] => entry[1] !== undefined))
}

function storedConfig(value: unknown): AgentTrajectoryConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid source paths config: expected an object')
  }
  const source = value as Record<string, unknown>
  if (!Number.isInteger(source.version) || (source.version as number) < 1) {
    throw new Error('invalid source paths config version')
  }
  const version = source.version as number
  if (version > CONFIG_VERSION) {
    throw new Error(
      `source paths config version ${version} is newer than supported version ${CONFIG_VERSION}`,
    )
  }
  if (version < CONFIG_VERSION) {
    throw new Error(
      `source paths config version ${version} requires migration to version ${CONFIG_VERSION}`,
    )
  }
  return {
    version: CONFIG_VERSION,
    sources: normalizedOverrides(source.sources),
  }
}

function expandPath(
  value: string,
  homeDirectory: string,
  configDirectory: string,
): string {
  const expanded = value
    .replaceAll('${HOME}', homeDirectory)
    .replaceAll('${CONFIG_DIR}', configDirectory)
  const withHome = expanded === '~'
    ? homeDirectory
    : expanded.startsWith(`~${path.sep}`)
      ? path.join(homeDirectory, expanded.slice(2))
      : expanded
  return path.resolve(configDirectory, withHome)
}

function selected(
  cli: string | undefined,
  config: string | undefined,
  environment: string | undefined,
  fallback: string,
): string {
  return cli ?? config ?? environment ?? fallback
}

export function defaultDataRoot(homeDirectory = homedir()): string {
  return path.join(homeDirectory, '.agent-trajectory')
}

export function configFile(dataRoot: string): string {
  return path.join(dataRoot, 'config-v1.json')
}

export async function readConfig(dataRoot: string): Promise<AgentTrajectoryConfig> {
  try {
    const parsed = JSON.parse(await fs.readFile(configFile(dataRoot), 'utf8')) as unknown
    return storedConfig(parsed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { version: CONFIG_VERSION, sources: {} }
  }
}

export async function writeConfig(
  dataRoot: string,
  sources: SourcePathOverrides,
): Promise<string> {
  const file = configFile(dataRoot)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  const value: AgentTrajectoryConfig = {
    version: CONFIG_VERSION,
    sources: normalizedOverrides(sources),
  }
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  })
  await fs.rename(temporary, file)
  return file
}

export function portablePath(
  value: string,
  homeDirectory = homedir(),
): string {
  const absolute = path.resolve(value)
  return absolute === homeDirectory
    ? '${HOME}'
    : absolute.startsWith(`${homeDirectory}${path.sep}`)
      ? `\${HOME}${path.sep}${path.relative(homeDirectory, absolute)}`
      : absolute
}

export function resolveSourcePaths(
  options: SourcePathResolutionOptions,
): ResolvedSourcePaths {
  const homeDirectory = path.resolve(options.homeDirectory ?? homedir())
  const configDirectory = path.resolve(options.configDirectory)
  const environment = options.environment ?? process.env
  const cli = normalizedOverrides(options.cli)
  const config = normalizedOverrides(options.config)
  const codexHome = expandPath(selected(
    cli.codexHome,
    config.codexHome,
    configuredString(environment.CODEX_HOME),
    path.join(homeDirectory, '.codex'),
  ), homeDirectory, configDirectory)
  const codexSessionsDir = expandPath(selected(
    cli.codexSessionsDir,
    config.codexSessionsDir,
    configuredString(environment.CODEX_SESSIONS_DIR),
    path.join(codexHome, 'sessions'),
  ), homeDirectory, configDirectory)
  const workbuddyHome = expandPath(selected(
    cli.workbuddyHome,
    config.workbuddyHome,
    configuredString(environment.WORKBUDDY_HOME),
    path.join(homeDirectory, '.workbuddy'),
  ), homeDirectory, configDirectory)
  return {
    claudeProjectsDir: expandPath(selected(
      cli.claudeProjectsDir,
      config.claudeProjectsDir,
      configuredString(environment.CLAUDE_PROJECTS_DIR),
      path.join(homeDirectory, '.claude', 'projects'),
    ), homeDirectory, configDirectory),
    codexHome,
    codexSessionIndex: path.join(codexHome, 'session_index.jsonl'),
    codexSessionsDir,
    doubaoWorkSessionsDir: expandPath(selected(
      cli.doubaoWorkSessionsDir,
      config.doubaoWorkSessionsDir,
      configuredString(environment.DOUBAO_WORK_SESSIONS_DIR),
      path.join(
        homeDirectory,
        'Library',
        'Application Support',
        'DoubaoWork',
        'Default',
        '.doubaowork',
        'agent_mode',
        'workspace',
        '.sessions',
      ),
    ), homeDirectory, configDirectory),
    dshSessionsDir: expandPath(selected(
      cli.dshSessionsDir,
      config.dshSessionsDir,
      configuredString(environment.DSH_SESSIONS_DIR),
      path.join(homeDirectory, '.dsh', 'sessions'),
    ), homeDirectory, configDirectory),
    openCodeDatabase: expandPath(selected(
      cli.openCodeDatabase,
      config.openCodeDatabase,
      configuredString(environment.OPENCODE_DB),
      path.join(homeDirectory, '.local', 'share', 'opencode', 'opencode.db'),
    ), homeDirectory, configDirectory),
    qoderProjectsDir: expandPath(selected(
      cli.qoderProjectsDir,
      config.qoderProjectsDir,
      configuredString(environment.QODER_PROJECTS_DIR),
      path.join(homeDirectory, '.qoder-cn', 'projects'),
    ), homeDirectory, configDirectory),
    workbuddyDatabase: path.join(workbuddyHome, 'workbuddy.db'),
    workbuddyHome,
    workbuddyProjectsDir: path.join(workbuddyHome, 'projects'),
    zcodeDatabase: expandPath(selected(
      cli.zcodeDatabase,
      config.zcodeDatabase,
      configuredString(environment.ZCODE_DB),
      path.join(homeDirectory, '.zcode', 'cli', 'db', 'db.sqlite'),
    ), homeDirectory, configDirectory),
  }
}
