import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { readJsonlRows } from '../parsers/jsonl'
import {
  fileStatSignature,
  mapConcurrent,
  walkFiles,
} from './file-index'
import type {
  QoderEnvelope,
  QoderProjectionInput,
  QoderSubagentInput,
  QoderSubagentMeta,
} from '../projectors/qoder'
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

const QODER_CAPABILITIES = capabilities(
  'messages',
  'tools',
  'nestedTools',
  'timing',
  'usage',
  'live',
  'attachments',
  'lineage',
)

export const qoderProjectsRoot = path.resolve(
  process.env.QODER_PROJECTS_DIR
    ?? path.join(homedir(), '.qoder-cn', 'projects'),
)

export interface QoderSourceOptions {
  projectsRoot?: string
  projectionWorker?: ProjectionWorkerClient
}

interface SessionFiles {
  main: string
  related: string[]
}

interface LoadedSession {
  input: QoderProjectionInput
  files: SessionFiles
  stats: Awaited<ReturnType<typeof fs.stat>>[]
}

function timestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value
  }
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return []
    const block = entry as Record<string, unknown>
    return block.type === 'text' && typeof block.text === 'string'
      ? [block.text]
      : []
  }).join('\n')
}

function titleFor(rows: readonly QoderEnvelope[], cwd: string): string {
  for (const row of rows) {
    if (row.type !== 'user') continue
    const message = row.message === null
      || typeof row.message !== 'object'
      || Array.isArray(row.message)
      ? {}
      : row.message as Record<string, unknown>
    const value = messageText(message.content).replace(/\s+/g, ' ').trim()
    if (value !== '') return value.length > 64 ? `${value.slice(0, 63)}…` : value
  }
  return path.basename(cwd) || 'Qoder 会话'
}

function associatedDirectory(main: string): string {
  return main.slice(0, -'.jsonl'.length)
}

async function sessionFiles(main: string): Promise<SessionFiles> {
  const walked = await walkFiles(associatedDirectory(main), () => true)
  if (walked.failures.length > 0) {
    throw new Error(walked.failures.map(failure => failure.reason).join('; '))
  }
  return { main, related: walked.files }
}

async function readMeta(file: string): Promise<QoderSubagentMeta | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as QoderSubagentMeta
      : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function loadSession(main: string): Promise<LoadedSession> {
  const files = await sessionFiles(main)
  const mainRows = (await readJsonlRows<QoderEnvelope>(main)).map(row => row.value)
  const subagentFiles = files.related.filter(file =>
    file.endsWith('.jsonl') && path.basename(path.dirname(file)) === 'subagents')
  const subagents: QoderSubagentInput[] = await Promise.all(subagentFiles.map(async file => {
    const id = path.basename(file, '.jsonl')
    const [rows, meta] = await Promise.all([
      readJsonlRows<QoderEnvelope>(file),
      readMeta(path.join(path.dirname(file), `${id}.meta.json`)),
    ])
    return { id, meta, rows: rows.map(row => row.value) }
  }))
  const sessionId = mainRows.find(row =>
    typeof row.sessionId === 'string')?.sessionId
  if (sessionId === undefined) throw new Error('Qoder session is missing sessionId')
  const allFiles = [files.main, ...files.related]
  const stats = await Promise.all(allFiles.map(file => fs.stat(file)))
  return {
    files,
    input: { sessionId, main: mainRows, subagents },
    stats,
  }
}

function assertRef(ref: SourceSessionRef, root: string): string {
  if (ref.source !== 'qoder') throw new Error('invalid Qoder session reference')
  const file = path.resolve(ref.locator)
  if (!file.startsWith(`${root}${path.sep}`)
    || !file.endsWith('.jsonl')
    || file.includes(`${path.sep}subagents${path.sep}`)) {
    throw new Error('invalid Qoder session locator')
  }
  return file
}

function size(stats: readonly Awaited<ReturnType<typeof fs.stat>>[]): number {
  return stats.reduce((total, stat) => total + Number(stat.size), 0)
}

function latest(stats: readonly Awaited<ReturnType<typeof fs.stat>>[]): number {
  return stats.reduce((value, stat) => Math.max(value, Number(stat.mtimeMs)), 0)
}

export class QoderSource implements SessionSource {
  readonly id = 'qoder' as const
  private readonly projectsRoot: string
  private readonly projectionWorker: ProjectionWorkerClient
  private readonly discoveryCache = new Map<string, {
    signature: string
    ref: SourceSessionRef
  }>()

  constructor(options: QoderSourceOptions = {}) {
    this.projectsRoot = path.resolve(options.projectsRoot ?? qoderProjectsRoot)
    this.projectionWorker = options.projectionWorker ?? defaultProjectionWorker
  }

  async probe(): Promise<SourceStatus> {
    try {
      await fs.access(this.projectsRoot)
      return {
        source: this.id,
        availability: 'available',
        ...sourceMetadata(this.id),
        sessionCount: 0,
        capabilities: QODER_CAPABILITIES,
        protocol: {
          detected: 'qoder-jsonl-v1',
          supported: ['qoder-jsonl-v1'],
          fingerprint: 'qoder:projects:jsonl:v1',
        },
      }
    } catch {
      return {
        source: this.id,
        availability: 'blocked',
        ...sourceMetadata(this.id),
        sessionCount: 0,
        capabilities: QODER_CAPABILITIES,
        reason: 'sessions_directory_missing',
        detail: '未找到 ~/.qoder-cn/projects',
      }
    }
  }

