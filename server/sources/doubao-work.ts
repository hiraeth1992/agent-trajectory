import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { readJsonlRows } from '../parsers/jsonl'
import { fileStatSignature, mapConcurrent } from './file-index'
import type {
  DoubaoWorkAgentInput,
  DoubaoWorkProjectionInput,
  DoubaoWorkRow,
} from '../projectors/doubao-work'
import {
  ProjectionWorkerClient,
  projectionWorker as defaultProjectionWorker,
} from '../projection-worker-client'
import type {
  SessionDetail,
  SessionSummary,
  SourceStatus,
} from '../../src/types'
import {
  capabilities,
  completeAudit,
  sessionKey,
  sourceMetadata,
  type SourceListResult,
  type SessionSource,
  type SourceSessionRef,
} from './types'

const DOUBAO_WORK_CAPABILITIES = capabilities(
  'messages',
  'tools',
  'live',
  'attachments',
  'lineage',
)

export const doubaoWorkSessionsRoot = path.resolve(
  process.env.DOUBAO_WORK_SESSIONS_DIR
    ?? path.join(
      homedir(),
      'Library',
      'Application Support',
      'DoubaoWork',
      'Default',
      '.doubaowork',
      'agent_mode',
      'workspace',
      '.sessions',
    ),
)

interface DoubaoWorkSourceOptions {
  sessionsRoot?: string
  projectionWorker?: ProjectionWorkerClient
}

interface SessionFiles {
  sessionId: string
  directory: string
  files: string[]
}

async function sessionFiles(
  directory: string,
  sessionId = path.basename(directory),
): Promise<SessionFiles | undefined> {
  const agents = path.join(directory, 'agents')
  let entries
  try {
    entries = await fs.readdir(agents, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const files = entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(agents, entry.name, 'system', 'trajectory.jsonl'))
  const present = (await Promise.all(files.map(async file => {
    try {
      return (await fs.stat(file)).isFile() ? file : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }))).filter((file): file is string => file !== undefined)
  return present.length === 0
    ? undefined
    : { sessionId, directory, files: present.sort() }
}

function assertRef(ref: SourceSessionRef, root: string): string[] {
  if (ref.source !== 'doubao-work') {
    throw new Error('invalid Doubao Work session reference')
  }
  const sessionDirectory = path.resolve(root, ref.sourceSessionId)
  const files = [...new Set(ref.locators ?? [ref.locator])]
    .map(file => path.resolve(file))
  if (!sessionDirectory.startsWith(`${root}${path.sep}`)
    || files.length === 0
    || files.some(file =>
      !file.startsWith(`${sessionDirectory}${path.sep}agents${path.sep}`)
      || path.basename(file) !== 'trajectory.jsonl')) {
    throw new Error('invalid Doubao Work session locator')
  }
  return files
}

async function currentFiles(
  ref: SourceSessionRef,
  root: string,
): Promise<readonly string[]> {
  assertRef(ref, root)
  const session = await sessionFiles(
    path.resolve(root, ref.sourceSessionId),
    ref.sourceSessionId,
  )
  if (session === undefined) {
    throw new Error('Doubao Work session has no agent trajectories')
  }
  return session.files
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [entry]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return []
    const text = (entry as Record<string, unknown>).text
    return typeof text === 'string' ? [text] : []
  }).join('\n')
}

function titleFor(agents: readonly DoubaoWorkAgentInput[], sessionId: string): string {
  const ordered = [...agents].sort((left, right) =>
    Number(!left.agentId.startsWith('m_')) - Number(!right.agentId.startsWith('m_'))
    || left.agentId.localeCompare(right.agentId))
  for (const agent of ordered) {
    const row = agent.rows.find(candidate =>
      candidate.role === 'user' && contentText(candidate.content).trim() !== '')
    const title = contentText(row?.content).replace(/\s+/g, ' ').trim()
    if (title !== '') return title.length > 64 ? `${title.slice(0, 63)}…` : title
  }
  return `豆包工作 · ${sessionId.slice(-8)}`
}

async function readAgents(files: readonly string[]): Promise<DoubaoWorkAgentInput[]> {
  return Promise.all(files.map(async file => ({
    agentId: path.basename(path.dirname(path.dirname(file))),
    rows: (await readJsonlRows<DoubaoWorkRow>(file)).map(row => row.value),
  })))
}

export class DoubaoWorkSource implements SessionSource {
  readonly id = 'doubao-work' as const
  private readonly sessionsRoot: string
  private readonly projectionWorker: ProjectionWorkerClient
  private readonly discoveryCache = new Map<string, {
    signature: string
    ref: SourceSessionRef
  }>()

  constructor(options: DoubaoWorkSourceOptions = {}) {
    this.sessionsRoot = path.resolve(options.sessionsRoot ?? doubaoWorkSessionsRoot)
    this.projectionWorker = options.projectionWorker ?? defaultProjectionWorker
  }

  async probe(): Promise<SourceStatus> {
    try {
      await fs.access(this.sessionsRoot)
      return {
        source: this.id,
        availability: 'degraded',
        ...sourceMetadata(this.id),
        sessionCount: 0,
        capabilities: DOUBAO_WORK_CAPABILITIES,
        reason: 'event_metrics_unavailable',
        detail: '可读取消息、工具和多 Agent 关系；本地协议不提供逐事件时间与 Token 用量',
        protocol: {
          detected: 'doubao-work-agent-trajectory-jsonl',
          supported: ['doubao-work-agent-trajectory-jsonl'],
          fingerprint: 'doubao-work:sessions:agents:trajectory-jsonl',
        },
      }
    } catch {
      return {
        source: this.id,
        availability: 'blocked',
        ...sourceMetadata(this.id),
        sessionCount: 0,
        capabilities: DOUBAO_WORK_CAPABILITIES,
        reason: 'sessions_directory_missing',
        detail: '未找到豆包工作 Agent 会话目录',
      }
    }
  }

