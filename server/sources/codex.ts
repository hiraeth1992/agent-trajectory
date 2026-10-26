import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  readJsonlRows,
  readJsonlRowsFrom,
  parseJsonlRows,
  type JsonlRow,
} from '../parsers/jsonl'
import type { CodexEnvelope } from '../projectors/codex'
import { jsonWeight, WeightedLruCache } from '../lru'
import {
  ProjectionWorkerClient,
  projectionWorker as defaultProjectionWorker,
} from '../projection-worker-client'
import type { JsonObject, SessionDetail, SessionSummary, SourceStatus } from '../../src/types'
import {
  capabilities,
  completeAudit,
  sessionKey,
  sourceMetadata,
  type SessionSource,
  type SourceSessionRef,
} from './types'

const CODEX_CAPABILITIES = capabilities('messages', 'tools', 'timing', 'usage', 'live')
const SUPPORTED_CODEX_PROTOCOLS = ['codex-rollout-v1']
const PROBE_DIRECTORY_LIMIT = 256
const PROBE_ROLLOUT_LIMIT = 16
const PROBE_HEADER_BYTES = 64 * 1024
const codexHome = path.resolve(process.env.CODEX_HOME ?? path.join(homedir(), '.codex'))
export const codexSessionsRoot = path.resolve(
  process.env.CODEX_SESSIONS_DIR ?? path.join(codexHome, 'sessions'),
)
const sessionIndexFile = path.join(codexHome, 'session_index.jsonl')
let codexSourceInstances = 0

interface CacheEntry {
  signature: string
  detail: SessionDetail
  pages: Map<string, PageCacheEntry>
}

interface PageCacheEntry {
  rows: JsonlRow<CodexEnvelope>[]
  fileSize: number
  fileMtimeMs: number
  nextOffset?: number
  nextLine?: number
  boundarySignature?: string
}

interface CodexSourceOptions {
  sessionsRoot?: string
  sessionIndexFile?: string
  cacheEntries?: number
  cacheBytes?: number
  projectionWorker?: ProjectionWorkerClient
}

interface IndexEntry {
  id?: string
  thread_name?: string
  updated_at?: string
}

interface DiscoveredPage {
  file: string
  sourceSessionId: string
  cwd?: string
  rawVersion?: string
  size: number
  mtimeMs: number
  pageTime: number
}

interface IndexedDirectory {
  signature: string
  childDirectories: Set<string>
  rolloutFiles: Set<string>
}

interface CachedSessionIndex {
  signature: string
  entries: Map<string, IndexEntry>
}

function statSignature(stat: Awaited<ReturnType<typeof fs.stat>>): string {
  return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function time(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

async function readFirstLine(file: string): Promise<string> {
  const handle = await fs.open(file, 'r')
  try {
    const chunks: Buffer[] = []
    let offset = 0
    while (offset < 2 * 1024 * 1024) {
      const buffer = Buffer.allocUnsafe(64 * 1024)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      const newline = chunk.indexOf(0x0a)
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline))
        return Buffer.concat(chunks).toString('utf8')
      }
      chunks.push(chunk)
      offset += bytesRead
    }
    throw new Error('Codex session header exceeds 2 MiB or is incomplete')
  } finally {
    await handle.close()
  }
}

