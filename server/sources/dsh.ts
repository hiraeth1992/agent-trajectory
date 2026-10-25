import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { Decompress } from 'fzstd'
import { readJsonlRowsFrom } from '../parsers/jsonl'
import { jsonWeight, WeightedLruCache } from '../lru'
import {
  ProjectionWorkerClient,
  projectionWorker as defaultProjectionWorker,
} from '../projection-worker-client'
import { KNOWN_EVENT_TYPES, textFromContent } from '../../src/projector'
import type {
  SessionDetail,
  SessionEvent,
  SessionHeader,
  SessionSummary,
  SourceStatus,
} from '../../src/types'
import {
  capabilities,
  sessionKey,
  SessionFormatError,
  sourceMetadata,
  type SessionSource,
  type SourceSessionRef,
} from './types'

const SESSION_PROTOCOL_FILE = /^session\.v(\d+)\.jsonl(?:\.zst|\.zstd)?$/
const SUPPORTED_DSH_PROTOCOLS = ['dsh-session-v4']
const PROBE_ENTRY_LIMIT = 256
let dshSourceInstances = 0

const DSH_CAPABILITIES = capabilities(
  'messages',
  'tools',
  'nestedTools',
  'timing',
  'usage',
  'live',
  'attachments',
  'lineage',
  'tasks',
)

interface ParsedSession {
  header: SessionHeader
  events: SessionEvent[]
}

interface CacheEntry {
  signature: string
  detail: SessionDetail
  header: SessionHeader
  events: SessionEvent[]
  fileSize: number
  nextOffset?: number
  nextLine?: number
  boundarySignature?: string
}

interface DshSourceOptions {
  sessionsRoot?: string
  cacheEntries?: number
  cacheBytes?: number
  projectionWorker?: ProjectionWorkerClient
}

export const sessionsRoot = path.resolve(
  process.env.DSH_SESSIONS_DIR ?? path.join(homedir(), '.dsh', 'sessions'),
)

async function walk(directory: string, output: string[]): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await walk(absolute, output)
    } else if (entry.isFile() && SESSION_PROTOCOL_FILE.test(entry.name)) {
      output.push(absolute)
    }
  }))
}

async function detectSessionVersions(directory: string): Promise<{
  complete: boolean
  versions: number[]
}> {
  const versions = new Set<number>()
  const pending = [directory]
  let visited = 0
  let complete = true
  scan: while (pending.length > 0) {
    const current = pending.shift()!
    const entries = await fs.opendir(current)
    for await (const entry of entries) {
      if (visited >= PROBE_ENTRY_LIMIT) {
        complete = false
        break scan
      }
      visited++
      const version = entry.isFile()
        ? entry.name.match(SESSION_PROTOCOL_FILE)?.[1]
        : undefined
      if (version !== undefined) versions.add(Number(version))
      else if (entry.isDirectory()) pending.push(path.join(current, entry.name))
    }
  }
  return {
    complete,
    versions: [...versions].sort((left, right) => left - right),
  }
}

async function decompress(file: string): Promise<string> {
  if (file.endsWith('.jsonl')) return fs.readFile(file, 'utf8')
  const binary = process.env.ZSTD_BIN
  if (binary === undefined) {
    const compressed = await fs.readFile(file)
    const chunks: Uint8Array[] = []
    const decoder = new Decompress(chunk => chunks.push(chunk))
    try {
      decoder.push(compressed, true)
    } catch (error) {
      const output = Buffer.concat(chunks).toString('utf8')
      const message = error instanceof Error ? error.message : String(error)
      if (output.includes('\n') && /unexpected eof/i.test(message)) return output
      throw error
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-dc', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8')
      if (code !== 0) {
        const errorText = Buffer.concat(stderr).toString('utf8')
        if (output.includes('\n') && /truncat|unexpected end|premature end|incomplete/i.test(errorText)) {
          resolve(output)
          return
        }
        reject(new Error(`zstd exited with ${code}: ${errorText}`))
        return
      }
      resolve(output)
    })
  })
}