  async list(): Promise<readonly SourceSessionRef[]> {
    return (await this.listDetailed()).refs
  }

  async listDetailed(): Promise<SourceListResult> {
    let entries
    try {
      entries = await fs.readdir(this.sessionsRoot, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          refs: [],
          diagnostics: { scanned: 0, loaded: 0, failed: 0, failures: [] },
        }
      }
      throw error
    }
    const directories = entries
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(this.sessionsRoot, entry.name))
    const settled = await mapConcurrent(directories, 12, async directory => {
      const session = await sessionFiles(directory, path.basename(directory))
      if (session === undefined) return undefined
      const [sessionStat, fileStats] = await Promise.all([
        fs.stat(session.directory),
        mapConcurrent(session.files, 16, file => fs.stat(file)),
      ])
      const failed = fileStats.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      const stats = fileStats.map(result =>
        (result as PromiseFulfilledResult<
          Awaited<ReturnType<typeof fs.stat>>
        >).value)
      const signature = [
        fileStatSignature(sessionStat),
        ...stats.map((stat, index) =>
          `${path.relative(this.sessionsRoot, session.files[index]!)}:${
            fileStatSignature(stat)
          }`),
      ].join('|')
      const cached = this.discoveryCache.get(session.sessionId)
      if (cached?.signature === signature) return cached.ref
      const agents = await readAgents(session.files)
      const createdAt = Number(sessionStat.birthtimeMs || sessionStat.mtimeMs)
      const updatedAt = Math.max(...stats.map(stat => Number(stat.mtimeMs)))
      const eventCount = agents.reduce((total, agent) => total + agent.rows.length, 0)
      const summary: SessionSummary = {
        id: sessionKey(this.id, session.sessionId),
        source: this.id,
        sourceSessionId: session.sessionId,
        format: 'doubao-work-agent-trajectory-jsonl',
        capabilities: DOUBAO_WORK_CAPABILITIES,
        cwd: '',
        title: titleFor(agents, session.sessionId),
        createdAt,
        updatedAt,
        size: stats.reduce((total, stat) => total + Number(stat.size), 0),
        eventCount,
      }
      const ref = {
        source: this.id,
        sourceSessionId: session.sessionId,
        locator: session.files[0]!,
        locators: session.files,
        summary,
      } satisfies SourceSessionRef
      this.discoveryCache.set(session.sessionId, { signature, ref })
      return ref
    })
    const present = new Set(directories.map(directory => path.basename(directory)))
    for (const sessionId of this.discoveryCache.keys()) {
      if (!present.has(sessionId)) this.discoveryCache.delete(sessionId)
    }
    const failures = settled.flatMap((result, index) =>
      result.status === 'rejected'
        ? [{
            locator: directories[index]!,
            reason: result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
          }]
        : [])
    const refs = settled.flatMap(result =>
      result.status === 'fulfilled' && result.value !== undefined
        ? [result.value]
        : [])
    refs.sort((left, right) =>
      right.summary.updatedAt - left.summary.updatedAt)
    return {
      refs,
      diagnostics: {
        scanned: directories.length,
        loaded: refs.length,
        failed: failures.length,
        failures,
      },
    }
  }

  async fingerprint(ref: SourceSessionRef): Promise<string> {
    const files = await currentFiles(ref, this.sessionsRoot)
    const stats = await Promise.all(files.map(file => fs.stat(file)))
    return stats.map((stat, index) =>
      `${path.relative(this.sessionsRoot, files[index]!)}:${stat.mtimeMs}:${stat.size}`)
      .join('|')
  }

  async audit(ref: SourceSessionRef) {
    const files = await currentFiles(ref, this.sessionsRoot)
    const agents = await readAgents(files)
    const events = agents.flatMap(agent => agent.rows.map((row, rowIndex) => ({
      agentId: agent.agentId,
      row: rowIndex + 1,
      ...row,
    })))
    return completeAudit(events, {
      sessionId: ref.sourceSessionId,
      createdAt: ref.summary.createdAt,
      agents,
    } satisfies DoubaoWorkProjectionInput)
  }

  async load(ref: SourceSessionRef): Promise<SessionDetail> {
    const files = await currentFiles(ref, this.sessionsRoot)
    const agents = await readAgents(files)
    const input: DoubaoWorkProjectionInput = {
      sessionId: ref.sourceSessionId,
      createdAt: ref.summary.createdAt,
      agents,
    }
    const projection = await this.projectionWorker.projectDoubaoWork(
      `doubao-work-source:${ref.sourceSessionId}`,
      input,
    )
    const stats = await Promise.all(files.map(file => fs.stat(file)))
    return {
      summary: {
        ...ref.summary,
        updatedAt: Math.max(...stats.map(stat => Number(stat.mtimeMs))),
        size: stats.reduce((total, stat) => total + Number(stat.size), 0),
        eventCount: agents.reduce((total, agent) => total + agent.rows.length, 0),
      },
      projection,
    }
  }
}
