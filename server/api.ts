import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  SessionDetail,
  SessionDetailResponse,
  SessionSummary,
  SourceId,
  SourceStatus,
  TransportSessionDetail,
  TransportTrajectoryRecord,
} from '../src/types'
import { redactSensitive } from '../src/projector-utils'
import { jsonWeight, WeightedLruCache } from './lru'
import { hasAllowedLocalRequest } from './security'

export interface ApiRegistry {
  listSources(): Promise<SourceStatus[]>
  listSessions(source?: SourceId | 'all'): Promise<SessionSummary[]>
  load(source: SourceId, sourceSessionId: string): Promise<SessionDetail | undefined>
  fingerprint(source: SourceId, sourceSessionId: string): Promise<string | undefined>
  raw?(
    source: SourceId,
    sourceSessionId: string,
    recordId: string,
  ): Promise<unknown[] | undefined>
}

export interface ApiOptions {
  registry: ApiRegistry
  streamIntervalMs?: number
}

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

function sendDownloadJson(
  response: ServerResponse,
  filename: string,
  payload: unknown,
): void {
  const body = JSON.stringify(payload)
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

export function sendError(response: ServerResponse, status: number, error: unknown): void {
  sendJson(response, status, {
    error: error instanceof Error ? error.message : String(error),
  })
}

export function sourceId(value: string | null): SourceId | undefined {
  return value === 'dsh' || value === 'codex' || value === 'zcode'
    ? value
    : undefined
}

function decodePathSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

const DETAIL_PREVIEW_BYTES = 16 * 1024
const DETAIL_REVISION_HISTORY = 2
const DETAIL_REVISION_CACHE_ENTRIES = 64
const DETAIL_REVISION_CACHE_BYTES = 64 * 1024 * 1024

interface DetailRevision {
  revision: string
  detail: TransportSessionDetail
  serializedRecords: ReadonlyMap<string, string>
  projection: Omit<TransportSessionDetail['projection'], 'records'>
  recordOrder: string[]
}

const detailRevisions = new WeightedLruCache<string, DetailRevision[]>({
  maxEntries: DETAIL_REVISION_CACHE_ENTRIES,
  maxWeight: DETAIL_REVISION_CACHE_BYTES,
  weight: jsonWeight,
})
const preparedDetails = new WeakMap<SessionDetail, DetailRevision>()

function boundedPreview(value: unknown): unknown {
  if (value === undefined) return undefined
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  if (serialized === undefined) return value
  const bytes = Buffer.from(serialized)
  if (bytes.length <= DETAIL_PREVIEW_BYTES) return value
  return {
    truncated: true,
    originalBytes: bytes.length,
    preview: new TextDecoder().decode(bytes.subarray(0, DETAIL_PREVIEW_BYTES)),
  }
}

function transportRecord(
  record: SessionDetail['projection']['records'][number],
): TransportTrajectoryRecord {
  const { raw: _raw, searchText: _searchText, ...transport } = record
  return {
    ...transport,
    input: boundedPreview(record.input),
    output: boundedPreview(record.output),
  }
}

function transportDetail(detail: SessionDetail): TransportSessionDetail {
  return {
    ...detail,
    projection: {
      ...detail.projection,
      records: detail.projection.records.map(transportRecord),
    },
  }
}

function auditDetail(detail: SessionDetail): SessionDetail {
  return redactSensitive({
    ...detail,
    projection: {
      ...detail.projection,
      records: detail.projection.records.map((record) => {
        const { searchText: _searchText, ...auditRecord } = record
        return auditRecord as SessionDetail['projection']['records'][number]
      }),
    },
  }) as SessionDetail
}

function downloadFilename(source: SourceId, id: string): string {
  const safeId = id.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'session'
  return `${source}-${safeId}.audit.json`
}

function revisionHistory(key: string): DetailRevision[] {
  return detailRevisions.get(key) ?? []
}

function rememberRevision(key: string, revision: DetailRevision): void {
  const history = revisionHistory(key)
  if (history.at(-1)?.revision === revision.revision) return
  const current = history.filter(entry => entry.revision !== revision.revision)
  detailRevisions.set(key, [...current, revision].slice(-DETAIL_REVISION_HISTORY))
}

function preparedDetail(detail: SessionDetail): DetailRevision {
  const cached = preparedDetails.get(detail)
  if (cached !== undefined) return cached
  const transport = transportDetail(detail)
  const revision = createHash('sha256')
    .update(JSON.stringify(transport))
    .digest('base64url')
  const serializedRecords = new Map(transport.projection.records.map(record => [
    record.id,
    JSON.stringify(record),
  ]))
  const { records: _records, ...projection } = transport.projection
  const prepared = {
    revision,
    detail: transport,
    serializedRecords,
    projection,
    recordOrder: transport.projection.records.map(record => record.id),
  }
  preparedDetails.set(detail, prepared)
  return prepared
}

function emptyDelta(current: DetailRevision): SessionDetailResponse {
  return {
    kind: 'delta',
    baseRevision: current.revision,
    revision: current.revision,
    summary: current.detail.summary,
    projection: current.projection,
    upserts: [],
    removedIds: [],
    recordOrder: current.recordOrder,
  }
}

function detailResponse(
  key: string,
  detail: SessionDetail,
  requestedRevision: string | null,
): SessionDetailResponse {
  const current = preparedDetail(detail)
  if (requestedRevision === current.revision) {
    rememberRevision(key, current)
    return emptyDelta(current)
  }
  const previous = requestedRevision === null
    ? undefined
    : revisionHistory(key).find(entry => entry.revision === requestedRevision)
  rememberRevision(key, current)
  if (previous === undefined) {
    return { kind: 'snapshot', revision: current.revision, detail: current.detail }
  }
  const after = new Set(current.recordOrder)
  const upserts = current.detail.projection.records.filter(record =>
    previous.serializedRecords.get(record.id) !== current.serializedRecords.get(record.id))
  const removedIds = previous.detail.projection.records
    .map(record => record.id)
    .filter(id => !after.has(id))
  return {
    kind: 'delta',
    baseRevision: previous.revision,
    revision: current.revision,
    summary: current.detail.summary,
    projection: current.projection,
    upserts,
    removedIds,
    recordOrder: current.recordOrder,
  }
}

export async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: ApiOptions,
): Promise<boolean> {
  if (url.pathname.startsWith('/api/') && !hasAllowedLocalRequest(request)) {
    sendJson(response, 403, { error: 'forbidden host' })
    return true
  }
  if (url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true })
    return true
  }
  if (url.pathname === '/api/sources') {
    sendJson(response, 200, await options.registry.listSources())
    return true
  }
  if (url.pathname === '/api/sessions') {
    const requested = url.searchParams.get('source') ?? 'all'
    if (requested !== 'all' && sourceId(requested) === undefined) {
      sendJson(response, 400, { error: 'invalid source' })
      return true
    }
    sendJson(
      response,
      200,
      await options.registry.listSessions(requested === 'all' ? 'all' : sourceId(requested)!),
    )
    return true
  }
  const rawMatch = url.pathname.match(
    /^\/api\/sessions\/([^/]+)\/([^/]+)\/records\/([^/]+)\/raw$/,
  )
  if (rawMatch !== null) {
    const decodedSource = decodePathSegment(rawMatch[1])
    const id = decodePathSegment(rawMatch[2])
    const recordId = decodePathSegment(rawMatch[3])
    if (decodedSource === undefined || id === undefined || recordId === undefined) {
      sendJson(response, 400, { error: 'invalid path encoding' })
      return true
    }
    const source = sourceId(decodedSource)
    if (source === undefined) {
      sendJson(response, 400, { error: 'invalid source' })
      return true
    }
    const raw = await options.registry.raw?.(source, id, recordId)
    if (raw === undefined) {
      sendJson(response, 404, { error: 'record not found' })
    } else {
      sendJson(response, 200, { raw: redactSensitive(raw) })
    }
    return true
  }
  const exportMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/export$/)
  if (exportMatch !== null) {
    const decodedSource = decodePathSegment(exportMatch[1])
    const id = decodePathSegment(exportMatch[2])
    if (decodedSource === undefined || id === undefined) {
      sendJson(response, 400, { error: 'invalid path encoding' })
      return true
    }
    const source = sourceId(decodedSource)
    if (source === undefined) {
      sendJson(response, 400, { error: 'invalid source' })
      return true
    }
    const detail = await options.registry.load(source, id)
    if (detail === undefined) {
      sendJson(response, 404, { error: 'session not found' })
    } else {
      sendDownloadJson(response, downloadFilename(source, id), {
        format: 'agent-trajectory-audit',
        version: 1,
        detail: auditDetail(detail),
      })
    }
    return true
  }
  const sourcedMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)$/)
  if (sourcedMatch !== null) {
    const decodedSource = decodePathSegment(sourcedMatch[1])
    const id = decodePathSegment(sourcedMatch[2])
    if (decodedSource === undefined || id === undefined) {
      sendJson(response, 400, { error: 'invalid path encoding' })
      return true
    }
    const source = sourceId(decodedSource)
    if (source === undefined) {
      sendJson(response, 400, { error: 'invalid source' })
      return true
    }
    const detail = await options.registry.load(source, id)
    if (detail === undefined) {
      sendJson(response, 404, { error: 'session not found' })
    } else {
      sendJson(response, 200, detailResponse(
        `${source}:${id}`,
        detail,
        url.searchParams.get('revision'),
      ))
    }
    return true
  }
  if (url.pathname === '/api/stream') {
    const id = url.searchParams.get('session')
    const requestedSource = url.searchParams.get('source')
    const source = requestedSource === null ? 'dsh' : sourceId(requestedSource)
    if (source === undefined) {
      sendJson(response, 400, { error: 'invalid source' })
      return true
    }
    if (id === null || id === '') {
      sendJson(response, 400, { error: 'missing session id' })
      return true
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    response.write('retry: 1500\n\n')
    const interval = options.streamIntervalMs ?? 1_500
    let lastVersion = ''
    let active = true
    let failures = 0
    let timer: NodeJS.Timeout | undefined
    const write = (chunk: string): void => {
      if (active && !response.destroyed && !response.writableEnded) response.write(chunk)
    }
    const publish = async (): Promise<void> => {
      try {
        const version = await options.registry.fingerprint(source, id)
        if (!active) return
        failures = 0
        if (version === undefined) {
          write('event: missing\ndata: {}\n\n')
          return
        }
        if (version === lastVersion) {
          write(': keepalive\n\n')
          return
        }
        lastVersion = version
        write(`event: update\ndata: ${JSON.stringify({ version })}\n\n`)
      } catch {
        if (!active) return
        failures++
        write('event: error\ndata: {"error":"source fingerprint failed"}\n\n')
      }
    }
    const poll = async (): Promise<void> => {
      await publish()
      if (!active) return
      const delay = interval * 2 ** Math.min(failures, 4)
      timer = setTimeout(() => void poll(), delay)
    }
    const close = (): void => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
    request.once('close', close)
    response.once('close', close)
    await publish()
    if (active) timer = setTimeout(() => void poll(), interval)
    return true
  }
  if (url.pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'not found' })
    return true
  }
  return false
}