export function parseDshJsonl(source: string): ParsedSession {
  const lines = source.split(/\r?\n/)
  if (lines.at(-1)?.trim() === '') lines.pop()
  if (!/\r?\n$/.test(source) && lines.length > 0) {
    try {
      JSON.parse(lines.at(-1)!)
    } catch {
      lines.pop()
    }
  }
  const rows = lines
    .filter(line => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown
      } catch (error) {
        throw new Error(`invalid JSON at line ${index + 1}: ${(error as Error).message}`)
      }
    })
  const header = rows[0] as SessionHeader | undefined
  if (header?.type !== 'session' || header.version !== 4 || typeof header.id !== 'string') {
    throw new Error('unsupported session file: expected a v4 session header')
  }
  const events: SessionEvent[] = []
  let expectedSeq = 0
  for (const row of rows.slice(1)) {
    const event = row as SessionEvent
    if (typeof event.type !== 'string' || typeof event.seq !== 'number' || typeof event.time !== 'number') {
      throw new Error('invalid session event envelope')
    }
    if (event.seq !== expectedSeq) {
      throw new Error(`non-contiguous event sequence: expected ${expectedSeq}, got ${event.seq}`)
    }
    if (!KNOWN_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
      throw new Error(`unknown required session event: ${event.type}`)
    }
    events.push(event)
    expectedSeq++
  }
  return { header, events }
}

function titleFor(events: readonly SessionEvent[], cwd: string): string {
  for (const event of [...events].reverse()) {
    if (event.type !== 'session/title') continue
    const title = event.data.title
    if (typeof title === 'string' && title.trim() !== '') return title.trim()
  }
  for (const event of events) {
    if (event.type !== 'user/message' || (event.data.source as { kind?: unknown } | undefined)?.kind !== 'user') continue
    const title = textFromContent(event.data.content).replace(/\s+/g, ' ').trim()
    if (title !== '') return title.length > 64 ? `${title.slice(0, 63)}…` : title
  }
  return path.basename(cwd) || '未命名会话'
}

function createdAtNumber(header: SessionHeader): number {
  if (typeof header.createdAt === 'number') return header.createdAt
  const parsed = Date.parse(header.createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

async function boundarySignature(file: string, offset: number): Promise<string> {
  const length = Math.min(256, offset)
  if (length === 0) return 'empty'
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset - length)
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex')
  } finally {
    await handle.close()
  }
}

export function inferredDshId(file: string, root = sessionsRoot): string {
  const directory = path.basename(path.dirname(file))
  if (directory.startsWith('session-') && directory.length > 8) return directory
  return createHash('sha256').update(path.relative(root, file)).digest('hex').slice(0, 32)
}

async function readSourceSessionId(file: string, root: string): Promise<string> {
  const inferred = inferredDshId(file, root)
  if (path.basename(path.dirname(file)).startsWith('session-')) {
    if (sessionGeneration(file) === 4 && file.endsWith('.jsonl')) {
      const header = await readPlainHeader(file)
      if (header.id !== inferred) {
        throw new Error('DSH session id does not match its canonical directory')
      }
    }
    return inferred
  }
  if (sessionGeneration(file) !== 4) return inferred
  const header = parseDshJsonl(await decompress(file)).header
  return header.id
}

