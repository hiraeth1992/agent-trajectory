import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type {
  AnnotationAgreementReport,
  AnnotationDisagreement,
  ChainContinuity,
  EvaluationAdjudication,
  EvaluationAttribution,
  EvaluationCandidateManifest,
  EvaluationCandidateRef,
  EvaluationDataset,
  EvaluationSplit,
  EvaluationVerdict,
  FrozenEvaluationCase,
  HumanCaseAnnotation,
  HumanEvaluationAnnotations,
  LocalTrajectoryCriterionId,
  MetricConfidenceInterval,
  RequirementState,
} from '../../src/evaluation-types'
import { recordSearchText, redactSensitive } from '../../src/projector-utils'
import { analyzeTrajectory } from '../../src/trajectory-analysis'
import {
  isSourceId,
  type SessionDetail,
  type SourceId,
  type SourceStatus,
  type TransportSessionDetail,
  type TransportTrajectoryRecord,
  type TrajectoryRecord,
} from '../../src/types'
import { writePrivateJson } from '../summary/file-transaction'
import { createEvaluationDataset } from './identity'
import {
  candidateGroupKey,
  candidatePoolHash,
  groupAwareSplits,
  rankCandidates,
  SAMPLING_POLICY_VERSION,
  seededRank,
  visibleCandidateTraits,
} from './sampling'

const CRITERIA: LocalTrajectoryCriterionId[] = [
  'outcome',
  'reliability',
  'recovery',
  'efficiency',
  'observability',
]
const CASE_FILE = /^cases\/[a-z0-9][a-z0-9._-]*\.json$/
const DATASET_ID = /^[a-z0-9][a-z0-9._-]{2,80}$/
const REVIEWER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,80}$/
const RECORD_ID = /^record-\d{3,}$/
const PRIVACY_AUDIT_VERSION = 2
const PRIVACY_AUDITOR_ID = 'agent-trajectory-calibration-privacy'
const PRIVACY_AUDITOR_VERSION = '2'
const VERDICTS = new Set<EvaluationVerdict>([
  'pass',
  'fail',
  'warning',
  'not_applicable',
  'insufficient_evidence',
  'evaluator_error',
  'out_of_scope',
])
const ATTRIBUTIONS = new Set<EvaluationAttribution>([
  'agent',
  'source',
  'evaluator',
  'environment',
  'not_applicable',
])
const REQUIREMENT_STATES = new Set<RequirementState>([
  'misunderstood',
  'understood_unimplemented',
  'implemented',
  'superseded',
  'insufficient_evidence',
  'out_of_scope',
])
const CHAIN_CONTINUITIES = new Set<ChainContinuity>([
  'normal',
  'incorrect',
  'missing',
  'insufficient_evidence',
  'not_applicable',
])

interface EvaluationCandidateFile {
  schemaVersion: 1
  kind: 'evaluation-candidate'
  caseId: string
  detail: TransportSessionDetail
}

export interface CalibrationSource {
  listSources(fresh?: boolean): Promise<SourceStatus[]>
  listSessions(source?: SourceId | 'all'): Promise<SessionDetail['summary'][]>
  fingerprint(source: SourceId, sourceSessionId: string): Promise<string | undefined>
  load(source: SourceId, sourceSessionId: string): Promise<SessionDetail | undefined>
}

export interface PrepareCalibrationOptions {
  count: number
  allowPartial?: boolean
  seed?: string
  createdAt?: string
  datasetId?: string
  datasetVersion?: string
  description?: string
  candidateMultiplier?: number
}

export interface PreparedCalibration {
  manifest: EvaluationCandidateManifest
  manifestFile: string
  annotationGuideFile: string
  reviewerATemplate: string
  reviewerBTemplate: string
  skipped: Array<{
    source: SourceId
    sourceSessionId: string
    reason: string
  }>
}

export interface CalibrationPrivacyAudit {
  schemaVersion: typeof PRIVACY_AUDIT_VERSION
  kind: 'calibration-privacy-audit'
  manifestHash: string
  auditorId: typeof PRIVACY_AUDITOR_ID
  auditorVersion: typeof PRIVACY_AUDITOR_VERSION
  cases: number
  hashesVerified: number
  forbiddenRecordFields: number
  homePathShapes: number
  credentialShapes: number
  identityMismatches: number
  passed: boolean
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a nonempty string`)
  }
  return value
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((entry, index) =>
    string(entry, `${label} ${index}`))
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string,
): T | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new Error(`invalid ${label}`)
  }
  return value as T
}

function evidenceIds(value: unknown, label: string): string[] {
  const ids = stringArray(value, label)
  if (ids.some(id => !RECORD_ID.test(id))) {
    throw new Error(`${label} contains an invalid record id`)
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} contains duplicate record ids`)
  }
  return ids
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const expected = new Set(allowed)
  const unexpected = Object.keys(value).filter(key => !expected.has(key))
  if (unexpected.length > 0) {
    throw new Error(`${label} has unexpected fields: ${unexpected.join(', ')}`)
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function manifestContentHash(
  manifest: Omit<EvaluationCandidateManifest, 'contentHash'>,
): string {
  return sha256(JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    id: manifest.id,
    version: manifest.version,
    description: manifest.description,
    preparation: manifest.preparation,
    cases: manifest.cases,
  }))
}

