import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  isSourceId,
  type SessionDetail,
  type SessionDetailResponse,
  type SessionSummary,
  type SourceId,
  type SourceStatus,
  type TransportSessionDetail,
  type TransportTrajectoryRecord,
} from '../src/types'
import type {
  AnnotationReviewer,
  AnnotationSaveRequest,
  EvaluationRunRequest,
  PrepareEvaluationDatasetRequest,
} from '../src/annotation-types'
import type { TrajectoryDiagnosisPromptRequest } from '../src/diagnosis-types'
import { redactSensitive } from '../src/projector-utils'
import { analyzeTrajectory, type TrajectoryAnalysis } from '../src/trajectory-analysis'
import {
  applyFactsQualityGate,
  evaluateTrajectory,
} from '../src/trajectory-evaluation'
import {
  DiagnosisRequestError,
  type TrajectoryDiagnosisService,
} from './diagnosis/service'
import { jsonWeight, WeightedLruCache } from './lru'
import { hasAllowedLocalRequest } from './security'
import {
  SessionFormatError,
  sourceApplicationIcons,
  type SourceAuditBundle,
} from './sources/types'
import {
  AnnotationConflictError,
  AnnotationInputError,
  AnnotationNotFoundError,
  type AnnotationWorkspaceStore,
} from './evaluation/annotation-workspace'

export interface ApiRegistry {
  listSources(): Promise<SourceStatus[]>
  listSessions(source?: SourceId | 'all'): Promise<SessionSummary[]>
  load(source: SourceId, sourceSessionId: string): Promise<SessionDetail | undefined>
  fingerprint(source: SourceId, sourceSessionId: string): Promise<string | undefined>
  metrics?(): unknown
  raw?(
    source: SourceId,
    sourceSessionId: string,
    recordId: string,
  ): Promise<unknown[] | undefined>
  audit?(
    source: SourceId,
    sourceSessionId: string,
  ): Promise<SourceAuditBundle | undefined>
}

export interface ApiOptions {
  annotations?: AnnotationWorkspaceStore
  diagnosis?: TrajectoryDiagnosisService
  registry: ApiRegistry
  state?: ApiSessionState
  streamIntervalMs?: number
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413 | 500 | 503,
    readonly code: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

function annotationReviewer(value: string | undefined): AnnotationReviewer | undefined {
  return value === 'reviewer-a' || value === 'reviewer-b' ? value : undefined
}

function annotationActor(
  value: string | undefined,
): AnnotationReviewer | 'adjudicator' | undefined {
  return value === 'adjudicator' ? value : annotationReviewer(value)
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

async function sendSourceIcon(
  response: ServerResponse,
  source: SourceId,
): Promise<void> {
  for (const file of sourceApplicationIcons(source)) {
    try {
      const extension = path.extname(file).toLowerCase()
      const body = extension === '.icns'
        ? await convertIcnsToPng(file)
        : await fs.readFile(file)
      const contentType = extension === '.svg'
        ? 'image/svg+xml'
        : extension === '.webp'
          ? 'image/webp'
          : 'image/png'
      response.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': body.byteLength,
        'Cache-Control': 'private, max-age=3600',
        ...(extension === '.svg'
          ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }
          : {}),
        'X-Content-Type-Options': 'nosniff',
      })
      response.end(body)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  sendJson(response, 404, { error: 'source application icon unavailable' })
}

async function convertIcnsToPng(file: string): Promise<Buffer> {
  const temporaryRoot = await fs.mkdtemp(
    path.join(tmpdir(), 'agent-trajectory-source-icon-'),
  )
  const output = path.join(temporaryRoot, 'icon.png')
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        '/usr/bin/sips',
        ['-s', 'format', 'png', file, '--out', output],
        { timeout: 5_000, windowsHide: true },
        error => error === null ? resolve() : reject(error),
      )
    })
    return await fs.readFile(output)
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {})
  }
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
  const selectedStatus = error instanceof HttpError ? error.status : status
  sendJson(response, selectedStatus, {
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof HttpError ? { code: error.code } : {}),
  })
}

