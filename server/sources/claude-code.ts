import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { readJsonlRows } from '../parsers/jsonl'
import {
  fileStatSignature,
  mapConcurrent,
  walkFiles,
} from './file-index'
import {
  type ClaudeCodeEnvelope,
} from '../projectors/claude-code'
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

const CLAUDE_CAPABILITIES = capabilities(
  'messages',
  'tools',
  'timing',
  'usage',
  'live',
  'attachments',
  'lineage',
)

export const claudeProjectsRoot = path.resolve(
  process.env.CLAUDE_PROJECTS_DIR
    ?? path.join(homedir(), '.claude', 'projects'),
)

interface ClaudeCodeSourceOptions {
  projectsRoot?: string
  projectionWorker?: ProjectionWorkerClient
}

interface DiscoveredSession {
  file: string
  rows: ClaudeCodeEnvelope[]
  sourceSessionId: string
  stat: Awaited<ReturnType<typeof fs.stat>>
}

function time(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function text(value: unknown): string {
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

function titleFor(rows: readonly ClaudeCodeEnvelope[], cwd: string): string {
  for (const row of rows) {
    if (row.type !== 'user'
      || row.message === null
      || typeof row.message !== 'object'
      || Array.isArray(row.message)) continue
    const value = text((row.message as Record<string, unknown>).content)
      .replace(/\s+/g, ' ')
      .trim()
    if (value !== '') return value.length > 64 ? `${value.slice(0, 63)}…` : value
  }
  return path.basename(cwd) || 'Claude Code 会话'
}

function assertRef(ref: SourceSessionRef, root: string): string {
  if (ref.source !== 'claude') throw new Error('invalid Claude Code session reference')
  const file = path.resolve(ref.locator)
  if (!file.startsWith(`${root}${path.sep}`) || !file.endsWith('.jsonl')) {
    throw new Error('invalid Claude Code session locator')
  }
  return file
}

async function discover(
  file: string,
  stat: Awaited<ReturnType<typeof fs.stat>>,
): Promise<DiscoveredSession> {
  const rows = await readJsonlRows<ClaudeCodeEnvelope>(file)
  const values = rows.map(row => row.value)
  const sourceSessionId = values.find(row =>
    typeof row.sessionId === 'string')?.sessionId
  if (sourceSessionId === undefined) {
    throw new Error('Claude Code session is missing sessionId')
  }
  return { file, rows: values, sourceSessionId, stat }
}

export class ClaudeCodeSource implements SessionSource {
  readonly id = 'claude' as const
  private readonly projectsRoot: string
  private readonly projectionWorker: ProjectionWorkerClient
  private readonly discoveryCache = new Map<string, {
    signature: string
    ref: SourceSessionRef
  }>()

  constructor(options: ClaudeCodeSourceOptions = {}) {
    this.projectsRoot = path.resolve(options.projectsRoot ?? claudeProjectsRoot)
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
        capabilities: CLAUDE_CAPABILITIES,
        protocol: {
          detected: 'claude-code-jsonl',
          supported: ['claude-code-jsonl'],
          fingerprint: 'claude:projects:jsonl',
        },
      }
    } catch {
      return {
        source: this.id,
        availability: 'blocked',
        ...sourceMetadata(this.id),
        sessionCount: 0,
        capabilities: CLAUDE_CAPABILITIES,
        reason: 'sessions_directory_missing',
        detail: '未找到 ~/.claude/projects',
      }
    }
  }

  async list(): Promise<readonly SourceSessionRef[]> {
    return (await this.listDetailed()).refs
  }

  async listDetailed(): Promise<SourceListResult> {
    const walked = await walkFiles(
      this.projectsRoot,
      (_file, name) => name.endsWith('.jsonl'),
    )
    const present = new Set(walked.files)
    for (const file of this.discoveryCache.keys()) {
      if (!present.has(file)) this.discoveryCache.delete(file)
    }
    const settled = await mapConcurrent(walked.files, 16, async (file) => {
      const stat = await fs.stat(file)
      const signature = fileStatSignature(stat)
      const cached = this.discoveryCache.get(file)
      if (cached?.signature === signature) return cached.ref
      const session = await discover(file, stat)
      const first = session.rows[0]
      const cwd = [...session.rows].reverse().find(row =>
        typeof row.cwd === 'string')?.cwd ?? ''
      const createdAt = session.rows.map(row => time(row.timestamp))
        .find(value => value > 0)
        ?? session.stat.birthtimeMs
        ?? session.stat.mtimeMs
      const rawVersion = [...session.rows].reverse().find(row =>
        typeof row.version === 'string')?.version
      const summary: SessionSummary = {
        id: sessionKey(this.id, session.sourceSessionId),
        source: this.id,
        sourceSessionId: session.sourceSessionId,
        format: 'claude-code-jsonl',
        capabilities: CLAUDE_CAPABILITIES,
        cwd,
        title: titleFor(session.rows, cwd),
        createdAt: Number(createdAt || time(first?.timestamp)),
        updatedAt: Number(session.stat.mtimeMs),
        size: Number(session.stat.size),
        rawVersion,
        eventCount: session.rows.length,
      }
      const ref: SourceSessionRef = {
        source: this.id,
        sourceSessionId: session.sourceSessionId,
        locator: session.file,
        summary,
      }
      this.discoveryCache.set(file, { signature, ref })
      return ref
    })
    const failures = [
      ...walked.failures,
      ...settled.flatMap((result, index) =>
        result.status === 'rejected'
          ? [{
              locator: walked.files[index]!,
              reason: result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
            }]
          : []),
    ]
    const refs = settled.flatMap(result =>
      result.status === 'fulfilled' ? [result.value] : [])
    refs.sort((left, right) =>
      right.summary.updatedAt - left.summary.updatedAt)
    return {
      refs,
      diagnostics: {
        scanned: walked.files.length + walked.failures.length,
        loaded: refs.length,
        failed: failures.length,
        failures,
      },
    }
  }

  async fingerprint(ref: SourceSessionRef): Promise<string> {
    const stat = await fs.stat(assertRef(ref, this.projectsRoot))
    return `${stat.mtimeMs}:${stat.size}`
  }

  async audit(ref: SourceSessionRef) {
    const rows = await readJsonlRows<ClaudeCodeEnvelope>(
      assertRef(ref, this.projectsRoot),
    )
    const events = rows.map(row => row.value)
    return completeAudit(events, { envelopes: events })
  }

  async load(ref: SourceSessionRef): Promise<SessionDetail> {
    const file = assertRef(ref, this.projectsRoot)
    const [rows, stat] = await Promise.all([
      readJsonlRows<ClaudeCodeEnvelope>(file),
      fs.stat(file),
    ])
    const envelopes = rows.map(row => row.value)
    if (!envelopes.some(row => row.sessionId === ref.sourceSessionId)) {
      throw new Error('Claude Code session id does not match its safe locator')
    }
    const projection = await this.projectionWorker.projectClaudeCode(
      `claude-source:${ref.sourceSessionId}`,
      envelopes,
    )
    const summary: SessionSummary = {
      ...ref.summary,
      cwd: projection.header.cwd ?? ref.summary.cwd,
      updatedAt: stat.mtimeMs,
      size: stat.size,
      eventCount: envelopes.length,
      rawVersion: projection.header.rawVersion,
    }
    return { summary, projection }
  }
}