  async list(): Promise<readonly SourceSessionRef[]> {
    return (await this.listDetailed()).refs
  }

  async listDetailed(): Promise<SourceListResult> {
    const walked = await walkFiles(this.projectsRoot, () => true)
    const mains = walked.files.filter(file =>
      file.endsWith('.jsonl') && !file.includes(`${path.sep}subagents${path.sep}`))
    const present = new Set(mains)
    for (const file of this.discoveryCache.keys()) {
      if (!present.has(file)) this.discoveryCache.delete(file)
    }
    const settled = await mapConcurrent(mains, 12, async (main) => {
      const files = await sessionFiles(main)
      const all = [files.main, ...files.related]
      const stats = await mapConcurrent(all, 16, file => fs.stat(file))
      const rejected = stats.find(result => result.status === 'rejected')
      if (rejected?.status === 'rejected') throw rejected.reason
      const signature = stats.map((result, index) =>
        `${path.relative(this.projectsRoot, all[index]!)}:${
          fileStatSignature((result as PromiseFulfilledResult<
            Awaited<ReturnType<typeof fs.stat>>
          >).value)
        }`).join('|')
      const cached = this.discoveryCache.get(main)
      if (cached?.signature === signature) return cached.ref
      const loaded = await loadSession(main)
      const rows = loaded.input.main
      const cwd = [...rows].reverse().find(row => typeof row.cwd === 'string')?.cwd
        ?? rows.flatMap(row => Array.isArray(row.directories) ? row.directories : [])
          .find(value => typeof value === 'string') as string | undefined
        ?? ''
      const runtime = [...rows].reverse().find(row => row.type === 'runtime-config')
      const rawVersion = [...rows].reverse()
        .find(row => typeof row.version === 'string')?.version
        ?? (typeof runtime?.version === 'string' ? runtime.version : undefined)
      const createdAt = Number(rows.map(row => timestamp(row.timestamp))
        .find(value => value > 0)
        ?? loaded.stats[0]?.birthtimeMs
        ?? loaded.stats[0]?.mtimeMs
        ?? 0)
      const eventCount = rows.length
        + loaded.input.subagents.reduce((total, agent) => total + agent.rows.length, 0)
      const summary: SessionSummary = {
        id: sessionKey(this.id, loaded.input.sessionId),
        source: this.id,
        sourceSessionId: loaded.input.sessionId,
        format: 'qoder-jsonl-v1',
        capabilities: QODER_CAPABILITIES,
        cwd,
        title: titleFor(rows, cwd),
        createdAt,
        updatedAt: latest(loaded.stats),
        size: size(loaded.stats),
        rawVersion,
        eventCount,
      }
      const ref: SourceSessionRef = {
        source: this.id,
        sourceSessionId: loaded.input.sessionId,
        locator: loaded.files.main,
        locators: [loaded.files.main, ...loaded.files.related],
        summary,
      }
      this.discoveryCache.set(main, { signature, ref })
      return ref
    })
    const failures = [
      ...walked.failures,
      ...settled.flatMap((result, index) =>
        result.status === 'rejected'
          ? [{
              locator: mains[index]!,
              reason: result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
            }]
          : []),
    ]
    const refs = settled.flatMap(result =>
      result.status === 'fulfilled' ? [result.value] : [])
      .sort((left, right) => right.summary.updatedAt - left.summary.updatedAt)
    return {
      refs,
      diagnostics: {
        scanned: mains.length + walked.failures.length,
        loaded: refs.length,
        failed: failures.length,
        failures,
      },
    }
  }

  async fingerprint(ref: SourceSessionRef): Promise<string> {
    const files = await sessionFiles(assertRef(ref, this.projectsRoot))
    const all = [files.main, ...files.related]
    const stats = await Promise.all(all.map(async file => {
      const stat = await fs.stat(file)
      return `${path.relative(this.projectsRoot, file)}:${stat.mtimeMs}:${stat.size}`
    }))
    return stats.join('|')
  }

  async audit(ref: SourceSessionRef) {
    const loaded = await loadSession(assertRef(ref, this.projectsRoot))
    const events = [
      ...loaded.input.main,
      ...loaded.input.subagents.flatMap(agent => agent.rows),
    ]
    return completeAudit(events, loaded.input)
  }

  async load(ref: SourceSessionRef): Promise<SessionDetail> {
    const loaded = await loadSession(assertRef(ref, this.projectsRoot))
    if (loaded.input.sessionId !== ref.sourceSessionId) {
      throw new Error('Qoder session id does not match its safe locator')
    }
    const projection = await this.projectionWorker.projectQoder(
      `qoder-source:${ref.sourceSessionId}`,
      loaded.input,
    )
    return {
      summary: {
        ...ref.summary,
        cwd: projection.header.cwd ?? ref.summary.cwd,
        updatedAt: latest(loaded.stats),
        size: size(loaded.stats),
        rawVersion: projection.header.rawVersion,
        eventCount: projection.eventCount,
      },
      projection,
    }
  }
}
