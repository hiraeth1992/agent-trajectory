import { createHash } from 'node:crypto'
import type {
  ChainResult,
  ChainTransition,
  EvaluationAggregate,
  EvaluationResult,
  EvaluationTargetRef,
  FactsQualityIssue,
  FactsQualityReport,
  LocalTrajectoryCriterionId,
  RequirementResult,
  TrajectoryEvaluation,
} from './evaluation-types'
import { redactSensitive } from './projector-utils'
import type {
  AnalysisEvaluation,
  TrajectoryAnalysis,
} from './trajectory-analysis'
import type {
  SessionDetail,
  SourceStatus,
  TrajectoryRecord,
} from './types'

export const LOCAL_TRAJECTORY_EVALUATOR_ID = 'local-trajectory'
export const LOCAL_TRAJECTORY_EVALUATOR_VERSION = '1'
export const EVALUATION_FACTS_SCHEMA_VERSION = 1

export interface TrajectoryEvaluationOptions {
  target: EvaluationTargetRef
  sourceStatus?: SourceStatus
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function compact(value: string, limit = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 1)}…`
}

function isTruncated(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(isTruncated)
  const object = value as Record<string, unknown>
  return object.truncated === true
    && typeof object.originalBytes === 'number'
    || Object.values(object).some(isTruncated)
}

function issue(
  value: Omit<FactsQualityIssue, 'evidenceRecordIds'> & {
    evidenceRecordIds?: string[]
  },
): FactsQualityIssue {
  return {
    ...value,
    evidenceRecordIds: value.evidenceRecordIds ?? [],
  }
}

const ALL_CRITERIA: LocalTrajectoryCriterionId[] = [
  'outcome',
  'reliability',
  'recovery',
  'efficiency',
  'observability',
]

export function buildFactsQualityReport(
  detail: SessionDetail,
  options: TrajectoryEvaluationOptions,
): FactsQualityReport {
  const records = detail.projection.records
  const runningRecords = records.filter(record => record.status === 'running')
  const truncatedRecords = records.filter(record =>
    isTruncated(record.input) || isTruncated(record.output))
  const toolRecords = records.filter(record =>
    record.kind === 'tool' || record.kind === 'subtool')
  const toolRecordsMissingInput = toolRecords.filter(record =>
    record.input === undefined)
  const toolRecordsMissingOutput = toolRecords.filter(record =>
    record.status === 'complete'
    && record.output === undefined
    && record.error === undefined)
  const spanIds = new Set(records.flatMap(record =>
    record.spanId === undefined ? [] : [record.spanId]))
  const brokenParentSpans = records.filter(record =>
    record.parentSpanId !== undefined && !spanIds.has(record.parentSpanId))
  const issues: FactsQualityIssue[] = []

  if (options.sourceStatus?.availability === 'blocked') {
    issues.push(issue({
      id: 'source-protocol-blocked',
      category: 'protocol',
      severity: 'blocking',
      summary: options.sourceStatus.detail
        ?? options.sourceStatus.reason
        ?? '来源协议不可用，不能把投影结果用于质量判定。',
      affectedCriterionIds: ALL_CRITERIA,
    }))
  } else if (options.sourceStatus?.availability === 'degraded') {
    issues.push(issue({
      id: 'source-protocol-degraded',
      category: 'protocol',
      severity: 'warning',
      summary: options.sourceStatus.detail
        ?? options.sourceStatus.reason
        ?? '来源协议处于降级状态。',
      affectedCriterionIds: ALL_CRITERIA,
    }))
  }
  if (detail.projection.unknownEventTypes.length > 0) {
    issues.push(issue({
      id: 'unknown-event-types',
      category: 'coverage',
      severity: 'blocking',
      summary: `存在 ${detail.projection.unknownEventTypes.length} 种未解释事件：${
        detail.projection.unknownEventTypes.join(', ')
      }。`,
      affectedCriterionIds: ALL_CRITERIA,
    }))
  }
  if (runningRecords.length > 0) {
    issues.push(issue({
      id: 'target-running',
      category: 'liveness',
      severity: 'blocking',
      summary: '目标仍包含运行中记录，最终状态可能继续变化。',
      evidenceRecordIds: runningRecords.map(record => record.id),
      affectedCriterionIds: ['outcome', 'reliability', 'recovery'],
    }))
  } else if (options.target.mode === 'live') {
    issues.push(issue({
      id: 'target-live',
      category: 'liveness',
      severity: 'warning',
      summary: '目标来自可变来源；批量回归前应冻结 fingerprint 对应的事实。',
      affectedCriterionIds: ['outcome', 'reliability', 'recovery'],
    }))
  }
  if (truncatedRecords.length > 0) {
    issues.push(issue({
      id: 'truncated-record-values',
      category: 'truncation',
      severity: 'blocking',
      summary: `${truncatedRecords.length} 条记录的输入或输出已截断。`,
      evidenceRecordIds: truncatedRecords.map(record => record.id),
      affectedCriterionIds: ['outcome', 'reliability', 'recovery'],
    }))
  }
  if (toolRecordsMissingInput.length > 0) {
    issues.push(issue({
      id: 'tool-input-missing',
      category: 'completeness',
      severity: 'warning',
      summary: `${toolRecordsMissingInput.length} 条工具记录缺少输入。`,
      evidenceRecordIds: toolRecordsMissingInput.map(record => record.id),
      affectedCriterionIds: ['efficiency', 'observability'],
    }))
  }
  if (toolRecordsMissingOutput.length > 0) {
    issues.push(issue({
      id: 'tool-result-missing',
      category: 'pairing',
      severity: 'blocking',
      summary: `${toolRecordsMissingOutput.length} 条已完成工具记录缺少结果。`,
      evidenceRecordIds: toolRecordsMissingOutput.map(record => record.id),
      affectedCriterionIds: ['outcome', 'reliability', 'recovery', 'observability'],
    }))
  }
  if (brokenParentSpans.length > 0) {
    issues.push(issue({
      id: 'broken-parent-spans',
      category: 'trace',
      severity: 'warning',
      summary: `${brokenParentSpans.length} 条记录引用了不存在的 parent span。`,
      evidenceRecordIds: brokenParentSpans.map(record => record.id),
      affectedCriterionIds: ['observability'],
    }))
  }
  if (!detail.summary.capabilities.trace) {
    issues.push(issue({
      id: 'trace-capability-unavailable',
      category: 'capability',
      severity: 'warning',
      summary: `${detail.summary.source} 来源不提供完整 trace/span 能力。`,
      affectedCriterionIds: ['observability'],
    }))
  }
  if (!detail.summary.capabilities.usage) {
    issues.push(issue({
      id: 'usage-capability-unavailable',
      category: 'capability',
      severity: 'warning',
      summary: `${detail.summary.source} 来源不提供完整 Token 用量能力。`,
      affectedCriterionIds: ['efficiency', 'observability'],
    }))
  }

  const blockedCriterionIds = unique(issues.flatMap(item =>
    item.severity === 'blocking' ? item.affectedCriterionIds : []))
  return {
    schemaVersion: EVALUATION_FACTS_SCHEMA_VERSION,
    source: detail.summary.source,
    sourceCapabilities: detail.summary.capabilities,
    sourceProtocol: options.sourceStatus === undefined
      ? undefined
      : {
          availability: options.sourceStatus.availability,
          detected: options.sourceStatus.protocol?.detected,
          supported: options.sourceStatus.protocol?.supported,
          reason: options.sourceStatus.reason,
        },
    target: options.target,
    contextScope: 'session',
    stats: {
      records: records.length,
      turns: detail.projection.turns.length,
      runningRecords: runningRecords.length,
      truncatedRecords: truncatedRecords.length,
      toolRecords: toolRecords.length,
      toolRecordsMissingInput: toolRecordsMissingInput.length,
      toolRecordsMissingOutput: toolRecordsMissingOutput.length,
      brokenParentSpans: brokenParentSpans.length,
      unknownEventTypes: detail.projection.unknownEventTypes.length,
    },
    ready: blockedCriterionIds.length === 0,
    issues,
    blockedCriterionIds,
  }
}

function verdictFor(
  evaluation: AnalysisEvaluation,
): EvaluationResult['verdict'] {
  if (evaluation.grade === 'good') return 'pass'
  if (evaluation.grade === 'bad') return 'fail'
  if (evaluation.grade === 'warning') return 'warning'
  return evaluation.id === 'recovery'
    ? 'not_applicable'
    : 'insufficient_evidence'
}

function resultAttribution(
  evaluation: AnalysisEvaluation,
  verdict: EvaluationResult['verdict'],
): EvaluationResult['attribution'] {
  if (verdict === 'not_applicable') return 'not_applicable'
  if (verdict === 'insufficient_evidence') return 'source'
  if (evaluation.id === 'observability') return 'source'
  return 'agent'
}

function mapEvaluation(
  evaluation: AnalysisEvaluation,
  quality: FactsQualityReport,
): EvaluationResult {
  const blockers = quality.issues.filter(item =>
    item.severity === 'blocking'
    && item.affectedCriterionIds.includes(evaluation.id))
  if (blockers.length > 0) {
    return {
      evaluatorId: LOCAL_TRAJECTORY_EVALUATOR_ID,
      evaluatorVersion: LOCAL_TRAJECTORY_EVALUATOR_VERSION,
      criterionId: evaluation.id,
      verdict: 'insufficient_evidence',
      confidence: 'high',
      evidenceRecordIds: unique(blockers.flatMap(item => item.evidenceRecordIds)),
      counterEvidenceRecordIds: [],
      evidenceBoundary: blockers.map(item => item.summary).join('；'),
      attribution: 'source',
      blockedBy: blockers.map(item => item.id),
      denominatorEligible: false,
      label: '事实质量不足',
      summary: `判据“${evaluation.title}”被事实质量门禁短路。`,
    }
  }
  const verdict = verdictFor(evaluation)
  return {
    evaluatorId: LOCAL_TRAJECTORY_EVALUATOR_ID,
    evaluatorVersion: LOCAL_TRAJECTORY_EVALUATOR_VERSION,
    criterionId: evaluation.id,
    verdict,
    confidence: evaluation.confidence,
    evidenceRecordIds: unique(evaluation.evidenceRecordIds),
    counterEvidenceRecordIds: [],
    evidenceBoundary: evaluation.evidenceRecordIds.length > 0
      ? '仅依据列出的本地轨迹记录和当前来源可观测字段。'
      : evaluation.summary,
    attribution: resultAttribution(evaluation, verdict),
    blockedBy: [],
    denominatorEligible: verdict === 'pass'
      || verdict === 'fail'
      || verdict === 'warning',
    label: evaluation.label,
    summary: evaluation.summary,
  }
}

function recordText(record: TrajectoryRecord): string {
  if (typeof record.input === 'string') return record.input
  if (Array.isArray(record.input)) {
    return record.input.flatMap(entry => {
      if (entry === null || typeof entry !== 'object') return []
      const text = (entry as Record<string, unknown>).text
      return typeof text === 'string' ? [text] : []
    }).join('\n')
  }
  return record.summary
}

function requirementRecords(detail: SessionDetail): TrajectoryRecord[] {
  return [...detail.projection.records]
    .filter(record => record.kind === 'user' || record.kind === 'steering')
    .filter(record => {
      const text = recordText(record).trim()
      return text !== ''
        && !text.startsWith('# AGENTS.md instructions')
        && !text.startsWith('<environment_context')
        && !/^(?:确认|好的|可以|同意|继续|执行吧|开始吧)[。！!]?$/u.test(text)
    })
    .sort((left, right) => left.seq - right.seq || left.startTime - right.startTime)
}

function supersedesEarlier(text: string): boolean {
  return /(?:改为|改成|不要再|取消|忽略前|替代|instead|rather than)/iu.test(text)
}

export function buildRequirementResults(
  detail: SessionDetail,
  analysis: TrajectoryAnalysis,
  quality: FactsQualityReport,
): RequirementResult[] {
  const records = requirementRecords(detail)
  const candidates = records.length > 0
    ? records.map(record => ({
        id: `requirement:${record.id}`,
        text: compact(recordText(record)),
        evidenceRecordIds: [record.id],
      }))
    : [{
        id: 'requirement:objective',
        text: analysis.objective,
        evidenceRecordIds: [],
      }]
  const lastSupersedingIndex = candidates.reduce((selected, candidate, index) =>
    supersedesEarlier(candidate.text) ? index : selected, -1)
  const active = candidates.filter((_candidate, index) => index >= lastSupersedingIndex)
  const blocked = quality.blockedCriterionIds.includes('outcome')

  return candidates.map((candidate, index) => {
    if (lastSupersedingIndex > 0 && index < lastSupersedingIndex) {
      return {
        ...candidate,
        required: false,
        state: 'superseded',
        reason: '后续用户要求明确替代或取消了此前要求。',
      }
    }
    if (blocked) {
      return {
        ...candidate,
        required: true,
        state: 'insufficient_evidence',
        reason: '结果判据被事实质量门禁短路。',
      }
    }
    if (active.length > 1) {
      return {
        ...candidate,
        required: true,
        state: 'insufficient_evidence',
        reason: '轨迹没有逐项验收证据，不能把整体结果自动分摊到多个要求。',
      }
    }
    if (analysis.outcome.tone === 'positive') {
      return {
        ...candidate,
        required: true,
        state: 'implemented',
        evidenceRecordIds: unique([
          ...candidate.evidenceRecordIds,
          ...analysis.outcome.evidenceRecordIds,
        ]),
        reason: analysis.outcome.summary,
      }
    }
    if (analysis.outcome.tone === 'negative') {
      return {
        ...candidate,
        required: true,
        state: 'understood_unimplemented',
        evidenceRecordIds: unique([
          ...candidate.evidenceRecordIds,
          ...analysis.outcome.evidenceRecordIds,
        ]),
        reason: analysis.outcome.summary,
      }
    }
    return {
      ...candidate,
      required: true,
      state: 'insufficient_evidence',
      reason: analysis.outcome.summary,
    }
  })
}

const CONTINUITY_REFERENCE = /(?:继续|按(?:照)?|基于|前述|上述|前面|已确认|方案|计划|建议)/u
const CONTINUITY_FAILURE = /(?:忘了|遗漏|没有按|没按|未按|前面.+(?:丢|漏|没)|不对|错误继承)/u

export function buildChainResult(detail: SessionDetail): ChainResult {
  const records = requirementRecords(detail)
  const byTurn = new Map<number, TrajectoryRecord[]>()
  for (const record of records) {
    const current = byTurn.get(record.turn) ?? []
    current.push(record)
    byTurn.set(record.turn, current)
  }
  const turns = [...byTurn].sort(([left], [right]) => left - right)
  if (turns.length < 2) {
    return {
      continuity: 'not_applicable',
      transitions: [],
      evidenceRecordIds: records.map(record => record.id),
      reason: '只有一个包含用户要求的轮次，不存在跨轮承接。',
    }
  }
  const transitions: ChainTransition[] = []
  for (let index = 1; index < turns.length; index++) {
    const [fromTurn, fromRecords] = turns[index - 1]!
    const [toTurn, toRecords] = turns[index]!
    const text = toRecords.map(recordText).join('\n')
    const evidenceRecordIds = [
      ...fromRecords.map(record => record.id),
      ...toRecords.map(record => record.id),
    ]
    transitions.push({
      fromTurn,
      toTurn,
      continuity: CONTINUITY_FAILURE.test(text)
        ? 'missing'
        : CONTINUITY_REFERENCE.test(text)
          ? 'normal'
          : 'insufficient_evidence',
      evidenceRecordIds,
      reason: CONTINUITY_FAILURE.test(text)
        ? '用户在后续轮次明确指出前序信息被遗漏或错误继承。'
        : CONTINUITY_REFERENCE.test(text)
          ? '后续要求显式引用前序方案、要求或结论。'
          : '轨迹没有足够的结构化证据判断跨轮信息是否正确承接。',
    })
  }
  const failed = transitions.find(transition =>
    transition.continuity === 'missing' || transition.continuity === 'incorrect')
  const continuity = failed?.continuity
    ?? (transitions.every(transition => transition.continuity === 'normal')
      ? 'normal'
      : 'insufficient_evidence')
  return {
    continuity,
    failedTransition: failed === undefined
      ? undefined
      : { fromTurn: failed.fromTurn, toTurn: failed.toTurn },
    transitions,
    evidenceRecordIds: unique(transitions.flatMap(item => item.evidenceRecordIds)),
    reason: failed?.reason
      ?? (continuity === 'normal'
        ? '所有可评估跨轮转换均有显式承接信号。'
        : '至少一个跨轮转换缺少足够的承接证据。'),
  }
}

export function evaluationFactsHash(value: {
  analysis: TrajectoryAnalysis
  chain: ChainResult
  factsQuality: FactsQualityReport
  requirements: RequirementResult[]
}): string {
  return createHash('sha256')
    .update(JSON.stringify(redactSensitive(value)))
    .digest('base64url')
}

export function evaluateTrajectory(
  detail: SessionDetail,
  analysis: TrajectoryAnalysis,
  options: TrajectoryEvaluationOptions,
): TrajectoryEvaluation {
  const factsQuality = buildFactsQualityReport(detail, options)
  const requirements = buildRequirementResults(detail, analysis, factsQuality)
  const chain = buildChainResult(detail)
  const results = analysis.evaluations.map(evaluation =>
    mapEvaluation(evaluation, factsQuality))
  const factsHash = evaluationFactsHash({
    analysis,
    chain,
    factsQuality,
    requirements,
  })
  return {
    schemaVersion: 1,
    evaluatorId: LOCAL_TRAJECTORY_EVALUATOR_ID,
    evaluatorVersion: LOCAL_TRAJECTORY_EVALUATOR_VERSION,
    factsSchemaVersion: EVALUATION_FACTS_SCHEMA_VERSION,
    target: options.target,
    factsHash,
    factsQuality,
    requirements,
    chain,
    results,
  }
}

export function aggregateEvaluationResults(
  results: readonly EvaluationResult[],
): EvaluationAggregate {
  const count = (verdict: EvaluationResult['verdict']) =>
    results.filter(result => result.verdict === verdict).length
  return {
    total: results.length,
    denominatorEligible: results.filter(result => result.denominatorEligible).length,
    pass: count('pass'),
    fail: count('fail'),
    warning: count('warning'),
    notApplicable: count('not_applicable'),
    insufficientEvidence: count('insufficient_evidence'),
    evaluatorError: count('evaluator_error'),
    outOfScope: count('out_of_scope'),
  }
}