export function sourceId(value: string | null): SourceId | undefined {
  return isSourceId(value) ? value : undefined
}

function decodePathSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

function readJsonBody(request: IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let failed = false
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        if (!failed) {
          failed = true
          reject(new HttpError('request body too large', 413, 'request_body_too_large'))
        }
        return
      }
      if (!failed) chunks.push(chunk)
    })
    request.on('end', () => {
      if (failed) return
      try {
        resolve(chunks.length === 0
          ? {}
          : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new HttpError('invalid JSON body', 400, 'invalid_json'))
      }
    })
    request.on('error', error => {
      if (!failed) reject(error)
    })
  })
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function annotationSaveRequest(value: unknown): AnnotationSaveRequest {
  const source = object(value)
  if (typeof source.datasetHash !== 'string'
    || typeof source.revision !== 'string'
    || source.annotation === null
    || typeof source.annotation !== 'object'
    || Array.isArray(source.annotation)) {
    throw new HttpError(
      'invalid annotation save request',
      400,
      'invalid_annotation_request',
    )
  }
  return {
    datasetHash: source.datasetHash,
    revision: source.revision,
    annotation: source.annotation as AnnotationSaveRequest['annotation'],
  }
}

function evaluationRunRequest(value: unknown): EvaluationRunRequest {
  const source = object(value)
  if (source.split !== 'calibration'
    && source.split !== 'regression'
    && source.split !== 'independent') {
    throw new HttpError(
      'invalid evaluation split',
      400,
      'invalid_evaluation_request',
    )
  }
  if (source.baselineRunId !== undefined
    && (typeof source.baselineRunId !== 'string'
      || !/^[A-Za-z0-9_-]{20,80}$/.test(source.baselineRunId))) {
    throw new HttpError(
      'invalid baseline run id',
      400,
      'invalid_evaluation_request',
    )
  }
  if (source.confirmIndependent !== undefined
    && typeof source.confirmIndependent !== 'boolean') {
    throw new HttpError(
      'invalid independent confirmation',
      400,
      'invalid_evaluation_request',
    )
  }
  return {
    split: source.split,
    baselineRunId: source.baselineRunId,
    confirmIndependent: source.confirmIndependent,
  }
}

function prepareEvaluationDatasetRequest(
  value: unknown,
): PrepareEvaluationDatasetRequest {
  const source = object(value)
  if (typeof source.directoryId !== 'string'
    || typeof source.datasetId !== 'string'
    || typeof source.datasetVersion !== 'string'
    || !Number.isInteger(source.count)
    || typeof source.allowPartial !== 'boolean') {
    throw new HttpError(
      'invalid evaluation dataset preparation request',
      400,
      'invalid_evaluation_dataset_request',
    )
  }
  return {
    directoryId: source.directoryId,
    datasetId: source.datasetId,
    datasetVersion: source.datasetVersion,
    count: source.count as number,
    allowPartial: source.allowPartial,
  }
}

function diagnosisRequest(value: unknown): TrajectoryDiagnosisPromptRequest | undefined {
  const body = object(value)
  const target = object(body.target)
  const source = typeof target.source === 'string'
    ? sourceId(target.source)
    : undefined
  return source === undefined
    || typeof target.sessionId !== 'string'
    || target.sessionId.trim() === ''
    ? undefined
    : {
        target: { source, sessionId: target.sessionId },
      }
}

const DETAIL_PREVIEW_BYTES = 16 * 1024
const DETAIL_REVISION_HISTORY = 2
const DETAIL_REVISION_CACHE_ENTRIES = 64
const DETAIL_REVISION_CACHE_BYTES = 64 * 1024 * 1024

interface DetailRevision {
  revision: string
  detail: TransportSessionDetail
  analysis: TrajectoryAnalysis
  serializedRecords: ReadonlyMap<string, string>
  projection: Omit<TransportSessionDetail['projection'], 'records'>
  recordOrder: string[]
}

export class ApiSessionState {
  readonly detailRevisions = new WeightedLruCache<string, DetailRevision[]>({
    maxEntries: DETAIL_REVISION_CACHE_ENTRIES,
    maxWeight: DETAIL_REVISION_CACHE_BYTES,
    weight: jsonWeight,
  })