async function probeRolloutHeaders(sessionsRoot: string): Promise<{
  complete: boolean
  malformed: boolean
  types: string[]
}> {
  const pending = [sessionsRoot]
  let visited = 0
  let inspectedRollouts = 0
  let complete = true
  let malformed = false
  const types = new Set<string>()
  scan: while (pending.length > 0) {
    const directory = pending.shift()!
    const entries = await fs.opendir(directory)
    for await (const entry of entries) {
      if (visited >= PROBE_DIRECTORY_LIMIT) {
        complete = false
        break scan
      }
      visited++
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(absolute)
        continue
      }
      if (!entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name)) continue
      if (inspectedRollouts >= PROBE_ROLLOUT_LIMIT) {
        complete = false
        break scan
      }
      inspectedRollouts++
      const handle = await fs.open(absolute, 'r')
      try {
        const buffer = Buffer.allocUnsafe(PROBE_HEADER_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        const text = buffer.subarray(0, bytesRead).toString('utf8')
        const line = text.split(/\r?\n/, 1)[0]?.trim() ?? ''
        if (line === '') {
          malformed = true
          continue
        }
        try {
          const header = JSON.parse(line) as { type?: unknown }
          if (typeof header.type === 'string') types.add(header.type)
          else malformed = true
        } catch {
          malformed = true
        }
      } finally {
        await handle.close()
      }
    }
  }
  return {
    complete,
    malformed,
    types: [
      ...([...types].includes('session_meta') ? ['session_meta'] : []),
      ...[...types].filter(type => type !== 'session_meta').sort(),
    ],
  }
}

async function readIndex(file: string): Promise<Map<string, IndexEntry>> {
  try {
    const rows = parseJsonlRows<IndexEntry>(await fs.readFile(file, 'utf8'))
    return new Map(rows.flatMap(({ value }) =>
      typeof value.id === 'string' ? [[value.id, value] as const] : []))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }
}

function assertRef(ref: SourceSessionRef, sessionsRoot: string): string[] {
  if (ref.source !== 'codex') throw new Error('invalid Codex session reference')
  const files = [...new Set(ref.locators ?? [ref.locator])].map(file => path.resolve(file))
  if (files.length === 0) throw new Error('invalid Codex session locator')
  for (const file of files) {
    if (!file.startsWith(`${sessionsRoot}${path.sep}`) || !/^rollout-.*\.jsonl$/.test(path.basename(file))) {
      throw new Error('invalid Codex session locator')
    }
  }
  return files
}

function indexSignature(entry: IndexEntry | undefined): string {
  return JSON.stringify({
    threadName: entry?.thread_name?.trim() ?? '',
    updatedAt: entry?.updated_at ?? '',
  })
}

function sourceEventId(page: number, row: JsonlRow<CodexEnvelope>): string {
  const ordinal = typeof row.value.ordinal === 'number' ? row.value.ordinal : row.line - 1
  return `page:${page}:line:${row.line}:ordinal:${ordinal}`
}

function pageOrder(file: string): number {
  const match = path.basename(file).match(/_(\d+)\.jsonl$/)
  return match === null ? 0 : Number(match[1])
}