function hasHomePathShape(value: string): boolean {
  return /\/(?:users|home)\/(?:\$\{[^}\s]+\}|[A-Za-z0-9._-]{1,256})(?=\/|\\|\s|["'`),.;:}\]]|$)/i
    .test(value)
    || /[A-Za-z]:\\users\\(?:\$\{[^}\s]+\}|[A-Za-z0-9._-]{1,256})(?=\\|\/|\s|["'`),.;:}\]]|$)/i
      .test(value)
}

function hasCredentialShape(value: string): boolean {
  if (/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g
    .test(value)) return true
  return [...value.matchAll(
    /\bAuthorization\s*:\s*(?:(?:Basic|Bearer)\s+)?([^\s"',}\]]+)/gi,
  )].some(match => match[1] !== '<redacted>')
}

function normalizedRelativeFile(value: string): string {
  const selected = value.replaceAll('\\', '/')
  if (!CASE_FILE.test(selected) || selected.includes('..')) {
    throw new Error(`invalid candidate file path: ${value}`)
  }
  return selected
}

function privateDirectory(directory: string): Promise<void> {
  return fs.mkdir(directory, { recursive: true, mode: 0o700 })
    .then(async () => {
      if (process.platform !== 'win32') await fs.chmod(directory, 0o700)
    })
}

async function assertEmptyDirectory(directory: string): Promise<void> {
  try {
    const entries = await fs.readdir(directory)
    if (entries.length > 0) {
      throw new Error(`calibration directory is not empty: ${directory}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function sanitizeString(
  value: string,
  cwd?: string,
  identifiers: ReadonlyMap<string, string> = new Map(),
): string {
  let safe = value
  const replacements = [
    cwd,
    homedir(),
  ].filter((candidate): candidate is string =>
    candidate !== undefined && candidate.trim() !== '' && candidate !== '/')
  for (const candidate of replacements.sort((left, right) => right.length - left.length)) {
    safe = safe.replaceAll(candidate, candidate === cwd ? '<workspace>' : '<home>')
  }
  for (const [original, replacement] of [...identifiers]
    .filter(([original, replacement]) =>
      original !== replacement
      && original.length >= 8
      && !/^\d+$/.test(original))
    .sort(([left], [right]) => right.length - left.length)) {
    safe = safe.replaceAll(original, replacement)
  }
  return safe
    .replace(/\/users\/[^/\s"'`]+/gi, '<home>')
    .replace(/\/home\/[^/\s"'`]+/gi, '<home>')
    .replace(/[A-Za-z]:\\users\\[^\\\s"'`]+/gi, '<home>')
}

function sanitizeValues(
  value: unknown,
  cwd?: string,
  identifiers: ReadonlyMap<string, string> = new Map(),
): unknown {
  if (typeof value === 'string') return sanitizeString(value, cwd, identifiers)
  if (Array.isArray(value)) {
    return value.map(item => sanitizeValues(item, cwd, identifiers))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(
      ([key, child]) => [key, sanitizeValues(child, cwd, identifiers)],
    ))
  }
  return value
}

function mappedId(
  values: Map<string, string>,
  prefix: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined
  const existing = values.get(value)
  if (existing !== undefined) return existing
  const selected = `${prefix}-${String(values.size + 1).padStart(3, '0')}`
  values.set(value, selected)
  return selected
}

function sanitizedSourceStatus(
  status: SourceStatus | undefined,
): SourceStatus | undefined {
  if (status === undefined) return undefined
  return {
    source: status.source,
    availability: status.availability,
    label: status.label,
    colorToken: status.colorToken,
    iconToken: status.iconToken,
    sessionCount: 0,
    capabilities: status.capabilities,
    reason: status.reason,
    protocol: status.protocol === undefined
      ? undefined
      : {
          detected: status.protocol.detected,
          supported: status.protocol.supported,
          fingerprint: sha256(status.protocol.fingerprint),
        },
  }
}

function parseSourceStatus(
  value: unknown,
  source: SourceId,
  label: string,
): SourceStatus | undefined {
  if (value === undefined) return undefined
  const status = object(value, label)
  exactKeys(status, [
    'source',
    'availability',
    'label',
    'colorToken',
    'iconToken',
    'sessionCount',
    'capabilities',
    'reason',
    'protocol',
  ], label)
  if (status.source !== source) throw new Error(`${label} source mismatch`)
  if (status.availability !== 'available'
    && status.availability !== 'degraded'
    && status.availability !== 'blocked') {
    throw new Error(`${label} has invalid availability`)
  }
  if (status.colorToken !== 'blue'
    && status.colorToken !== 'green'
    && status.colorToken !== 'amber') {
    throw new Error(`${label} has invalid color token`)
  }
  if (status.iconToken !== 'agent'
    && status.iconToken !== 'code'
    && status.iconToken !== 'terminal') {
    throw new Error(`${label} has invalid icon token`)
  }
  if (status.sessionCount !== 0) {
    throw new Error(`${label} must not expose a session count`)
  }
  const capabilities = object(status.capabilities, `${label} capabilities`)
  const capabilityKeys = [
    'messages',
    'tools',
    'nestedTools',
    'timing',
    'usage',
    'live',
    'attachments',
    'trace',
    'lineage',
    'policy',
    'tasks',
  ] as const
  exactKeys(capabilities, capabilityKeys, `${label} capabilities`)
  if (capabilityKeys.some(key => typeof capabilities[key] !== 'boolean')) {
    throw new Error(`${label} has invalid capabilities`)
  }
  const protocol = status.protocol === undefined
    ? undefined
    : object(status.protocol, `${label} protocol`)
  if (protocol !== undefined) {
    exactKeys(
      protocol,
      ['detected', 'supported', 'fingerprint'],
      `${label} protocol`,
    )
    if (!/^[a-f0-9]{64}$/.test(string(
      protocol.fingerprint,
      `${label} protocol fingerprint`,
    ))) {
      throw new Error(`${label} has invalid protocol fingerprint`)
    }
  }
  return {
    source,
    availability: status.availability,
    label: string(status.label, `${label} label`),
    colorToken: status.colorToken,
    iconToken: status.iconToken,
    sessionCount: 0,
    capabilities: Object.fromEntries(capabilityKeys.map(key => [
      key,
      capabilities[key] as boolean,
    ])) as SourceStatus['capabilities'],
    reason: typeof status.reason === 'string' ? status.reason : undefined,
    protocol: protocol === undefined
      ? undefined
      : {
          detected: string(protocol.detected, `${label} protocol detected`),
          supported: stringArray(
            protocol.supported,
            `${label} protocol supported`,
          ),
          fingerprint: string(
            protocol.fingerprint,
            `${label} protocol fingerprint`,
          ),
        },
  }
}

export function sanitizeCalibrationDetail(
  detail: SessionDetail,
  caseId: string,
): TransportSessionDetail {
  const recordIds = new Map<string, string>()
  const eventIds = new Map<string, string>()
  const callIds = new Map<string, string>()
  const traceIds = new Map<string, string>()
  const spanIds = new Map<string, string>()
  const sessionIds = new Map<string, string>([
    [detail.summary.id, `${detail.summary.source}:${caseId}`],
    [detail.summary.sourceSessionId, caseId],
    [detail.projection.header.id, caseId],
  ])
  const turnIds = new Map<string, string>()
  const targetIds = new Map<string, string>()
  detail.projection.records.forEach((record, index) => {
    recordIds.set(record.id, `record-${String(index + 1).padStart(3, '0')}`)
    record.sourceEventIds.forEach(id => mappedId(eventIds, 'event', id))
    mappedId(callIds, 'call', record.callId)
    mappedId(callIds, 'call', record.parentCallId)
    mappedId(traceIds, 'trace', record.traceId)
    mappedId(spanIds, 'span', record.spanId)
    mappedId(spanIds, 'span', record.parentSpanId)
    mappedId(sessionIds, 'session', record.childSessionId)
  })
  detail.projection.turns.forEach((turn, index) => {
    turnIds.set(turn.id, `turn-${String(index + 1).padStart(3, '0')}`)
    mappedId(traceIds, 'trace', turn.traceId)
  })
  mappedId(traceIds, 'trace', detail.projection.header.traceId)
  mappedId(sessionIds, 'session', detail.projection.header.parentSessionId)
  detail.projection.relations?.forEach((relation) => {
    if (!recordIds.has(relation.from)) mappedId(eventIds, 'event', relation.from)
    if (!recordIds.has(relation.to)) mappedId(eventIds, 'event', relation.to)
    relation.sourceEventIds.forEach(id => mappedId(eventIds, 'event', id))
  })
  mappedId(targetIds, 'target', detail.projection.taskState?.target?.id)
  const identifiers = new Map([
    ...recordIds,
    ...eventIds,
    ...callIds,
    ...traceIds,
    ...spanIds,
    ...sessionIds,
    ...turnIds,
    ...targetIds,
  ])
  const safeRecords: TransportTrajectoryRecord[] = detail.projection.records.map((record) => {
    const {
      raw: _raw,
      searchText: _searchText,
      ...transport
    } = record
    return {
      ...transport,
      id: recordIds.get(record.id)!,
      sourceEventIds: record.sourceEventIds.map(id =>
        mappedId(eventIds, 'event', id)!),
      callId: mappedId(callIds, 'call', record.callId),
      parentCallId: mappedId(callIds, 'call', record.parentCallId),
      traceId: mappedId(traceIds, 'trace', record.traceId),
      spanId: mappedId(spanIds, 'span', record.spanId),
      parentSpanId: mappedId(spanIds, 'span', record.parentSpanId),
      childSessionId: mappedId(sessionIds, 'session', record.childSessionId),
    }
  })
  const projection = detail.projection
  const safe = redactSensitive(sanitizeValues({
    summary: {
      ...detail.summary,
      id: `${detail.summary.source}:${caseId}`,
      sourceSessionId: caseId,
      cwd: '<workspace>',
      title: `Private calibration ${caseId}`,
    },
    projection: {
      ...projection,
      header: {
        ...projection.header,
        id: caseId,
        cwd: projection.header.cwd === undefined ? undefined : '<workspace>',
        parentSessionId: mappedId(
          sessionIds,
          'session',
          projection.header.parentSessionId,
        ),
        traceId: mappedId(traceIds, 'trace', projection.header.traceId),
      },
      records: safeRecords,
      turns: projection.turns.map(turn => ({
        ...turn,
        id: turnIds.get(turn.id)!,
        traceId: mappedId(traceIds, 'trace', turn.traceId),
      })),
      transcriptRecordIds: projection.transcriptRecordIds?.map(id =>
        recordIds.get(id) ?? id),
      modelContextRecordIds: projection.modelContextRecordIds?.map(id =>
        recordIds.get(id) ?? id),
      modelContextRecordOverrides: projection.modelContextRecordOverrides === undefined
        ? undefined
        : Object.fromEntries(Object.entries(projection.modelContextRecordOverrides).map(
          ([id, override]) => [recordIds.get(id) ?? id, override],
        )),
      relations: projection.relations?.map(relation => ({
        ...relation,
        from: recordIds.get(relation.from)
          ?? mappedId(eventIds, 'event', relation.from)!,
        to: recordIds.get(relation.to)
          ?? mappedId(eventIds, 'event', relation.to)!,
        sourceEventIds: relation.sourceEventIds.map(id =>
          mappedId(eventIds, 'event', id)!),
      })),
      taskState: projection.taskState === undefined
        ? undefined
        : {
            target: projection.taskState.target === undefined
              ? undefined
              : {
                  ...projection.taskState.target,
                  id: mappedId(targetIds, 'target', projection.taskState.target.id)!,
                },
            todos: projection.taskState.todos,
          },
    },
  }, detail.summary.cwd, identifiers)) as TransportSessionDetail
  return safe
}

function hydrateCalibrationDetail(detail: TransportSessionDetail): SessionDetail {
  return {
    ...detail,
    projection: {
      ...detail.projection,
      records: detail.projection.records.map(record => ({
        ...record,
        searchText: recordSearchText(record as Omit<TrajectoryRecord, 'searchText'>),
      })),
    },
  }
}

function caseId(source: SourceId, fingerprint: string): string {
  return `real-${source}-${sha256(fingerprint).slice(0, 12)}`
}

async function stableLoad(
  source: CalibrationSource,
  sourceId: SourceId,
  sourceSessionId: string,
): Promise<{
  detail: SessionDetail
  fingerprint: string
} | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await source.fingerprint(sourceId, sourceSessionId)
    if (before === undefined) return undefined
    const detail = await source.load(sourceId, sourceSessionId)
    if (detail === undefined) return undefined
    const after = await source.fingerprint(sourceId, sourceSessionId)
    if (before === after) return { detail, fingerprint: after }
  }
  return undefined
}

function annotationGuide(manifest: EvaluationCandidateManifest): string {
  return `# Private trajectory calibration guide

Dataset: \`${manifest.id}@${manifest.version}\`
Content hash: \`${manifest.contentHash}\`

This directory contains private, redacted, pseudonymized local trajectory evidence. Keep it
outside source control and do not upload it.

Review protocol:

1. Reviewer A and Reviewer B annotate independently. Do not compare notes or inspect Evaluator
   predictions before both files are complete.
2. Read each case JSON. Use only its records and projection facts; do not open the live source.
3. For every criterion, select one verdict and attribution and cite the smallest supporting
   record IDs. Use \`insufficient_evidence\` for missing facts, not \`fail\`.
4. List explicit user requirements separately. Overall success does not prove every requirement.
5. Evaluate chain continuity only across user turns. A single user turn is \`not_applicable\`.
6. After both reviewers finish, generate an agreement report. Resolve every disagreement in a
   separate adjudication file; do not overwrite either reviewer file.
7. Only an adjudicated, complete dataset may be used as Gold.

Allowed verdicts:
\`pass\`, \`fail\`, \`warning\`, \`not_applicable\`, \`insufficient_evidence\`,
\`evaluator_error\`, \`out_of_scope\`.

Required criteria: ${CRITERIA.join(', ')}.
`
}

export function createAnnotationTemplate(
  manifest: EvaluationCandidateManifest,
  reviewerId: string,
  createdAt = new Date().toISOString(),
): HumanEvaluationAnnotations {
  if (!REVIEWER_ID.test(reviewerId)) throw new Error('invalid reviewer id')
  return {
    schemaVersion: 1,
    kind: 'evaluation-annotations',
    datasetId: manifest.id,
    datasetVersion: manifest.version,
    datasetHash: manifest.contentHash,
    reviewerId,
    createdAt,
    cases: manifest.cases.map(candidate => ({
      caseId: candidate.id,
      criteria: CRITERIA.map(criterionId => ({
        criterionId,
        evidenceRecordIds: [],
        notes: '',
      })),
      requirements: [],
      chain: {
        evidenceRecordIds: [],
        notes: '',
      },
      notes: '',
    })),
  }
}

export function createAdjudicationTemplate(
  manifest: EvaluationCandidateManifest,
  adjudicatorId: string,
  createdAt = new Date().toISOString(),
): EvaluationAdjudication {
  const template = createAnnotationTemplate(manifest, adjudicatorId, createdAt)
  return {
    schemaVersion: 1,
    kind: 'evaluation-adjudication',
    datasetId: template.datasetId,
    datasetVersion: template.datasetVersion,
    datasetHash: template.datasetHash,
    adjudicatorId: template.reviewerId,
    createdAt: template.createdAt,
    cases: template.cases,
  }
}

export async function prepareCalibrationCandidates(
  source: CalibrationSource,
  root: string,
  options: PrepareCalibrationOptions,
): Promise<PreparedCalibration> {
  if (!Number.isInteger(options.count) || options.count < 3 || options.count > 120) {
    throw new Error('calibration count must be an integer from 3 to 120')
  }
  const datasetId = options.datasetId ?? 'agent-trajectory-private-real'
  if (!DATASET_ID.test(datasetId)) throw new Error('invalid calibration dataset id')
  const version = options.datasetVersion ?? '1'
  const seed = options.seed ?? `${datasetId}@${version}:sampling-v${SAMPLING_POLICY_VERSION}`
  const statuses = await source.listSources(true)
  const byStatus = new Map(statuses.map(status => [status.source, status]))
  const enabled = statuses.filter(status => status.availability !== 'blocked')
  const quota = Math.ceil(options.count / Math.max(1, enabled.length))
  const multiplier = Math.max(1, options.candidateMultiplier ?? 4)
  const summaries = await source.listSessions('all')
  const skipped: PreparedCalibration['skipped'] = []
  const selectedBySource = await Promise.all(enabled.map(async (status) => {
    const candidates = summaries
      .filter(summary => summary.source === status.source)
      .sort((left, right) =>
        seededRank(seed, `${left.source}:${left.sourceSessionId}`)
          .localeCompare(seededRank(seed, `${right.source}:${right.sourceSessionId}`)))
      .slice(0, quota * multiplier)
    const loaded = []
    for (const summary of candidates) {
      try {
        const stable = await stableLoad(
          source,
          summary.source,
          summary.sourceSessionId,
        )
        if (stable === undefined) {
          skipped.push({
            source: summary.source,
            sourceSessionId: summary.sourceSessionId,
            reason: 'session changed or disappeared while freezing',
          })
          continue
        }
        loaded.push({ summary, ...stable })
      } catch (error) {
        skipped.push({
          source: summary.source,
          sourceSessionId: summary.sourceSessionId,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return {
      pool: loaded,
      selected: rankCandidates(loaded, loaded.length, seed),
    }
  }))
  const stablePool = selectedBySource.flatMap(group => group.pool)
  const poolHash = candidatePoolHash(stablePool)
  const interleaved = []
  for (let index = 0; interleaved.length < options.count; index++) {
    let added = false
    for (const group of selectedBySource) {
      const candidate = group.selected[index]
      if (candidate !== undefined && interleaved.length < options.count) {
        interleaved.push(candidate)
        added = true
      }
    }
    if (!added) break
  }
  if (interleaved.length < options.count && options.allowPartial !== true) {
    throw new Error(
      `not enough stable source sessions: requested ${options.count}, produced ${
        interleaved.length
      }; pass --allow-partial to create a smaller dataset explicitly`,
    )
  }
  if (interleaved.length < Math.min(options.count, enabled.length)) {
    throw new Error('not enough stable source sessions to represent enabled sources')
  }
  const splits = groupAwareSplits(interleaved, seed)

  await assertEmptyDirectory(root)
  await privateDirectory(root)
  await privateDirectory(path.join(root, 'cases'))
  await fs.writeFile(path.join(root, '.gitignore'), '*\n!.gitignore\n', {
    mode: 0o600,
  })
  const refs: EvaluationCandidateRef[] = []
  for (const [index, candidate] of interleaved.entries()) {
    const id = caseId(candidate.summary.source, candidate.fingerprint)
    const detail = sanitizeCalibrationDetail(candidate.detail, id)
    const payload: EvaluationCandidateFile = {
      schemaVersion: 1,
      kind: 'evaluation-candidate',
      caseId: id,
      detail,
    }
    const contents = `${JSON.stringify(payload, null, 2)}\n`
    const file = `cases/${id}.json`
    await fs.writeFile(path.join(root, file), contents, {
      flag: 'wx',
      mode: 0o600,
    })
    const traits = visibleCandidateTraits(candidate.detail)
    refs.push({
      id,
      split: splits.get(candidate)!,
      groupHash: sha256(candidateGroupKey(candidate.detail)),
      description: `Private ${candidate.summary.source.toUpperCase()} trajectory; traits: ${
        traits.join(', ') || 'general'
      }.`,
      target: {
        source: candidate.summary.source,
        sourceSessionId: id,
        mode: 'frozen',
        fingerprint: sha256(candidate.fingerprint),
        snapshotId: id,
      },
      file,
      sha256: sha256(contents),
      sourceStatus: sanitizedSourceStatus(byStatus.get(candidate.summary.source)),
      traits,
    })
  }
  const createdAt = options.createdAt ?? new Date().toISOString()
  const manifestWithoutHash: Omit<EvaluationCandidateManifest, 'contentHash'> = {
    schemaVersion: 2,
    kind: 'evaluation-candidates',
    id: datasetId,
    version,
    createdAt,
    description: options.description
      ?? 'Private redacted real trajectories for independent human calibration.',
    preparation: {
      requested: options.count,
      produced: refs.length,
      skipped: skipped.length,
      allowPartial: options.allowPartial === true,
      candidatePoolHash: poolHash,
      candidateMultiplier: multiplier,
      samplingPolicyVersion: SAMPLING_POLICY_VERSION,
      seed,
      groupPolicy: 'source-parent-workspace',
      splitPolicy: 'group-aware-50-20-30',
      independentAccess: 'restricted',
    },
    cases: refs,
  }
  const manifest: EvaluationCandidateManifest = {
    ...manifestWithoutHash,
    contentHash: manifestContentHash(manifestWithoutHash),
  }
  const manifestFile = path.join(root, 'manifest.json')
  const annotationGuideFile = path.join(root, 'ANNOTATION-GUIDE.md')
  const reviewerATemplate = path.join(root, 'reviewer-a.json')
  const reviewerBTemplate = path.join(root, 'reviewer-b.json')
  await Promise.all([
    writePrivateJson(manifestFile, manifest),
    fs.writeFile(annotationGuideFile, annotationGuide(manifest), { mode: 0o600 }),
    writePrivateJson(
      reviewerATemplate,
      createAnnotationTemplate(manifest, 'reviewer-a', createdAt),
    ),
    writePrivateJson(
      reviewerBTemplate,
      createAnnotationTemplate(manifest, 'reviewer-b', createdAt),
    ),
  ])
  const audit = await auditCalibrationCandidates(root, manifest)
  if (!audit.passed) {
    await writePrivateJson(path.join(root, 'PRIVACY-AUDIT-FAILED.json'), audit)
    throw new Error(
      'calibration privacy audit failed; keep the directory quarantined and do not annotate it',
    )
  }
  await writePrivateJson(path.join(root, 'privacy-audit.json'), audit)
  return {
    manifest,
    manifestFile,
    annotationGuideFile,
    reviewerATemplate,
    reviewerBTemplate,
    skipped,
  }
}

export async function auditCalibrationCandidates(
  root: string,
  selectedManifest?: EvaluationCandidateManifest,
): Promise<CalibrationPrivacyAudit> {
  const manifest = selectedManifest ?? await loadCandidateManifest(root)
  let hashesVerified = 0
  let forbiddenRecordFields = 0
  let homePathShapes = 0
  let credentialShapes = 0
  let identityMismatches = 0
  for (const candidate of manifest.cases) {
    const file = path.join(root, normalizedRelativeFile(candidate.file))
    const contents = await fs.readFile(file)
    const serialized = contents.toString('utf8')
    if (sha256(contents) === candidate.sha256) hashesVerified++
    const parsed = object(JSON.parse(serialized) as unknown, candidate.id)
    const detail = object(
      parsed.detail,
      `${candidate.id} detail`,
    ) as unknown as TransportSessionDetail
    forbiddenRecordFields += detail.projection.records.filter(record =>
      'raw' in record || 'searchText' in record).length
    if (hasHomePathShape(serialized)) homePathShapes++
    if (hasCredentialShape(serialized)) credentialShapes++
    if (detail.summary.source !== candidate.target.source
      || detail.summary.sourceSessionId !== candidate.id
      || detail.projection.header.source !== candidate.target.source
      || detail.projection.header.id !== candidate.id) {
      identityMismatches++
    }
  }
  const passed = hashesVerified === manifest.cases.length
    && forbiddenRecordFields === 0
    && homePathShapes === 0
    && credentialShapes === 0
    && identityMismatches === 0
  return {
    schemaVersion: PRIVACY_AUDIT_VERSION,
    kind: 'calibration-privacy-audit',
    manifestHash: manifest.contentHash,
    auditorId: PRIVACY_AUDITOR_ID,
    auditorVersion: PRIVACY_AUDITOR_VERSION,
    cases: manifest.cases.length,
    hashesVerified,
    forbiddenRecordFields,
    homePathShapes,
    credentialShapes,
    identityMismatches,
    passed,
  }
}

export function parseCalibrationPrivacyAudit(
  value: unknown,
  manifest: EvaluationCandidateManifest,
): CalibrationPrivacyAudit {
  const source = object(value, 'calibration privacy audit')
  exactKeys(source, [
    'schemaVersion',
    'kind',
    'manifestHash',
    'auditorId',
    'auditorVersion',
    'cases',
    'hashesVerified',
    'forbiddenRecordFields',
    'homePathShapes',
    'credentialShapes',
    'identityMismatches',
    'passed',
  ], 'calibration privacy audit')
  if (source.schemaVersion !== PRIVACY_AUDIT_VERSION
    || source.kind !== 'calibration-privacy-audit'
    || source.auditorId !== PRIVACY_AUDITOR_ID
    || source.auditorVersion !== PRIVACY_AUDITOR_VERSION) {
    throw new Error('unsupported calibration privacy audit')
  }
  if (source.manifestHash !== manifest.contentHash) {
    throw new Error('calibration privacy audit manifest hash mismatch')
  }
  const countKeys = [
    'cases',
    'hashesVerified',
    'forbiddenRecordFields',
    'homePathShapes',
    'credentialShapes',
    'identityMismatches',
  ] as const
  if (countKeys.some(key =>
    !Number.isInteger(source[key]) || (source[key] as number) < 0)
    || typeof source.passed !== 'boolean') {
    throw new Error('invalid calibration privacy audit counts')
  }
  const audit: CalibrationPrivacyAudit = {
    schemaVersion: PRIVACY_AUDIT_VERSION,
    kind: 'calibration-privacy-audit',
    manifestHash: manifest.contentHash,
    auditorId: PRIVACY_AUDITOR_ID,
    auditorVersion: PRIVACY_AUDITOR_VERSION,
    cases: source.cases as number,
    hashesVerified: source.hashesVerified as number,
    forbiddenRecordFields: source.forbiddenRecordFields as number,
    homePathShapes: source.homePathShapes as number,
    credentialShapes: source.credentialShapes as number,
    identityMismatches: source.identityMismatches as number,
    passed: source.passed,
  }
  if (!audit.passed
    || audit.cases !== manifest.cases.length
    || audit.hashesVerified !== manifest.cases.length
    || audit.forbiddenRecordFields !== 0
    || audit.homePathShapes !== 0
    || audit.credentialShapes !== 0
    || audit.identityMismatches !== 0) {
    throw new Error('calibration privacy audit failed')
  }
  return audit
}

function parseCandidateManifest(value: unknown): EvaluationCandidateManifest {
  const source = object(value, 'candidate manifest')
  exactKeys(source, [
    'schemaVersion',
    'kind',
    'id',
    'version',
    'contentHash',
    'createdAt',
    'description',
    'preparation',
    'cases',
  ], 'candidate manifest')
  if (source.schemaVersion !== 2 || source.kind !== 'evaluation-candidates') {
    throw new Error('unsupported candidate manifest')
  }
  const id = string(source.id, 'manifest id')
  if (!DATASET_ID.test(id)) throw new Error('invalid manifest id')
  const contentHash = string(source.contentHash, 'manifest contentHash')
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new Error('invalid manifest contentHash')
  }
  const caseIds = new Set<string>()
  const cases = array(source.cases, 'manifest cases').map((value, index) => {
    const candidate = object(value, `manifest case ${index}`)
    exactKeys(candidate, [
      'id',
      'split',
      'groupHash',
      'description',
      'target',
      'file',
      'sha256',
      'sourceStatus',
      'traits',
    ], `manifest case ${index}`)
    const candidateId = string(candidate.id, `manifest case ${index} id`)
    if (caseIds.has(candidateId)) throw new Error(`duplicate candidate id: ${candidateId}`)
    caseIds.add(candidateId)
    if (candidate.split !== 'calibration'
      && candidate.split !== 'regression'
      && candidate.split !== 'independent') {
      throw new Error(`invalid split for candidate ${candidateId}`)
    }
    const groupHash = string(candidate.groupHash, `candidate ${candidateId} groupHash`)
    if (!/^[a-f0-9]{64}$/.test(groupHash)) {
      throw new Error(`invalid groupHash for candidate ${candidateId}`)
    }
    const file = normalizedRelativeFile(string(candidate.file, `candidate ${candidateId} file`))
    const digest = string(candidate.sha256, `candidate ${candidateId} sha256`)
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`invalid sha256 for candidate ${candidateId}`)
    }
    const target = object(candidate.target, `candidate ${candidateId} target`)
    exactKeys(target, [
      'source',
      'sourceSessionId',
      'mode',
      'fingerprint',
      'snapshotId',
    ], `candidate ${candidateId} target`)
    if (!isSourceId(target.source)) {
      throw new Error(`invalid source for candidate ${candidateId}`)
    }
    if (target.mode !== 'frozen') {
      throw new Error(`candidate ${candidateId} target must be frozen`)
    }
    if (target.sourceSessionId !== candidateId || target.snapshotId !== candidateId) {
      throw new Error(`candidate ${candidateId} target identity mismatch`)
    }
    const fingerprint = string(
      target.fingerprint,
      `candidate ${candidateId} fingerprint`,
    )
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new Error(`invalid target fingerprint for candidate ${candidateId}`)
    }
    return {
      id: candidateId,
      split: candidate.split,
      groupHash,
      description: string(candidate.description, `candidate ${candidateId} description`),
      target: {
        source: target.source,
        sourceSessionId: candidateId,
        mode: 'frozen',
        fingerprint,
        snapshotId: candidateId,
      },
      file,
      sha256: digest,
      sourceStatus: parseSourceStatus(
        candidate.sourceStatus,
        target.source,
        `candidate ${candidateId} sourceStatus`,
      ),
      traits: array(candidate.traits, `candidate ${candidateId} traits`).map(
        trait => string(trait, `candidate ${candidateId} trait`),
      ),
    } as EvaluationCandidateRef
  })
  const preparation = object(source.preparation, 'manifest preparation')
  exactKeys(
    preparation,
    [
      'requested',
      'produced',
      'skipped',
      'allowPartial',
      'candidatePoolHash',
      'candidateMultiplier',
      'samplingPolicyVersion',
      'seed',
      'groupPolicy',
      'splitPolicy',
      'independentAccess',
    ],
    'manifest preparation',
  )
  if (!Number.isInteger(preparation.requested)
    || !Number.isInteger(preparation.produced)
    || !Number.isInteger(preparation.skipped)
    || !Number.isInteger(preparation.samplingPolicyVersion)
    || !Number.isInteger(preparation.candidateMultiplier)
    || (preparation.requested as number) < 3
    || (preparation.produced as number) < 3
    || (preparation.skipped as number) < 0
    || (preparation.candidateMultiplier as number) < 1
    || typeof preparation.allowPartial !== 'boolean') {
    throw new Error('invalid manifest preparation counts')
  }
  const poolHash = string(preparation.candidatePoolHash, 'candidate pool hash')
  const seed = string(preparation.seed, 'sampling seed')
  if (!/^[a-f0-9]{64}$/.test(poolHash)
    || preparation.samplingPolicyVersion !== SAMPLING_POLICY_VERSION
    || preparation.groupPolicy !== 'source-parent-workspace'
    || preparation.splitPolicy !== 'group-aware-50-20-30'
    || preparation.independentAccess !== 'restricted') {
    throw new Error('invalid manifest sampling policy')
  }
  if (preparation.produced !== cases.length
    || (preparation.produced as number) > (preparation.requested as number)
    || preparation.allowPartial !== true
      && preparation.produced !== preparation.requested) {
    throw new Error('manifest preparation counts do not match cases')
  }
  const splitByGroup = new Map<string, EvaluationSplit>()
  for (const candidate of cases) {
    const previous = splitByGroup.get(candidate.groupHash)
    if (previous !== undefined && previous !== candidate.split) {
      throw new Error(`candidate group crosses splits: ${candidate.groupHash}`)
    }
    splitByGroup.set(candidate.groupHash, candidate.split)
  }
  const manifest: EvaluationCandidateManifest = {
    schemaVersion: 2,
    kind: 'evaluation-candidates',
    id,
    version: string(source.version, 'manifest version'),
    contentHash,
    createdAt: string(source.createdAt, 'manifest createdAt'),
    description: string(source.description, 'manifest description'),
    preparation: {
      requested: preparation.requested as number,
      produced: preparation.produced as number,
      skipped: preparation.skipped as number,
      allowPartial: preparation.allowPartial,
      candidatePoolHash: poolHash,
      candidateMultiplier: preparation.candidateMultiplier as number,
      samplingPolicyVersion: preparation.samplingPolicyVersion as number,
      seed,
      groupPolicy: 'source-parent-workspace',
      splitPolicy: 'group-aware-50-20-30',
      independentAccess: 'restricted',
    },
    cases,
  }
  const { contentHash: _contentHash, ...hashable } = manifest
  if (manifestContentHash(hashable) !== contentHash) {
    throw new Error('candidate manifest content hash mismatch')
  }
  return manifest
}

export async function loadCandidateManifest(
  root: string,
): Promise<EvaluationCandidateManifest> {
  const file = path.join(root, 'manifest.json')
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('candidate manifest must be a real file')
  }
  return parseCandidateManifest(
    JSON.parse(await fs.readFile(file, 'utf8')) as unknown,
  )
}

export async function loadCandidateCase(
  root: string,
  candidate: EvaluationCandidateRef,
): Promise<SessionDetail> {
  const directory = path.resolve(root)
  const file = path.resolve(directory, candidate.file)
  if (!file.startsWith(`${directory}${path.sep}`)) throw new Error('invalid candidate path')
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`candidate ${candidate.id} must be a real file`)
  }
  const contents = await fs.readFile(file)
  if (sha256(contents) !== candidate.sha256) {
    throw new Error(`candidate hash mismatch: ${candidate.id}`)
  }
  const parsed = object(JSON.parse(contents.toString('utf8')) as unknown, candidate.id)
  exactKeys(parsed, ['schemaVersion', 'kind', 'caseId', 'detail'], candidate.id)
  if (parsed.schemaVersion !== 1
    || parsed.kind !== 'evaluation-candidate'
    || parsed.caseId !== candidate.id) {
    throw new Error(`unsupported or mismatched candidate: ${candidate.id}`)
  }
  const detail = parsed.detail as TransportSessionDetail
  if (detail.summary.source !== candidate.target.source
    || detail.summary.sourceSessionId !== candidate.id
    || detail.projection.header.source !== candidate.target.source
    || detail.projection.header.id !== candidate.id) {
    throw new Error(`candidate ${candidate.id} detail identity mismatch`)
  }
  const recordIds = new Set(detail.projection.records.map(record => record.id))
  if (recordIds.size !== detail.projection.records.length
    || [...recordIds].some(id => !RECORD_ID.test(id))) {
    throw new Error(`candidate ${candidate.id} has invalid record ids`)
  }
  for (const record of detail.projection.records) {
    if ('raw' in record || 'searchText' in record) {
      throw new Error(`candidate ${candidate.id} contains forbidden record fields`)
    }
  }
  return hydrateCalibrationDetail(detail)
}

function validateAnnotationEvidence(
  annotation: HumanCaseAnnotation,
  detail: SessionDetail,
): void {
  const recordIds = new Set(detail.projection.records.map(record => record.id))
  const referenced = [
    ...annotation.criteria.flatMap(item => item.evidenceRecordIds),
    ...annotation.requirements.flatMap(item => item.evidenceRecordIds),
    ...annotation.chain.evidenceRecordIds,
  ]
  const missing = [...new Set(referenced.filter(id => !recordIds.has(id)))]
  if (missing.length > 0) {
    throw new Error(
      `adjudication ${annotation.caseId} references missing records: ${missing.join(', ')}`,
    )
  }
  const turns = new Set(detail.projection.turns.map(turn => turn.number))
  const transition = annotation.chain.failedTransition
  const failure = annotation.chain.continuity === 'missing'
    || annotation.chain.continuity === 'incorrect'
  if (failure && transition === undefined) {
    throw new Error(
      `annotation ${annotation.caseId} requires failedTransition for ${
        annotation.chain.continuity
      } chain`,
    )
  }
  if (!failure && transition !== undefined) {
    throw new Error(
      `annotation ${annotation.caseId} forbids failedTransition for ${
        annotation.chain.continuity ?? 'unset'
      } chain`,
    )
  }
  if (transition !== undefined
    && (transition.fromTurn >= transition.toTurn
      || !turns.has(transition.fromTurn)
      || !turns.has(transition.toTurn))) {
    throw new Error(
      `annotation ${annotation.caseId} has invalid chain transition ${
        transition.fromTurn
      } -> ${transition.toTurn}`,
    )
  }
}

export function validateCaseAnnotation(
  value: unknown,
  candidate: EvaluationCandidateRef,
  detail: SessionDetail,
): HumanCaseAnnotation {
  const annotation = parseAnnotationCase(value, candidate, false)
  validateAnnotationEvidence(annotation, detail)
  return annotation
}

function parseAnnotationCase(
  value: unknown,
  candidate: EvaluationCandidateRef,
  complete: boolean,
): HumanCaseAnnotation {
  const source = object(value, `annotation ${candidate.id}`)
  exactKeys(source, [
    'caseId',
    'criteria',
    'requirements',
    'chain',
    'notes',
  ], `annotation ${candidate.id}`)
  if (source.caseId !== candidate.id) throw new Error(`annotation case mismatch: ${candidate.id}`)
  const criteria = array(source.criteria, `criteria ${candidate.id}`).map((value, index) => {
    const criterion = object(value, `criterion ${candidate.id}:${index}`)
    exactKeys(criterion, [
      'criterionId',
      'verdict',
      'attribution',
      'evidenceRecordIds',
      'notes',
    ], `criterion ${candidate.id}:${index}`)
    const criterionId = string(
      criterion.criterionId,
      `criterion ${candidate.id}:${index} id`,
    )
    if (!CRITERIA.includes(criterionId as LocalTrajectoryCriterionId)) {
      throw new Error(`invalid criterion id: ${criterionId}`)
    }
    return {
      criterionId: criterionId as LocalTrajectoryCriterionId,
      verdict: optionalEnum(
        criterion.verdict,
        VERDICTS,
        `criterion ${candidate.id}:${criterionId} verdict`,
      ),
      attribution: optionalEnum(
        criterion.attribution,
        ATTRIBUTIONS,
        `criterion ${candidate.id}:${criterionId} attribution`,
      ),
      evidenceRecordIds: evidenceIds(
        criterion.evidenceRecordIds,
        `criterion ${candidate.id}:${criterionId} evidence`,
      ),
      notes: typeof criterion.notes === 'string' ? criterion.notes : '',
    }
  })
  if (criteria.length !== CRITERIA.length
    || new Set(criteria.map(item => item.criterionId)).size !== CRITERIA.length
    || CRITERIA.some(id => !criteria.some(item => item.criterionId === id))) {
    throw new Error(`annotation ${candidate.id} must contain each criterion exactly once`)
  }
  if (complete && criteria.some(item =>
    item.verdict === undefined || item.attribution === undefined)) {
    throw new Error(`annotation ${candidate.id} has incomplete criteria`)
  }
  for (const criterion of criteria) {
    if (criterion.verdict === 'evaluator_error'
      && criterion.attribution !== undefined
      && criterion.attribution !== 'evaluator') {
      throw new Error(
        `criterion ${candidate.id}:${criterion.criterionId} evaluator_error must attribute evaluator`,
      )
    }
    if (criterion.attribution === 'evaluator'
      && criterion.verdict !== undefined
      && criterion.verdict !== 'evaluator_error') {
      throw new Error(
        `criterion ${candidate.id}:${criterion.criterionId} evaluator attribution requires evaluator_error`,
      )
    }
    if ((criterion.verdict === 'not_applicable' || criterion.verdict === 'out_of_scope')
      && criterion.attribution !== undefined
      && criterion.attribution !== 'not_applicable') {
      throw new Error(
        `criterion ${candidate.id}:${criterion.criterionId} ${
          criterion.verdict
        } must attribute not_applicable`,
      )
    }
    if (criterion.attribution === 'not_applicable'
      && criterion.verdict !== undefined
      && criterion.verdict !== 'not_applicable'
      && criterion.verdict !== 'out_of_scope') {
      throw new Error(
        `criterion ${candidate.id}:${criterion.criterionId} not_applicable attribution is inconsistent`,
      )
    }
  }
  if (complete && criteria.some(item =>
    (item.verdict === 'pass' || item.verdict === 'fail' || item.verdict === 'warning')
    && item.evidenceRecordIds.length === 0)) {
    throw new Error(`annotation ${candidate.id} has ungrounded criteria`)
  }
  const requirements = array(
    source.requirements,
    `requirements ${candidate.id}`,
  ).map((value, index) => {
    const requirement = object(value, `requirement ${candidate.id}:${index}`)
    exactKeys(requirement, [
      'id',
      'text',
      'required',
      'state',
      'evidenceRecordIds',
      'notes',
    ], `requirement ${candidate.id}:${index}`)
    if (typeof requirement.required !== 'boolean') {
      throw new Error(`requirement ${candidate.id}:${index} required must be boolean`)
    }
    return {
      id: string(requirement.id, `requirement ${candidate.id}:${index} id`),
      text: string(requirement.text, `requirement ${candidate.id}:${index} text`),
      required: requirement.required,
      state: optionalEnum(
        requirement.state,
        REQUIREMENT_STATES,
        `requirement ${candidate.id}:${index} state`,
      ),
      evidenceRecordIds: evidenceIds(
        requirement.evidenceRecordIds,
        `requirement ${candidate.id}:${index} evidence`,
      ),
      notes: typeof requirement.notes === 'string' ? requirement.notes : '',
    }
  })
  if (new Set(requirements.map(item => item.id)).size !== requirements.length) {
    throw new Error(`annotation ${candidate.id} has duplicate requirement ids`)
  }
  if (complete && requirements.some(item => item.state === undefined)) {
    throw new Error(`annotation ${candidate.id} has incomplete requirements`)
  }
  if (complete && requirements.length === 0) {
    throw new Error(`annotation ${candidate.id} has no explicit requirements`)
  }
  if (complete && requirements.some(item =>
    item.text.trim() === '' || item.evidenceRecordIds.length === 0)) {
    throw new Error(`annotation ${candidate.id} has ungrounded requirements`)
  }
  const chainValue = object(
    source.chain,
    `chain ${candidate.id}`,
  )
  exactKeys(chainValue, [
    'continuity',
    'failedTransition',
    'evidenceRecordIds',
    'notes',
  ], `chain ${candidate.id}`)
  const failedTransitionValue = chainValue.failedTransition === undefined
    ? undefined
    : object(chainValue.failedTransition, `chain ${candidate.id} failedTransition`)
  if (failedTransitionValue !== undefined) {
    exactKeys(
      failedTransitionValue,
      ['fromTurn', 'toTurn'],
      `chain ${candidate.id} failedTransition`,
    )
    if (!Number.isInteger(failedTransitionValue.fromTurn)
      || !Number.isInteger(failedTransitionValue.toTurn)
      || (failedTransitionValue.fromTurn as number) < 1
      || (failedTransitionValue.toTurn as number) < 1) {
      throw new Error(`chain ${candidate.id} failedTransition has invalid turns`)
    }
  }
  const chain: HumanCaseAnnotation['chain'] = {
    continuity: optionalEnum(
      chainValue.continuity,
      CHAIN_CONTINUITIES,
      `chain ${candidate.id} continuity`,
    ),
    failedTransition: failedTransitionValue === undefined
      ? undefined
      : {
          fromTurn: failedTransitionValue.fromTurn as number,
          toTurn: failedTransitionValue.toTurn as number,
        },
    evidenceRecordIds: evidenceIds(
      chainValue.evidenceRecordIds,
      `chain ${candidate.id} evidence`,
    ),
    notes: typeof chainValue.notes === 'string' ? chainValue.notes : '',
  }
  if (complete && chain.continuity === undefined) {
    throw new Error(`annotation ${candidate.id} has incomplete chain`)
  }
  if (complete && chain.continuity !== 'insufficient_evidence'
    && chain.evidenceRecordIds.length === 0) {
    throw new Error(`annotation ${candidate.id} has ungrounded chain`)
  }
  return {
    caseId: candidate.id,
    criteria,
    requirements,
    chain,
    notes: typeof source.notes === 'string' ? source.notes : '',
  }
}

export function parseHumanAnnotations(
  value: unknown,
  manifest: EvaluationCandidateManifest,
  options: { complete: boolean },
): HumanEvaluationAnnotations {
  const source = object(value, 'annotations')
  exactKeys(source, [
    'schemaVersion',
    'kind',
    'datasetId',
    'datasetVersion',
    'datasetHash',
    'reviewerId',
    'createdAt',
    'cases',
  ], 'annotations')
  if (source.schemaVersion !== 1 || source.kind !== 'evaluation-annotations') {
    throw new Error('unsupported annotations')
  }
  if (source.datasetId !== manifest.id || source.datasetVersion !== manifest.version) {
    throw new Error('annotation dataset mismatch')
  }
  if (source.datasetHash !== manifest.contentHash) {
    throw new Error('annotation dataset hash mismatch')
  }
  const reviewerId = string(source.reviewerId, 'reviewer id')
  if (!REVIEWER_ID.test(reviewerId)) throw new Error('invalid reviewer id')
  const values = array(source.cases, 'annotation cases')
  if (values.length !== manifest.cases.length) {
    throw new Error('annotations must contain every manifest case')
  }
  const annotatedIds = values.map(value =>
    string(object(value, 'annotation case').caseId, 'annotation case id'))
  if (new Set(annotatedIds).size !== annotatedIds.length) {
    throw new Error('annotations contain duplicate case ids')
  }
  const byId = new Map(values.map((value, index) => [annotatedIds[index]!, value]))
  return {
    schemaVersion: 1,
    kind: 'evaluation-annotations',
    datasetId: manifest.id,
    datasetVersion: manifest.version,
    datasetHash: manifest.contentHash,
    reviewerId,
    createdAt: string(source.createdAt, 'annotation createdAt'),
    cases: manifest.cases.map(candidate => {
      const value = byId.get(candidate.id)
      if (value === undefined) throw new Error(`missing annotation case: ${candidate.id}`)
      return parseAnnotationCase(value, candidate, options.complete)
    }),
  }
}

export async function loadHumanAnnotations(
  file: string,
  manifest: EvaluationCandidateManifest,
  options: { complete: boolean },
): Promise<HumanEvaluationAnnotations> {
  return parseHumanAnnotations(
    JSON.parse(await fs.readFile(file, 'utf8')) as unknown,
    manifest,
    options,
  )
}

export function annotationContentHash(
  annotations: HumanEvaluationAnnotations,
): string {
  return sha256(JSON.stringify({
    schemaVersion: annotations.schemaVersion,
    kind: annotations.kind,
    datasetId: annotations.datasetId,
    datasetVersion: annotations.datasetVersion,
    datasetHash: annotations.datasetHash,
    reviewerId: annotations.reviewerId,
    createdAt: annotations.createdAt,
    cases: annotations.cases.map(testCase => ({
      caseId: testCase.caseId,
      criteria: testCase.criteria.map(criterion => ({
        criterionId: criterion.criterionId,
        verdict: criterion.verdict ?? null,
        attribution: criterion.attribution ?? null,
        evidenceRecordIds: criterion.evidenceRecordIds,
        notes: criterion.notes,
      })),
      requirements: testCase.requirements.map(requirement => ({
        id: requirement.id,
        text: requirement.text,
        required: requirement.required,
        state: requirement.state ?? null,
        evidenceRecordIds: requirement.evidenceRecordIds,
        notes: requirement.notes,
      })),
      chain: {
        continuity: testCase.chain.continuity ?? null,
        failedTransition: testCase.chain.failedTransition ?? null,
        evidenceRecordIds: testCase.chain.evidenceRecordIds,
        notes: testCase.chain.notes,
      },
      notes: testCase.notes,
    })),
  }))
}

function agreement(values: Array<[string, string]>): number | undefined {
  return values.length === 0
    ? undefined
    : values.filter(([left, right]) => left === right).length / values.length
}

function cohenKappa(values: Array<[string, string]>): number | undefined {
  if (values.length === 0) return undefined
  const labels = new Set(values.flatMap(value => value))
  if (labels.size < 2) return undefined
  const observed = agreement(values)!
  const expected = [...labels].reduce((total, label) => {
    const left = values.filter(value => value[0] === label).length / values.length
    const right = values.filter(value => value[1] === label).length / values.length
    return total + left * right
  }, 0)
  return expected === 1 ? undefined : (observed - expected) / (1 - expected)
}

function marginals(
  values: Array<[string, string]>,
): { reviewerA: Record<string, number>; reviewerB: Record<string, number> } {
  const count = (index: 0 | 1) => Object.fromEntries(
    [...new Set(values.map(value => value[index]))]
      .sort()
      .map(label => [
        label,
        values.filter(value => value[index] === label).length,
      ]),
  )
  return { reviewerA: count(0), reviewerB: count(1) }
}

function seededRandom(seed: string): () => number {
  let state = Number.parseInt(sha256(seed).slice(0, 8), 16) || 1
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

function bootstrapCi(
  values: Array<[string, string]>,
  metric: (sample: Array<[string, string]>) => number | undefined,
  seed: string,
  samples = 1_000,
): MetricConfidenceInterval | undefined {
  if (values.length < 2) return undefined
  const random = seededRandom(seed)
  const estimates: number[] = []
  for (let iteration = 0; iteration < samples; iteration++) {
    const sample = Array.from({ length: values.length }, () =>
      values[Math.floor(random() * values.length)]!)
    const estimate = metric(sample)
    if (estimate !== undefined && Number.isFinite(estimate)) estimates.push(estimate)
  }
  if (estimates.length < 20) return undefined
  estimates.sort((left, right) => left - right)
  const selected = (quantile: number) =>
    estimates[Math.min(estimates.length - 1, Math.floor((estimates.length - 1) * quantile))]!
  return {
    confidence: 0.95,
    lower: selected(0.025),
    upper: selected(0.975),
    samples: estimates.length,
  }
}

export function compareHumanAnnotations(
  manifest: EvaluationCandidateManifest,
  left: HumanEvaluationAnnotations,
  right: HumanEvaluationAnnotations,
): AnnotationAgreementReport {
  if (left.datasetId !== manifest.id || right.datasetId !== manifest.id
    || left.datasetVersion !== manifest.version
    || right.datasetVersion !== manifest.version
    || left.datasetHash !== manifest.contentHash
    || right.datasetHash !== manifest.contentHash) {
    throw new Error('annotation comparison dataset mismatch')
  }
  if (left.reviewerId === right.reviewerId) {
    throw new Error('agreement requires two different reviewers')
  }
  const disagreements: AnnotationDisagreement[] = []
  const allCriterionPairs: Array<[string, string]> = []
  const criterionAgreement: AnnotationAgreementReport['criterionAgreement'] = {}
  const chainPairs: Array<[string, string]> = []
  const requirementDetectionPairs: Array<[string, string]> = []
  const requirementStatePairs: Array<[string, string]> = []
  const rightByCase = new Map(right.cases.map(testCase => [testCase.caseId, testCase]))
  for (const leftCase of left.cases) {
    const rightCase = rightByCase.get(leftCase.caseId)
    if (rightCase === undefined) continue
    const rightCriteria = new Map(rightCase.criteria.map(item => [item.criterionId, item]))
    for (const criterionId of CRITERIA) {
      const leftCriterion = leftCase.criteria.find(item => item.criterionId === criterionId)
      const rightCriterion = rightCriteria.get(criterionId)
      if (leftCriterion === undefined || rightCriterion === undefined) continue
      const verdictPair: [string, string] = [
        leftCriterion.verdict ?? '',
        rightCriterion.verdict ?? '',
      ]
      const attributionPair: [string, string] = [
        leftCriterion.attribution ?? '',
        rightCriterion.attribution ?? '',
      ]
      allCriterionPairs.push([
        `${verdictPair[0]}|${attributionPair[0]}`,
        `${verdictPair[1]}|${attributionPair[1]}`,
      ])
      const current = criterionAgreement[criterionId] ?? {
        sampleSize: 0,
        verdictPairs: [] as Array<[string, string]>,
        attributionPairs: [] as Array<[string, string]>,
      }
      const internal = current as typeof current & {
        verdictPairs: Array<[string, string]>
        attributionPairs: Array<[string, string]>
      }
      internal.sampleSize++
      internal.verdictPairs.push(verdictPair)
      internal.attributionPairs.push(attributionPair)
      criterionAgreement[criterionId] = internal
      if (verdictPair[0] !== verdictPair[1] || attributionPair[0] !== attributionPair[1]) {
        disagreements.push({
          caseId: leftCase.caseId,
          subject: `criterion:${criterionId}`,
          reviewerA: `${verdictPair[0]}|${attributionPair[0]}`,
          reviewerB: `${verdictPair[1]}|${attributionPair[1]}`,
        })
      }
    }
    const leftRequirements = new Map(leftCase.requirements.map(item => [item.id, item]))
    const rightRequirements = new Map(rightCase.requirements.map(item => [item.id, item]))
    for (const requirementId of new Set([
      ...leftRequirements.keys(),
      ...rightRequirements.keys(),
    ])) {
      const leftRequirement = leftRequirements.get(requirementId)
      const rightRequirement = rightRequirements.get(requirementId)
      requirementDetectionPairs.push([
        leftRequirement === undefined ? 'absent' : 'present',
        rightRequirement === undefined ? 'absent' : 'present',
      ])
      if (leftRequirement !== undefined && rightRequirement !== undefined) {
        requirementStatePairs.push([
          leftRequirement.state ?? '',
          rightRequirement.state ?? '',
        ])
      }
      const leftValue = leftRequirement?.state
      const rightValue = rightRequirement?.state
      if (leftRequirement === undefined
        || rightRequirement === undefined
        || leftValue !== rightValue) {
        disagreements.push({
          caseId: leftCase.caseId,
          subject: `requirement:${requirementId}`,
          reviewerA: leftValue,
          reviewerB: rightValue,
        })
      }
    }
    const chainPair: [string, string] = [
      leftCase.chain.continuity ?? '',
      rightCase.chain.continuity ?? '',
    ]
    chainPairs.push(chainPair)
    if (chainPair[0] !== chainPair[1]) {
      disagreements.push({
        caseId: leftCase.caseId,
        subject: 'chain',
        reviewerA: chainPair[0],
        reviewerB: chainPair[1],
      })
    }
  }
  for (const [criterionId, value] of Object.entries(criterionAgreement)) {
    const internal = value as typeof value & {
      verdictPairs: Array<[string, string]>
      attributionPairs: Array<[string, string]>
    }
    criterionAgreement[criterionId] = {
      sampleSize: internal.sampleSize,
      verdictAgreement: agreement(internal.verdictPairs),
      verdictKappa: cohenKappa(internal.verdictPairs),
      verdictAgreementCi: bootstrapCi(
        internal.verdictPairs,
        agreement,
        `${manifest.contentHash}:${criterionId}:verdict-agreement`,
      ),
      verdictKappaCi: bootstrapCi(
        internal.verdictPairs,
        cohenKappa,
        `${manifest.contentHash}:${criterionId}:verdict-kappa`,
      ),
      attributionAgreement: agreement(internal.attributionPairs),
      attributionKappa: cohenKappa(internal.attributionPairs),
      attributionAgreementCi: bootstrapCi(
        internal.attributionPairs,
        agreement,
        `${manifest.contentHash}:${criterionId}:attribution-agreement`,
      ),
      attributionKappaCi: bootstrapCi(
        internal.attributionPairs,
        cohenKappa,
        `${manifest.contentHash}:${criterionId}:attribution-kappa`,
      ),
      verdictMarginals: marginals(internal.verdictPairs),
    }
  }
  const complete = (annotations: HumanEvaluationAnnotations) =>
    annotations.cases.filter(testCase =>
      testCase.criteria.every(item =>
        item.verdict !== undefined && item.attribution !== undefined)
      && testCase.requirements.every(item => item.state !== undefined)
      && testCase.chain.continuity !== undefined).length
  return {
    datasetId: manifest.id,
    datasetVersion: manifest.version,
    datasetHash: manifest.contentHash,
    reviewerA: left.reviewerId,
    reviewerB: right.reviewerId,
    reviewerAHash: annotationContentHash(left),
    reviewerBHash: annotationContentHash(right),
    completeCasesA: complete(left),
    completeCasesB: complete(right),
    totalCases: manifest.cases.length,
    criterionExactAgreement: agreement(allCriterionPairs),
    criterionKappa: cohenKappa(allCriterionPairs),
    criterionExactAgreementCi: bootstrapCi(
      allCriterionPairs,
      agreement,
      `${manifest.contentHash}:criterion-agreement`,
    ),
    criterionKappaCi: bootstrapCi(
      allCriterionPairs,
      cohenKappa,
      `${manifest.contentHash}:criterion-kappa`,
    ),
    criterionAgreement,
    requirementDetectionAgreement: agreement(requirementDetectionPairs),
    requirementStateAgreement: agreement(requirementStatePairs),
    requirementDetectionAgreementCi: bootstrapCi(
      requirementDetectionPairs,
      agreement,
      `${manifest.contentHash}:requirement-detection`,
    ),
    requirementStateAgreementCi: bootstrapCi(
      requirementStatePairs,
      agreement,
      `${manifest.contentHash}:requirement-state`,
    ),
    chainExactAgreement: agreement(chainPairs),
    chainKappa: cohenKappa(chainPairs),
    chainExactAgreementCi: bootstrapCi(
      chainPairs,
      agreement,
      `${manifest.contentHash}:chain-agreement`,
    ),
    chainKappaCi: bootstrapCi(
      chainPairs,
      cohenKappa,
      `${manifest.contentHash}:chain-kappa`,
    ),
    chainMarginals: marginals(chainPairs),
    disagreements,
  }
}

export function parseAdjudication(
  value: unknown,
  manifest: EvaluationCandidateManifest,
): EvaluationAdjudication {
  const source = object(value, 'adjudication')
  exactKeys(source, [
    'schemaVersion',
    'kind',
    'datasetId',
    'datasetVersion',
    'datasetHash',
    'adjudicatorId',
    'createdAt',
    'cases',
  ], 'adjudication')
  if (source.schemaVersion !== 1 || source.kind !== 'evaluation-adjudication') {
    throw new Error('unsupported adjudication')
  }
  const annotations = parseHumanAnnotations({
    schemaVersion: 1,
    kind: 'evaluation-annotations',
    datasetId: source.datasetId,
    datasetVersion: source.datasetVersion,
    datasetHash: source.datasetHash,
    reviewerId: source.adjudicatorId,
    createdAt: source.createdAt,
    cases: source.cases,
  }, manifest, { complete: true })
  return {
    schemaVersion: 1,
    kind: 'evaluation-adjudication',
    datasetId: annotations.datasetId,
    datasetVersion: annotations.datasetVersion,
    datasetHash: annotations.datasetHash,
    adjudicatorId: annotations.reviewerId,
    createdAt: annotations.createdAt,
    cases: annotations.cases,
  }
}

export async function loadAdjudicatedDataset(
  root: string,
  adjudicationFile: string,
): Promise<EvaluationDataset> {
  const manifest = await loadCandidateManifest(root)
  const adjudication = parseAdjudication(
    JSON.parse(await fs.readFile(adjudicationFile, 'utf8')) as unknown,
    manifest,
  )
  const byCase = new Map(adjudication.cases.map(testCase => [testCase.caseId, testCase]))
  const cases: FrozenEvaluationCase[] = await Promise.all(manifest.cases.map(async candidate => {
    const annotation = byCase.get(candidate.id)
    if (annotation === undefined) throw new Error(`missing adjudication: ${candidate.id}`)
    const detail = await loadCandidateCase(root, candidate)
    validateAnnotationEvidence(annotation, detail)
    return {
      id: candidate.id,
      split: candidate.split,
      description: candidate.description,
      target: candidate.target,
      detail,
      sourceStatus: candidate.sourceStatus,
      expected: annotation.criteria.map(item => ({
        criterionId: item.criterionId,
        verdict: item.verdict!,
        attribution: item.attribution,
        evidenceRecordIds: item.evidenceRecordIds,
      })),
      expectedRequirements: annotation.requirements.map(item => ({
        id: item.id,
        text: item.text,
        required: item.required,
        state: item.state!,
        evidenceRecordIds: item.evidenceRecordIds,
      })),
      expectedChain: {
        continuity: annotation.chain.continuity!,
        failedTransition: annotation.chain.failedTransition,
        evidenceRecordIds: annotation.chain.evidenceRecordIds,
      },
    }
  }))
  return createEvaluationDataset({
    schemaVersion: 1,
    id: manifest.id,
    version: manifest.version,
    description: manifest.description,
    goldCompleteness: 'full-gold',
    candidateManifestHash: manifest.contentHash,
    cases,
  })
}