  preparedDetails = new WeakMap<SessionDetail, DetailRevision>()

  clear(): void {
    this.detailRevisions.clear()
    this.preparedDetails = new WeakMap()
  }

  metrics() {
    return {
      detailRevisions: this.detailRevisions.metrics(),
    }
  }
}

const fallbackStates = new WeakMap<ApiRegistry, ApiSessionState>()

function apiSessionState(options: ApiOptions): ApiSessionState {
  if (options.state !== undefined) return options.state
  const current = fallbackStates.get(options.registry)
  if (current !== undefined) return current
  const created = new ApiSessionState()
  fallbackStates.set(options.registry, created)
  return created
}

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

function transportModelContextRecordOverrides(
  overrides: SessionDetail['projection']['modelContextRecordOverrides'],
): SessionDetail['projection']['modelContextRecordOverrides'] {
  if (overrides === undefined) return undefined
  return Object.fromEntries(
    Object.entries(overrides).map(([recordId, override]) => {
      const safe = redactSensitive(override) as typeof override
      return [
        recordId,
        {
          ...safe,
          ...(safe.input === undefined
            ? {}
            : { input: boundedPreview(safe.input) }),
          ...(safe.output === undefined
            ? {}
            : { output: boundedPreview(safe.output) }),
        },
      ]
    }),
  )
}