function comparePages(left: DiscoveredPage, right: DiscoveredPage): number {
  return left.pageTime - right.pageTime
    || pageOrder(left.file) - pageOrder(right.file)
    || left.file.localeCompare(right.file)
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

async function readPage(file: string, stat: Awaited<ReturnType<typeof fs.stat>>): Promise<PageCacheEntry> {
  const initial = await readJsonlRowsFrom<CodexEnvelope>(file)
  return {
    rows: initial.nextOffset === stat.size
      ? initial.rows
      : await readJsonlRows<CodexEnvelope>(file),
    fileSize: Number(stat.size),
    fileMtimeMs: Number(stat.mtimeMs),
    nextOffset: initial.nextOffset,
    nextLine: initial.nextLine,
    boundarySignature: await boundarySignature(file, initial.nextOffset),
  }
}

async function discoverPage(file: string): Promise<DiscoveredPage> {
  const header = parseJsonlRows<CodexEnvelope>(`${await readFirstLine(file)}\n`)[0]?.value
  const payload = object(header?.payload)
  if (header?.type !== 'session_meta') throw new Error('missing Codex session_meta header')
  const sourceSessionId = string(payload.id) ?? string(payload.session_id)
  if (sourceSessionId === undefined) throw new Error('missing Codex session id')
  const stat = await fs.stat(file)
  return {
    file,
    sourceSessionId,
    cwd: string(payload.cwd),
    rawVersion: string(payload.cli_version),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    pageTime: time(payload.timestamp) || time(header.timestamp)
      || Number(stat.birthtimeMs) || Number(stat.mtimeMs),
  }
}

export class CodexSource implements SessionSource {
  readonly id = 'codex' as const
  private readonly cache: WeightedLruCache<string, CacheEntry>
  private readonly pagesByFile = new Map<string, DiscoveredPage>()
  private readonly filesBySession = new Map<string, Set<string>>()
  private readonly indexedDirectories = new Map<string, IndexedDirectory>()
  private readonly pendingRollouts = new Map<string, string>()
  private pageIndexInitialized = false
  private pageIndexRefresh?: Promise<void>
  private sessionIndexCache?: CachedSessionIndex
  private sessionIndexRead?: Promise<Map<string, IndexEntry>>
  private readonly sessionsRoot: string
  private readonly sessionIndexFile: string
  private readonly projectionWorker: ProjectionWorkerClient
  private readonly projectionNamespace = `codex-source:${++codexSourceInstances}`

  constructor(options: CodexSourceOptions = {}) {
    this.sessionsRoot = path.resolve(options.sessionsRoot ?? codexSessionsRoot)
    this.sessionIndexFile = path.resolve(options.sessionIndexFile ?? sessionIndexFile)
    this.projectionWorker = options.projectionWorker ?? defaultProjectionWorker
    this.cache = new WeightedLruCache<string, CacheEntry>({
      maxEntries: options.cacheEntries ?? 8,
      maxWeight: options.cacheBytes ?? 96 * 1024 * 1024,
      weight: entry => jsonWeight(entry.detail)
        + jsonWeight([...entry.pages.entries()]),
    })
  }

  metrics() {
    return { cache: this.cache.metrics() }
  }

  private addPage(page: DiscoveredPage): void {
    this.pendingRollouts.delete(page.file)
    const previous = this.pagesByFile.get(page.file)
    if (previous?.sourceSessionId !== undefined
      && previous.sourceSessionId !== page.sourceSessionId) {
      const previousFiles = this.filesBySession.get(previous.sourceSessionId)
      previousFiles?.delete(page.file)
      if (previousFiles?.size === 0) this.filesBySession.delete(previous.sourceSessionId)
    }
    this.pagesByFile.set(page.file, page)
    const files = this.filesBySession.get(page.sourceSessionId) ?? new Set<string>()
    files.add(page.file)
    this.filesBySession.set(page.sourceSessionId, files)
  }

  private removePage(file: string): void {
    this.pendingRollouts.delete(file)
    const page = this.pagesByFile.get(file)
    if (page === undefined) return
    this.pagesByFile.delete(file)
    const files = this.filesBySession.get(page.sourceSessionId)
    files?.delete(file)
    if (files?.size === 0) this.filesBySession.delete(page.sourceSessionId)
  }

  private removeDirectory(directory: string): void {
    const prefix = `${directory}${path.sep}`
    for (const indexed of [...this.indexedDirectories.keys()]) {
      if (indexed === directory || indexed.startsWith(prefix)) {
        this.indexedDirectories.delete(indexed)
      }
    }
    for (const file of [...this.pagesByFile.keys()]) {
      if (file.startsWith(prefix)) this.removePage(file)
    }
    for (const file of [...this.pendingRollouts.keys()]) {
      if (file.startsWith(prefix)) this.pendingRollouts.delete(file)
    }
  }

  private async scanDirectory(directory: string, recursive: boolean): Promise<void> {
    let stat
    let entries
    try {
      stat = await fs.stat(directory)
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.removeDirectory(directory)
        return
      }
      throw error
    }
    const childDirectories = new Set(entries
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(directory, entry.name)))
    const rolloutFiles = new Set(entries
      .filter(entry => entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name))
      .map(entry => path.join(directory, entry.name)))
    const previous = this.indexedDirectories.get(directory)
    for (const file of previous?.rolloutFiles ?? []) {
      if (!rolloutFiles.has(file)) {
        this.removePage(file)
        this.pendingRollouts.delete(file)
      }
    }
    for (const child of previous?.childDirectories ?? []) {
      if (!childDirectories.has(child)) this.removeDirectory(child)
    }
    this.indexedDirectories.set(directory, {
      signature: statSignature(stat),
      childDirectories,
      rolloutFiles,
    })

    const unknownFiles = [...rolloutFiles].filter(file => !this.pagesByFile.has(file))
    const discovered = await Promise.all(unknownFiles.map(async (file) => {
      const fileStat = await fs.stat(file)
      try {
        return {
          file,
          signature: statSignature(fileStat),
          page: await discoverPage(file),
        }
      } catch {
        return {
          file,
          signature: statSignature(fileStat),
        }
      }
    }))
    for (const result of discovered) {
      if (result.page === undefined) {
        this.pendingRollouts.set(result.file, result.signature)
      } else {
        this.addPage(result.page)
      }
    }
    await Promise.all([...childDirectories].map(child =>
      recursive || !this.indexedDirectories.has(child)
        ? this.scanDirectory(child, true)
        : Promise.resolve()))
  }

  private async refreshPageIndex(): Promise<void> {
    if (this.pageIndexRefresh !== undefined) return this.pageIndexRefresh
    const refresh = async (): Promise<void> => {
      if (!this.pageIndexInitialized || !this.indexedDirectories.has(this.sessionsRoot)) {
        await this.scanDirectory(this.sessionsRoot, true)
        this.pageIndexInitialized = true
        return
      }
      const indexed = [...this.indexedDirectories]
      const stats = await Promise.allSettled(indexed.map(([directory]) => fs.stat(directory)))
      const changed: string[] = []
      indexed.forEach(([directory, snapshot], index) => {
        const result = stats[index]!
        if (result.status === 'rejected') {
          if ((result.reason as NodeJS.ErrnoException).code === 'ENOENT') {
            this.removeDirectory(directory)
            return
          }
          throw result.reason
        }
        const stat = result.value
        const signature = statSignature(stat)
        if (signature !== snapshot.signature) changed.push(directory)
      })
      changed.sort((left, right) => left.length - right.length)
      for (const directory of changed) {
        if (this.indexedDirectories.has(directory)) {
          await this.scanDirectory(directory, false)
        }
      }
      const pending = [...this.pendingRollouts]
      const pendingStats = await Promise.allSettled(
        pending.map(([file]) => fs.stat(file)),
      )
      for (let index = 0; index < pending.length; index++) {
        const [file, previousSignature] = pending[index]!
        const result = pendingStats[index]!
        if (result.status === 'rejected') {
          if ((result.reason as NodeJS.ErrnoException).code === 'ENOENT') {
            this.pendingRollouts.delete(file)
            continue
          }
          throw result.reason
        }
        const signature = statSignature(result.value)
        if (signature === previousSignature) continue
        try {
          this.addPage(await discoverPage(file))
        } catch {
          this.pendingRollouts.set(file, signature)
        }
      }
    }
    this.pageIndexRefresh = refresh().finally(() => {
      this.pageIndexRefresh = undefined
    })
    return this.pageIndexRefresh
  }

  private async sessionIndex(): Promise<Map<string, IndexEntry>> {
    if (this.sessionIndexRead !== undefined) return this.sessionIndexRead
    const read = async (): Promise<Map<string, IndexEntry>> => {
      let signature = 'missing'
      try {
        signature = statSignature(await fs.stat(this.sessionIndexFile))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (this.sessionIndexCache?.signature === signature) {
        return this.sessionIndexCache.entries
      }
      const entries = signature === 'missing'
        ? new Map<string, IndexEntry>()
        : await readIndex(this.sessionIndexFile)
      this.sessionIndexCache = { signature, entries }
      return entries
    }
    this.sessionIndexRead = read().finally(() => {
      this.sessionIndexRead = undefined
    })
    return this.sessionIndexRead
  }

  private async sessionFiles(ref: SourceSessionRef): Promise<string[]> {
    const safe = assertRef(ref, this.sessionsRoot)
    await this.refreshPageIndex()
    let pages = [...(this.filesBySession.get(ref.sourceSessionId) ?? [])]
      .flatMap(file => {
        const page = this.pagesByFile.get(file)
        return page === undefined ? [] : [page]
      })
    if (pages.length === 0) {
      const discovered = await Promise.allSettled(safe.map(discoverPage))
      for (const result of discovered) {
        if (result.status === 'fulfilled') this.addPage(result.value)
      }
      pages = discovered.flatMap(result =>
        result.status === 'fulfilled' && result.value.sourceSessionId === ref.sourceSessionId
          ? [result.value]
          : [])
    }
    if (pages.length === 0) {
      throw Object.assign(new Error('Codex session pages are missing'), { code: 'ENOENT' })
    }
    const files = pages
      .sort(comparePages)
      .map(page => page.file)
    return files
  }

  async probe(): Promise<SourceStatus> {
    try {
      await fs.access(this.sessionsRoot)
      const headers = await probeRolloutHeaders(this.sessionsRoot)
      const hasSupported = headers.types.includes('session_meta')
      const unsupported = headers.types.filter(type => type !== 'session_meta')
      const detectedProtocols = [
        ...(hasSupported ? ['codex-rollout-v1'] : []),
        ...unsupported.map(type => `codex-rollout-header:${type}`),
        ...(headers.malformed ? ['codex-rollout-header:incomplete'] : []),
      ]
      const detected = detectedProtocols.length === 0
        ? 'codex-rollout:none'
        : detectedProtocols.join(',')
      const protocol = {
        detected,
        supported: SUPPORTED_CODEX_PROTOCOLS,
        fingerprint: headers.types.length === 0
          ? headers.malformed
            ? 'codex:rollout:incomplete'
            : 'codex:rollout:none'
          : `codex:rollout:${[
              ...headers.types,
              ...(headers.malformed ? ['incomplete'] : []),
            ].join(',')}`,
      }
      if (!hasSupported
        && unsupported.length > 0
        && !headers.malformed
        && headers.complete) {
        return {
          source: this.id,
          availability: 'blocked',
          ...sourceMetadata(this.id),
          sessionCount: 0,
          capabilities: CODEX_CAPABILITIES,
          reason: 'unsupported_codex_protocol',
          detail: `检测到 ${detected}；当前仅支持 ${SUPPORTED_CODEX_PROTOCOLS.join(', ')}`,
          protocol,
        }
      }
      const degraded = unsupported.length > 0 || headers.malformed
      return {
        source: this.id,
        availability: degraded ? 'degraded' : 'available',
        ...sourceMetadata(this.id),
        sessionCount: 0,
        capabilities: CODEX_CAPABILITIES,
        ...(unsupported.length > 0 && hasSupported
          ? {
              reason: 'additional_codex_protocols_ignored',
              detail: `继续读取 ${SUPPORTED_CODEX_PROTOCOLS.join(', ')}；已忽略未知协议：${
                unsupported.map(type => `codex-rollout-header:${type}`).join(', ')
              }`,
            }
          : headers.malformed
          ? {
              reason: 'codex_rollout_header_incomplete',
              detail: '检测到仍在写入或不完整的 Codex rollout 首行；稍后会自动重试',
            }
          : !headers.complete
            ? {
                reason: 'codex_protocol_probe_bounded',
                detail: '协议探测已达到本地扫描上限；会话发现将在后台继续',
              }
          : {}),
        protocol,
      }
    } catch {
      return {
        source: this.id,
        availability: 'blocked',
        ...sourceMetadata(this.id),
        sessionCount: 0,
        capabilities: CODEX_CAPABILITIES,
        reason: 'sessions_directory_missing',
        detail: '未找到 Codex rollout 目录',
      }
    }
  }

  async list(): Promise<readonly SourceSessionRef[]> {
    await this.refreshPageIndex()
    const index = await this.sessionIndex()
    const pages = [...this.pagesByFile.values()]
    const grouped = new Map<string, DiscoveredPage[]>()
    for (const page of pages) {
      grouped.set(page.sourceSessionId, [...(grouped.get(page.sourceSessionId) ?? []), page])
    }
    const refs = [...grouped].map(([sourceSessionId, unordered]): SourceSessionRef => {
      const ordered = unordered.sort(comparePages)
      const first = ordered[0]!
      const latest = ordered.at(-1)!
      const indexed = index.get(sourceSessionId)
      const cwd = [...ordered].reverse()
        .map(page => page.cwd)
        .find(value => value !== undefined && value !== '') ?? ''
      const title = indexed?.thread_name?.trim()
        || path.basename(cwd)
        || `Codex · ${sourceSessionId.slice(0, 8)}`
      const indexedTime = time(indexed?.updated_at)
      const locators = ordered.map(page => page.file)
      const summary: SessionSummary = {
        id: sessionKey(this.id, sourceSessionId),
        source: this.id,
        sourceSessionId,
        format: 'codex-rollout-jsonl',
        capabilities: CODEX_CAPABILITIES,
        cwd,
        title: title.length > 80 ? `${title.slice(0, 79)}…` : title,
        createdAt: first.pageTime,
        updatedAt: Math.max(...ordered.map(page => page.mtimeMs), indexedTime),
        size: ordered.reduce((total, page) => total + page.size, 0),
        rawVersion: latest.rawVersion ?? first.rawVersion,
      }
      return {
        source: this.id,
        sourceSessionId,
        locator: locators[0]!,
        locators,
        summary,
      }
    })
    return refs.sort((a, b) => b.summary.updatedAt - a.summary.updatedAt)
  }

  async listDetailed() {
    const refs = await this.list()
    const failures = [...this.pendingRollouts.keys()].map(file => ({
      locator: file,
      reason: 'Codex rollout header is incomplete or unsupported',
    }))
    return {
      refs,
      diagnostics: {
        scanned: this.pagesByFile.size + failures.length,
        loaded: refs.length,
        failed: failures.length,
        failures,
      },
    }
  }

  async fingerprint(ref: SourceSessionRef): Promise<string> {
    const files = await this.sessionFiles(ref)
    const stats = await Promise.all(files.map(file => fs.stat(file)))
    const index = await this.sessionIndex()
    return [
      ...stats.map((stat, page) => `${page}:${stat.mtimeMs}:${stat.size}`),
      `index:${indexSignature(index.get(ref.sourceSessionId))}`,
    ].join('|')
  }

  async audit(ref: SourceSessionRef) {
    const files = await this.sessionFiles(ref)
    const events = (await Promise.all(files.map(async (file, page) =>
      (await readJsonlRows<CodexEnvelope>(file)).map(row => ({
        ...row.value,
        metadata: {
          ...object(row.value.metadata),
          source_event_id: sourceEventId(page, row),
          original_ordinal: row.value.ordinal,
          page,
          line: row.line,
        },
      }))))).flat()
    return completeAudit(events, { envelopes: events })
  }

  async load(ref: SourceSessionRef): Promise<SessionDetail> {
    const files = await this.sessionFiles(ref)
    const signature = await this.fingerprint(ref)
    const hit = this.cache.get(ref.sourceSessionId)
    if (hit?.signature === signature) return hit.detail

    const pages = new Map<string, PageCacheEntry>()
    const previousFiles = hit === undefined ? [] : [...hit.pages.keys()]
    let appendOnly = hit !== undefined
      && previousFiles.length <= files.length
      && previousFiles.every((file, index) => files[index] === file)
    const previousEnvelopeCount = previousFiles.reduce(
      (total, file) => total + (hit?.pages.get(file)?.rows.length ?? 0),
      0,
    )
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex]!
      const stat = await fs.stat(file)
      const cachedPage = hit?.pages.get(file)
      if (cachedPage !== undefined
        && cachedPage.fileSize === stat.size
        && cachedPage.fileMtimeMs === stat.mtimeMs) {
        pages.set(file, cachedPage)
        continue
      }
      const canResume = cachedPage?.nextOffset !== undefined
        && cachedPage.nextLine !== undefined
        && cachedPage.boundarySignature !== undefined
        && stat.size > cachedPage.fileSize
        && await boundarySignature(file, cachedPage.nextOffset) === cachedPage.boundarySignature
      if (canResume) {
        try {
          const appended = await readJsonlRowsFrom<CodexEnvelope>(
            file,
            cachedPage.nextOffset!,
            cachedPage.nextLine!,
          )
          pages.set(file, {
            rows: [...cachedPage.rows, ...appended.rows],
            fileSize: Number(stat.size),
            fileMtimeMs: Number(stat.mtimeMs),
            nextOffset: appended.nextOffset,
            nextLine: appended.nextLine,
            boundarySignature: await boundarySignature(file, appended.nextOffset),
          })
          if (fileIndex < previousFiles.length - 1) appendOnly = false
          continue
        } catch {
          // A valid rewrite can be larger than the cached file. Rebuild this page once.
        }
      }
      if (cachedPage !== undefined) appendOnly = false
      if (cachedPage === undefined && fileIndex < previousFiles.length) appendOnly = false
      pages.set(file, await readPage(file, stat))
    }
    let ordinalBase = 0
    const envelopes = files.flatMap((file, page) => {
      const pageRows = pages.get(file)!.rows
      const pageBase = ordinalBase
      ordinalBase += pageRows.length
      return pageRows.map((row, index) => ({
        ...row.value,
        ordinal: pageBase + index,
        metadata: {
          ...object(row.value.metadata),
          source_event_id: sourceEventId(page, row),
          original_ordinal: row.value.ordinal,
          page,
          line: row.line,
        },
      }))
    })
    const projection = await this.projectionWorker.projectCodex(
      `${this.projectionNamespace}:${ref.sourceSessionId}`,
      envelopes,
      appendOnly ? envelopes.slice(previousEnvelopeCount) : undefined,
    )
    if (projection.header.id !== ref.sourceSessionId) {
      throw new Error('Codex session id does not match its safe locator')
    }
    const index = await this.sessionIndex()
    const indexed = index.get(ref.sourceSessionId)
    const stats = await Promise.all(files.map(file => fs.stat(file)))
    const indexedTitle = indexed?.thread_name?.trim()
    const cwd = projection.header.cwd ?? ref.summary.cwd
    const fallbackTitle = path.basename(cwd) || `Codex · ${ref.sourceSessionId.slice(0, 8)}`
    const title = indexedTitle || fallbackTitle
    const summary: SessionSummary = {
      ...ref.summary,
      cwd,
      title: title.length > 80 ? `${title.slice(0, 79)}…` : title,
      createdAt: typeof projection.header.createdAt === 'number'
        ? projection.header.createdAt
        : time(projection.header.createdAt),
      updatedAt: Math.max(...stats.map(stat => stat.mtimeMs), time(indexed?.updated_at)),
      size: stats.reduce((total, stat) => total + stat.size, 0),
      rawVersion: projection.header.rawVersion,
      eventCount: projection.eventCount,
    }
    const detail = { summary, projection }
    this.cache.set(ref.sourceSessionId, {
      signature,
      detail,
      pages,
    })
    return detail
  }
}
