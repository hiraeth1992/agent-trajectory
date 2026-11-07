import type { AnalysisEvidenceLevel, TrajectoryAnalysis } from './trajectory-analysis'
import { correctionRecoveryLabel } from './trajectory-analysis'
import type { SourceCapabilities, TrajectoryRecord, TrajectoryTurnSummary } from './types'
import { tokenTotal } from './token-usage'

export interface EvidenceReviewRequest {
  title: string
  recordIds: string[]
  description?: string
  level?: AnalysisEvidenceLevel
}

export const REVIEW_FILTERS = [
  ['failed', '执行失败'],
  ['repeated', '重复失败'],
  ['unresolved', '未确认恢复'],
  ['time', '耗时靠前'],
  ['tokens', 'Token 靠前'],
  ['interrupted', '中断记录'],
] as const
export type ReviewFilter = typeof REVIEW_FILTERS[number][0]

export interface ReviewStep extends EvidenceReviewRequest {
  id: string
  turn: number
  step: number
  durationMs: number | null
  tokens?: number
  tags: ReviewFilter[]
  recovery?: string
  result: string
}

// Uses existing step attribution and recovery analysis. This view never sums
// evidence-chain usage or infers a new retry relation from adjacent failures.
export function buildReviewSteps(
  analysis: TrajectoryAnalysis,
  records: readonly TrajectoryRecord[],
  turns: readonly TrajectoryTurnSummary[] = [],
  capabilities?: SourceCapabilities,
): ReviewStep[] {
  const byId = new Map(records.map(record => [record.id, record]))
  const interruptedTurns = new Set(turns
    .filter(turn => turn.status === 'interrupted').map(turn => turn.number))
  const canceled = (record: TrajectoryRecord) => record.status === 'interrupted'
    || record.error?.code === '130' && interruptedTurns.has(record.turn)
  const failed = (id: string) => {
    const record = byId.get(id)
    return record !== undefined && record.status === 'error' && !canceled(record)
      && (record.kind === 'tool' || record.kind === 'subtool'
        || record.kind === 'model' || record.kind === 'assistant')
  }
  const ranked = (metric: (step: TrajectoryAnalysis['steps'][number]) => number) =>
    new Set([...analysis.costSteps]
      .filter(step => metric(step) > 0)
      .sort((left, right) => metric(right) - metric(left)
        || left.turn - right.turn || left.step - right.step)
      .slice(0, 5).map(step => step.id))
  const time = ranked(step => capabilities?.timing === false ? 0 : step.durationMs ?? 0)
  const tokens = ranked(step => capabilities?.usage === false ? 0 : tokenTotal(step.usage))
  const repeats = analysis.optimizations?.filter(item =>
    item.category === 'retry' && new Set(item.evidence
      .filter(item => failed(item.recordId)).map(item => item.recordId)).size >= 2) ?? []

  return analysis.steps.map(step => {
    const ids = new Set(step.recordIds)
    const errors = step.recordIds.filter(failed)
    const appliesTo = (correction: TrajectoryAnalysis['corrections'][number], id: string) =>
      correction.triggerRecordId === undefined
        ? correction.recordIds.includes(id) : correction.triggerRecordId === id
    const corrections = analysis.corrections.filter(correction =>
      errors.some(id => appliesTo(correction, id)))
    const unmatchedErrors = errors.filter(id => !corrections.some(item => appliesTo(item, id)))
    const repeated = repeats.filter(item => item.evidence.some(item => ids.has(item.recordId)))
    const tags: ReviewFilter[] = []
    if (errors.length > 0) tags.push('failed')
    if (repeated.length > 0) tags.push('repeated')
    if (unmatchedErrors.length > 0
      || corrections.some(item => item.status !== 'recovered')) tags.push('unresolved')
    if (time.has(step.id)) tags.push('time')
    if (tokens.has(step.id)) tags.push('tokens')
    const interrupted = step.recordIds.some(id => {
      const record = byId.get(id)
      return record !== undefined && canceled(record)
    })
    if (interrupted) tags.push('interrupted')
    const missingOutput = step.recordIds.some(id => {
      const record = byId.get(id)
      return record !== undefined && (record.kind === 'tool' || record.kind === 'subtool')
        && record.status === 'complete' && record.output === undefined && record.error === undefined
    })
    const recovery = errors.length === 0 ? undefined : [
      ...corrections.map(item => `${correctionRecoveryLabel(item)}：${item.result}`),
      ...(unmatchedErrors.length === 0 ? [] : [`${unmatchedErrors.length} 条失败记录没有对应恢复证据`]),
    ].join('；')
    const result = errors.length === 0 && interrupted
      ? '存在中断记录，未作为执行失败计入筛选'
      : missingOutput ? '来源缺少部分工具输出，完成状态不能替代结果验证' : step.result
    return {
      id: step.id,
      title: step.action,
      description: `${step.execution}；${result}`,
      result,
      level: step.reasonLevel,
      recordIds: [...new Set([
        ...step.recordIds,
        ...corrections.flatMap(item => item.recordIds),
        ...repeated.flatMap(item => item.evidence.map(item => item.recordId)),
      ])],
      turn: step.turn,
      step: step.step,
      durationMs: capabilities?.timing === false ? null : step.durationMs,
      tokens: capabilities?.usage === false || step.usage === undefined
        || step.usage.totalTokens === undefined && step.usage.inputTokens === undefined && step.usage.outputTokens === undefined
        ? undefined : tokenTotal(step.usage),
      tags,
      recovery,
    }
  })
}