async function readPlainHeader(file: string): Promise<SessionHeader> {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = text.indexOf('\n')
    if (newline < 0 && bytesRead === buffer.length) {
      throw new Error('DSH session header exceeds 64 KiB')
    }
    const header = JSON.parse((newline < 0 ? text : text.slice(0, newline)).trim()) as SessionHeader
    if (header.type !== 'session' || header.version !== 4 || typeof header.id !== 'string') {
      throw new Error('unsupported session file: expected a v4 session header')
    }
    return header
  } catch (error) {
    throw new Error(
      `invalid DSH session header: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    await handle.close()
  }
}

function fallbackTitle(sourceSessionId: string): string {
  const distinctive = sourceSessionId.startsWith('session-')
    ? sourceSessionId.slice('session-'.length)
    : sourceSessionId
  return `DSH · ${distinctive.slice(0, 12)}`
}

function sessionGeneration(file: string): number {
  const value = path.basename(file).match(SESSION_PROTOCOL_FILE)?.[1]
  if (value === undefined) throw new Error('invalid DSH session generation')
  return Number(value)
}

function compressionPriority(file: string): number {
  return file.endsWith('.jsonl') ? 0 : file.endsWith('.zst') ? 1 : 2
}

function formatStatus(generation: number): NonNullable<SessionSummary['formatStatus']> {
  return generation === 4
    ? 'current'
    : generation < 4 ? 'migration-required' : 'unsupported-future'
}

function assertRef(ref: SourceSessionRef, root: string): string {
  if (ref.source !== 'dsh') throw new Error('invalid DSH session reference')
  if (ref.summary.formatStatus === 'corrupt') {
    throw new SessionFormatError(
      ref.summary.formatDetail ?? 'DSH session file is corrupt',
      'session_corrupt',
    )
  }
  const file = path.resolve(ref.locator)
  if (!file.startsWith(`${root}${path.sep}`)
    || !SESSION_PROTOCOL_FILE.test(path.basename(file))) {
    throw new Error('invalid DSH session locator')
  }
  const generation = sessionGeneration(file)
  if (generation < 4) {
    throw new SessionFormatError(
      `DSH session v${generation} requires a read-only migration adapter before it can be loaded`,
      'session_migration_required',
    )
  }
  if (generation > 4) {
    throw new SessionFormatError(
      `DSH session v${generation} is newer than supported v4`,
      'session_protocol_unsupported',
    )
  }
  return file
}

export class DshSource implements SessionSource {
  readonly id = 'dsh' as const
  private readonly cache: WeightedLruCache<string, CacheEntry>
  private readonly sessionsRoot: string
  private readonly projectionWorker: ProjectionWorkerClient
  private readonly projectionNamespace = `dsh-source:${++dshSourceInstances}`

  constructor(options: DshSourceOptions = {}) {
    this.sessionsRoot = path.resolve(options.sessionsRoot ?? sessionsRoot)
    this.projectionWorker = options.projectionWorker ?? defaultProjectionWorker
    this.cache = new WeightedLruCache<string, CacheEntry>({
      maxEntries: options.cacheEntries ?? 8,
      maxWeight: options.cacheBytes ?? 96 * 1024 * 1024,
      weight: jsonWeight,
    })
  }

  metrics() {
    return { cache: this.cache.metrics() }
  }

  async probe(): Promise<SourceStatus> {
    try {
      await fs.access(this.sessionsRoot)
      const detection = await detectSessionVersions(this.sessionsRoot)
      const versions = detection.versions
      const unsupported = versions.filter(version => version !== 4)
      const detected = versions.length === 0
        ? 'none'
        : versions.map(version => `dsh-session-v${version}`).join(',')
      const protocol = {
        detected,
        supported: SUPPORTED_DSH_PROTOCOLS,
        fingerprint: versions.length === 0
          ? 'dsh:session:none'
          : `dsh:session:v${versions.join(',v')}`,
      }
      const bounded = !detection.complete
      return {
        source: this.id,
        availability: unsupported.length === 0 && !bounded ? 'available' : 'degraded',
        ...sourceMetadata(this.id),
        version: 'Session v4',
        sessionCount: 0,
        capabilities: DSH_CAPABILITIES,
        ...(unsupported.length > 0
          ? {
              reason: 'additional_dsh_protocols_visible',
              detail: `Session v4 可读取；其他 generation 会保留在列表中：${
                unsupported.map(version => `v${version}`).join(', ')
              }`,
            }
          : bounded
            ? {
                reason: 'dsh_protocol_probe_bounded',
                detail: '协议探测已达到本地扫描上限；会话发现将在后台继续',
              }
          : {}
        ),
        protocol,
      }
    } catch {
      return {
        source: this.id,
        availability: 'blocked',
        ...sourceMetadata(this.id),
        version: 'Session v4',
        sessionCount: 0,
        capabilities: DSH_CAPABILITIES,
        reason: 'sessions_directory_missing',
        detail: '未找到 ~/.dsh/sessions',
      }
    }
  }

  async list(): Promise<readonly SourceSessionRef[]> {
    const files: string[] = []
    await walk(this.sessionsRoot, files)
    const byDirectory = new Map<string, string[]>()
    for (const file of files) {
      const directory = path.dirname(file)
      const current = byDirectory.get(directory) ?? []
      current.push(file)
      byDirectory.set(directory, current)
    }
    const selected = [...byDirectory.values()].map((group) => {
      return [...group].sort((left, right) =>
        sessionGeneration(right) - sessionGeneration(left)
        || compressionPriority(left) - compressionPriority(right)
        || left.localeCompare(right))[0]!
    })
    const discovered = await Promise.all(selected.map(async (file): Promise<SourceSessionRef> => {
      const stat = await fs.stat(file)
      const generation = sessionGeneration(file)
      let sourceSessionId: string
      let selectedStatus = formatStatus(generation)
      let formatDetail: string | undefined
      try {
        sourceSessionId = await readSourceSessionId(file, this.sessionsRoot)
      } catch (error) {
        sourceSessionId = inferredDshId(file, this.sessionsRoot)
        selectedStatus = 'corrupt'
        formatDetail = error instanceof Error ? error.message : String(error)
      }
      const cached = this.cache.peek(file)?.detail.summary
      const summary: SessionSummary = {
        ...(cached ?? {
          id: sessionKey(this.id, sourceSessionId),
          source: this.id,
          sourceSessionId,
          format: `session-v${generation}`,
          capabilities: DSH_CAPABILITIES,
          cwd: '',
          title: fallbackTitle(sourceSessionId),
          createdAt: stat.birthtimeMs || stat.mtimeMs,
          rawVersion: generation,
        }),
        updatedAt: stat.mtimeMs,
        size: stat.size,
        formatStatus: selectedStatus,
        formatDetail: formatDetail
          ?? (selectedStatus === 'migration-required'
            ? `Session v${generation} 需要只读迁移适配器`
            : selectedStatus === 'unsupported-future'
              ? `Session v${generation} 高于当前支持的 v4`
              : undefined),
      }
      return { source: this.id, sourceSessionId, locator: file, summary }
    }))
    const bySession = new Map<string, SourceSessionRef>()
    for (const ref of discovered.sort((left, right) =>
      sessionGeneration(right.locator) - sessionGeneration(left.locator)
      || right.summary.updatedAt - left.summary.updatedAt
      || left.locator.localeCompare(right.locator))) {
      if (!bySession.has(ref.sourceSessionId)) bySession.set(ref.sourceSessionId, ref)
    }
    const refs = [...bySession.values()]
    return refs.sort((a, b) => b.summary.updatedAt - a.summary.updatedAt)
  }

  async fingerprint(ref: SourceSessionRef): Promise<string> {
    const stat = await fs.stat(assertRef(ref, this.sessionsRoot))
    return `${stat.mtimeMs}:${stat.size}`
  }

  async audit(ref: SourceSessionRef): Promise<readonly unknown[]> {
    const file = assertRef(ref, this.sessionsRoot)
    const parsed = parseDshJsonl(await decompress(file))
    if (parsed.header.id !== ref.sourceSessionId) {
      throw new Error('DSH session id does not match its safe locator')
    }
    return [parsed.header, ...parsed.events]
  }

  async load(ref: SourceSessionRef): Promise<SessionDetail> {
    const file = assertRef(ref, this.sessionsRoot)
    const signature = await this.fingerprint(ref)
    const hit = this.cache.get(file)
    if (hit?.signature === signature) return hit.detail

    const stat = await fs.stat(file)
    let header: SessionHeader
    let events: SessionEvent[]
    let nextOffset: number | undefined
    let nextLine: number | undefined
    let nextBoundarySignature: string | undefined
    let appendedEvents: SessionEvent[] | undefined
    const canResume = file.endsWith('.jsonl')
      && hit?.nextOffset !== undefined
      && hit.nextLine !== undefined
      && hit.boundarySignature !== undefined
      && stat.size > hit.fileSize
      && await boundarySignature(file, hit.nextOffset) === hit.boundarySignature
    if (canResume) {
      try {
        const appended = await readJsonlRowsFrom<SessionEvent>(
          file,
          hit.nextOffset!,
          hit.nextLine!,
        )
        header = hit.header
        events = [...hit.events]
        appendedEvents = []
        let expectedSeq = events.length
        for (const { value: event } of appended.rows) {
          if (typeof event.type !== 'string'
            || typeof event.seq !== 'number'
            || typeof event.time !== 'number') {
            throw new Error('invalid session event envelope')
          }
          if (event.seq !== expectedSeq) {
            throw new Error(`non-contiguous event sequence: expected ${expectedSeq}, got ${event.seq}`)
          }
          if (!KNOWN_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
            throw new Error(`unknown required session event: ${event.type}`)
          }
          events.push(event)
          appendedEvents.push(event)
          expectedSeq++
        }
        nextOffset = appended.nextOffset
        nextLine = appended.nextLine
        nextBoundarySignature = await boundarySignature(file, appended.nextOffset)
      } catch {
        appendedEvents = undefined
        const initial = await readJsonlRowsFrom<SessionHeader | SessionEvent>(file)
        const rows = initial.rows.map(row => row.value)
        const parsed = parseDshJsonl(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
        header = parsed.header
        events = parsed.events
        nextOffset = initial.nextOffset
        nextLine = initial.nextLine
        nextBoundarySignature = await boundarySignature(file, initial.nextOffset)
      }
    } else if (file.endsWith('.jsonl')) {
      const initial = await readJsonlRowsFrom<SessionHeader | SessionEvent>(file)
      if (initial.nextOffset === stat.size) {
        const rows = initial.rows.map(row => row.value)
        const parsed = parseDshJsonl(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
        header = parsed.header
        events = parsed.events
        nextOffset = initial.nextOffset
        nextLine = initial.nextLine
        nextBoundarySignature = await boundarySignature(file, initial.nextOffset)
      } else {
        ({ header, events } = parseDshJsonl(await decompress(file)))
      }
    } else {
      ({ header, events } = parseDshJsonl(await decompress(file)))
    }
    if (header.id !== ref.sourceSessionId) {
      throw new Error('DSH session id does not match its safe locator')
    }
    const summary: SessionSummary = {
      id: sessionKey(this.id, header.id),
      source: this.id,
      sourceSessionId: header.id,
      format: 'session-v4',
      capabilities: DSH_CAPABILITIES,
      cwd: header.cwd,
      title: titleFor(events, header.cwd),
      createdAt: createdAtNumber(header),
      updatedAt: stat.mtimeMs,
      size: stat.size,
      rawVersion: header.version,
      eventCount: events.length,
    }
    const detail = {
      summary,
      projection: await this.projectionWorker.projectDsh(
        `${this.projectionNamespace}:${header.id}`,
        header,
        events,
        appendedEvents,
      ),
    }
    this.cache.set(file, {
      signature,
      detail,
      header,
      events,
      fileSize: stat.size,
      nextOffset,
      nextLine,
      boundarySignature: nextBoundarySignature,
    })
    return detail
  }
}