function transportDetail(detail: SessionDetail): TransportSessionDetail {
  return redactSensitive({
    ...detail,
    projection: {
      ...detail.projection,
      records: detail.projection.records.map(transportRecord),
      modelContextRecordOverrides: transportModelContextRecordOverrides(
        detail.projection.modelContextRecordOverrides,
      ),
    },
  }) as TransportSessionDetail
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

function revisionHistory(state: ApiSessionState, key: string): DetailRevision[] {
  return state.detailRevisions.get(key) ?? []
}

function rememberRevision(
  state: ApiSessionState,
  key: string,
  revision: DetailRevision,
): void {
  const history = revisionHistory(state, key)
  if (history.at(-1)?.revision === revision.revision) return
  const current = history.filter(entry => entry.revision !== revision.revision)
  state.detailRevisions.set(key, [...current, revision].slice(-DETAIL_REVISION_HISTORY))
}

function preparedDetail(state: ApiSessionState, detail: SessionDetail): DetailRevision {
  const cached = state.preparedDetails.get(detail)
  if (cached !== undefined) return cached
  const transport = transportDetail(detail)
  const localAnalysis = analyzeTrajectory(detail)
  const analysis = redactSensitive(applyFactsQualityGate(
    localAnalysis,
    evaluateTrajectory(detail, localAnalysis, {
      target: {
        source: detail.summary.source,
        sourceSessionId: detail.summary.sourceSessionId,
        mode: detail.summary.capabilities.live ? 'live' : 'frozen',
        fingerprint: 'detail-response',
      },
    }),
  )) as TrajectoryAnalysis
  const revision = createHash('sha256')
    .update(JSON.stringify({ transport, analysis }))
    .digest('base64url')
  const serializedRecords = new Map(transport.projection.records.map(record => [
    record.id,
    JSON.stringify(record),
  ]))
  const { records: _records, ...projection } = transport.projection
  const prepared = {
    revision,
    detail: transport,
    analysis,
    serializedRecords,
    projection,
    recordOrder: transport.projection.records.map(record => record.id),
  }
  state.preparedDetails.set(detail, prepared)
  return prepared
}

function emptyDelta(current: DetailRevision): SessionDetailResponse {
  return {
    kind: 'delta',
    baseRevision: current.revision,
    revision: current.revision,
    summary: current.detail.summary,
    projection: current.projection,
    analysis: current.analysis,
    upserts: [],
    removedIds: [],
    recordOrder: current.recordOrder,
  }
}

function detailResponse(
  state: ApiSessionState,
  key: string,
  detail: SessionDetail,
  requestedRevision: string | null,
): SessionDetailResponse {
  const current = preparedDetail(state, detail)
  if (requestedRevision === current.revision) {
    rememberRevision(state, key, current)
    return emptyDelta(current)
  }
  const previous = requestedRevision === null
    ? undefined
    : revisionHistory(state, key).find(entry => entry.revision === requestedRevision)
  rememberRevision(state, key, current)
  if (previous === undefined) {
    return {
      kind: 'snapshot',
      revision: current.revision,
      detail: current.detail,
      analysis: current.analysis,
    }
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
    analysis: current.analysis,
    upserts,
    removedIds,
    recordOrder: current.recordOrder,
  }
}

async function routeApi(
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
  if (url.pathname === '/api/metrics') {
    sendJson(response, 200, {
      registry: options.registry.metrics?.() ?? null,
      api: options.state?.metrics() ?? null,
    })
    return true
  }
  if (url.pathname === '/api/sources') {
    sendJson(response, 200, await options.registry.listSources())
    return true
  }
  const sourceIconMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/icon$/)
  if (sourceIconMatch !== null) {
    const source = sourceId(decodePathSegment(sourceIconMatch[1]) ?? '')
    if (source === undefined) {
      sendJson(response, 400, { error: 'invalid source' })
      return true
    }
    await sendSourceIcon(response, source)
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
      redactSensitive(await options.registry.listSessions(
        requested === 'all' ? 'all' : sourceId(requested)!,
      )),
    )
    return true
  }
  if (url.pathname === '/api/annotations/datasets') {
    if (options.annotations === undefined) {
      sendJson(response, 503, { error: 'annotation workspace is unavailable' })
      return true
    }
    if (request.method === 'GET') {
      sendJson(response, 200, await options.annotations.listDatasets())
      return true
    }
    if (request.method === 'POST') {
      const body = prepareEvaluationDatasetRequest(
        await readJsonBody(request, 16 * 1024),
      )
      sendJson(response, 201, await options.annotations.prepareDataset(body))
      return true
    }
    sendJson(response, 405, { error: 'method not allowed' })
    return true
  }
  const evaluationRunDetailMatch = url.pathname.match(
    /^\/api\/annotations\/datasets\/([^/]+)\/workflow\/runs\/([^/]+)$/,
  )
  if (evaluationRunDetailMatch !== null) {
    if (options.annotations === undefined) {
      sendJson(response, 503, { error: 'annotation workspace is unavailable' })
      return true
    }
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method not allowed' })
      return true
    }
    const directoryId = decodePathSegment(evaluationRunDetailMatch[1])
    const runId = decodePathSegment(evaluationRunDetailMatch[2])
    if (directoryId === undefined || runId === undefined) {
      sendJson(response, 400, { error: 'invalid annotation path' })
      return true
    }
    sendJson(
      response,
      200,
      await options.annotations.evaluationRunDetails(directoryId, runId),
    )
    return true
  }
  const evaluationRunMatch = url.pathname.match(
    /^\/api\/annotations\/datasets\/([^/]+)\/workflow\/run$/,
  )
  if (evaluationRunMatch !== null) {
    if (options.annotations === undefined) {
      sendJson(response, 503, { error: 'annotation workspace is unavailable' })
      return true
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method not allowed' })
      return true
    }
    const directoryId = decodePathSegment(evaluationRunMatch[1])
    if (directoryId === undefined) {
      sendJson(response, 400, { error: 'invalid annotation path' })
      return true
    }
    const body = evaluationRunRequest(await readJsonBody(request, 16 * 1024))
    sendJson(
      response,
      201,
      await options.annotations.runEvaluation(directoryId, body),
    )
    return true
  }
  const evaluationStatusMatch = url.pathname.match(
    /^\/api\/annotations\/datasets\/([^/]+)\/workflow$/,
  )
  if (evaluationStatusMatch !== null) {
    if (options.annotations === undefined) {
      sendJson(response, 503, { error: 'annotation workspace is unavailable' })
      return true
    }
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method not allowed' })
      return true
    }
    const directoryId = decodePathSegment(evaluationStatusMatch[1])
    if (directoryId === undefined) {
      sendJson(response, 400, { error: 'invalid annotation path' })
      return true
    }
    sendJson(response, 200, await options.annotations.workflowStatus(directoryId))
    return true
  }
  const adjudicationCaseMatch = url.pathname.match(
    /^\/api\/annotations\/datasets\/([^/]+)\/adjudicator\/cases\/([^/]+)$/,
  )
  if (adjudicationCaseMatch !== null) {
    if (options.annotations === undefined) {
      sendJson(response, 503, { error: 'annotation workspace is unavailable' })
      return true
    }
    const directoryId = decodePathSegment(adjudicationCaseMatch[1])
    const caseId = decodePathSegment(adjudicationCaseMatch[2])
    if (directoryId === undefined || caseId === undefined) {
      sendJson(response, 400, { error: 'invalid annotation path' })
      return true
    }
    if (request.method === 'GET') {
      sendJson(
        response,
        200,
        await options.annotations.case(directoryId, 'adjudicator', caseId),
      )
      return true
    }
    if (request.method === 'PUT') {
      const body = annotationSaveRequest(await readJsonBody(request, 512 * 1024))
      sendJson(
        response,
        200,
        await options.annotations.saveCase(
          directoryId,
          'adjudicator',
          caseId,
          body,
        ),
      )
      return true
    }
    sendJson(response, 405, { error: 'method not allowed' })
    return true
  }
  const adjudicationOverviewMatch = url.pathname.match(
    /^\/api\/annotations\/datasets\/([^/]+)\/adjudicator$/,
  )
  if (adjudicationOverviewMatch !== null) {
    if (options.annotations === undefined) {
      sendJson(response, 503, { error: 'annotation workspace is unavailable' })
      return true
    }
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method not allowed' })
      return true
    }
    const directoryId = decodePathSegment(adjudicationOverviewMatch[1])
    if (directoryId === undefined) {
      sendJson(response, 400, { error: 'invalid annotation path' })
      return true
    }
    sendJson(
      response,
      200,
      await options.annotations.adjudicationOverview(directoryId),
    )
    return true
  }
  const annotationRecordMatch = url.pathname.match(
    /^\/api\/annotations\/datasets\/([^/]+)\/(reviewer-a|reviewer-b|adjudicator)\/cases\/([^/]+)\/records\/([^/]+)$/,
  )
  if (annotationRecordMatch !== null) {
    if (options.annotations === undefined) {
      sendJson(response, 503, { error: 'annotation workspace is unavailable' })
      return true
    }
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method not allowed' })
      return true
    }
    const directoryId = decodePathSegment(annotationRecordMatch[1])
    const reviewer = annotationActor(annotationRecordMatch[2])
    const caseId = decodePathSegment(annotationRecordMatch[3])
    const recordId = decodePathSegment(annotationRecordMatch[4])
    if (directoryId === undefined || reviewer === undefined
      || caseId === undefined || recordId === undefined) {
      sendJson(response, 400, { error: 'invalid annotation path' })
      return true
    }
    if (reviewer === 'adjudicator') {
      await options.annotations.adjudicationOverview(directoryId)
    }
    sendJson(
      response,
      200,
      await options.annotations.record(directoryId, caseId, recordId),
    )
    return true
  }
  const annotationCaseMatch = url.pathname.match(
    /^\/api\/annotations\/datasets\/([^/]+)\/(reviewer-a|reviewer-b)\/cases\/([^/]+)$/,
  )
  if (annotationCaseMatch !== null) {
    if (options.annotations === undefined) {
      sendJson(response, 503, { error: 'annotation workspace is unavailable' })
      return true
    }
    const directoryId = decodePathSegment(annotationCaseMatch[1])
    const reviewer = annotationReviewer(annotationCaseMatch[2])
    const caseId = decodePathSegment(annotationCaseMatch[3])
    if (directoryId === undefined || reviewer === undefined || caseId === undefined) {
      sendJson(response, 400, { error: 'invalid annotation path' })
      return true
    }
    if (request.method === 'GET') {
      sendJson(
        response,
        200,
        await options.annotations.case(directoryId, reviewer, caseId),
      )
      return true
    }
    if (request.method === 'PUT') {
      const body = annotationSaveRequest(await readJsonBody(request, 512 * 1024))
      sendJson(
        response,
        200,
        await options.annotations.saveCase(directoryId, reviewer, caseId, body),
      )
      return true
    }
    sendJson(response, 405, { error: 'method not allowed' })
    return true
  }
  const annotationOverviewMatch = url.pathname.match(
    /^\/api\/annotations\/datasets\/([^/]+)\/(reviewer-a|reviewer-b)$/,
  )
  if (annotationOverviewMatch !== null) {
    if (options.annotations === undefined) {
      sendJson(response, 503, { error: 'annotation workspace is unavailable' })
      return true
    }
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method not allowed' })
      return true
    }
    const directoryId = decodePathSegment(annotationOverviewMatch[1])
    const reviewer = annotationReviewer(annotationOverviewMatch[2])
    if (directoryId === undefined || reviewer === undefined) {
      sendJson(response, 400, { error: 'invalid annotation path' })
      return true
    }
    sendJson(
      response,
      200,
      await options.annotations.overview(directoryId, reviewer),
    )
    return true
  }
  if (url.pathname === '/api/diagnosis/prompt') {
    if (options.diagnosis === undefined) {
      sendJson(response, 503, { error: 'trajectory diagnosis is unavailable' })
      return true
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method not allowed' })
      return true
    }
    const parsed = diagnosisRequest(await readJsonBody(request, 16 * 1024))
    if (parsed === undefined) {
      sendJson(response, 400, { error: 'invalid diagnosis request' })
      return true
    }
    try {
      sendJson(response, 201, await options.diagnosis.preparePrompt(parsed))
    } catch (error) {
      if (!(error instanceof DiagnosisRequestError)) throw error
      sendJson(response, error.status, { error: error.message })
    }
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
    let frozen:
      | {
          audit: SourceAuditBundle | undefined
          detail: SessionDetail
          fingerprint: string
        }
      | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await options.registry.fingerprint(source, id)
      if (before === undefined) break
      const detail = await options.registry.load(source, id)
      if (detail === undefined) break
      const audit = await options.registry.audit?.(source, id)
      const after = await options.registry.fingerprint(source, id)
      if (after === before) {
        frozen = { audit, detail, fingerprint: after }
        break
      }
    }
    if (frozen === undefined) {
      const exists = await options.registry.fingerprint(source, id)
      if (exists === undefined) {
        sendJson(response, 404, { error: 'session not found' })
        return true
      }
      throw new HttpError(
        'session changed while freezing audit export; retry when the session is idle',
        409,
        'session_changed_during_export',
      )
    } else {
      const { audit, detail, fingerprint } = frozen
      const auditMetadata = audit === undefined
        ? {
            completeness: 'partial' as const,
            omitted: ['source audit adapter unavailable'],
          }
        : {
            completeness: audit.completeness,
            reconstruction: audit.reconstruction,
            omitted: audit.omitted,
          }
      sendDownloadJson(response, downloadFilename(source, id), {
        format: 'agent-trajectory-audit',
        version: 3,
        complete: audit?.completeness === 'complete',
        sourceFingerprint: fingerprint,
        detail: auditDetail(detail),
        sourceEvents: redactSensitive(audit?.events ?? []),
        audit: redactSensitive(auditMetadata),
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
        apiSessionState(options),
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

export async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: ApiOptions,
): Promise<boolean> {
  try {
    return await routeApi(request, response, url, options)
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(response, error.status, error)
      return true
    }
    if (error instanceof AnnotationConflictError) {
      sendError(response, 409, new HttpError(error.message, 409, 'annotation_conflict'))
      return true
    }
    if (error instanceof AnnotationInputError) {
      sendError(response, 400, new HttpError(error.message, 400, 'invalid_annotation'))
      return true
    }
    if (error instanceof AnnotationNotFoundError) {
      sendError(response, 404, new HttpError(error.message, 404, 'annotation_not_found'))
      return true
    }
    if (error instanceof SessionFormatError) {
      sendError(response, 409, new HttpError(error.message, 409, error.code))
      return true
    }
    throw error
  }
}
