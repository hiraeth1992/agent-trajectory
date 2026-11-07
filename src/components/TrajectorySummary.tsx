/// <reference types="vite/client" />

import {
  Activity,
  BarChart3,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Clock3,
  Coins,
  Eye,
  GitBranch,
  LocateFixed,
  RotateCcw,
  ShieldCheck,
  Target,
  TimerReset,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import type {
  AnalysisConfidence,
  AnalysisCorrection,
  AnalysisEvaluation,
  AnalysisLocation,
  AnalysisStep,
  TrajectoryAnalysis,
} from '../trajectory-analysis'
import type { SourceCapabilities, SourceId, SourceStatus, TokenUsage, TrajectoryRecord, TrajectoryTurnSummary } from '../types'
import type { FactsQualityReport } from '../evaluation-types'
import { buildReviewSteps, REVIEW_FILTERS, type EvidenceReviewRequest, type ReviewFilter, type ReviewStep } from '../analysis-review'
import {
  exclusiveTokenBreakdown,
  nestedTokenBreakdown,
  selectedTokenTotal,
  TOKEN_BREAKDOWN_KEYS,
  tokenTotal,
  type TokenBreakdownKey,
} from '../token-usage'
import {
  formatDuration,
  formatNumber,
  formatTime,
  KIND_LABELS,
} from '../trajectory-view-model'
import { buildTrajectoryStory, stepsActiveDuration } from '../trajectory-story'
import type { TrajectoryStory as Story } from '../trajectory-story'
import { HoverDetailText } from './HoverDetailText'
import { OptimizationPanel } from './OptimizationPanel'
import { TrajectoryDiagnosisButton } from './TrajectoryDiagnosisButton'
import { TrajectoryStory } from './TrajectoryStory'
import { FactsQualityDetails, ReviewFilters } from './AnalysisReview'
import { EvidenceLinks } from './EvidenceLinks'

type CostMode = 'time' | 'tokens'

const CORRECTION_CONTENT_LIMIT = 30

interface SummarySessionMeta {
  eventCount: number
  recordCount: number
  eventTypeCount: number
  completedTurns: number
  createdAt: number
  updatedAt: number
  projectionStartTime?: number
  projectionEndTime?: number
}

interface TrajectorySummaryProps {
  analysis: TrajectoryAnalysis
  source: SourceId
  sourceSessionId: string
  sessionModel?: string
  sessionProvider?: string
  sessionMeta?: SummarySessionMeta
  onOpenRecord: (recordId: string) => void
  records?: readonly TrajectoryRecord[]
  turns?: readonly TrajectoryTurnSummary[]
  factsQuality?: FactsQualityReport
  capabilities?: SourceCapabilities
  sourceStatus?: SourceStatus
  onReview?: (request: EvidenceReviewRequest, selectedId?: string) => void
}

const TOKEN_SEGMENTS: Array<{
  key: TokenBreakdownKey
  label: string
  className: string
}> = [
  { key: 'inputTokens', label: '非缓存输入', className: 'token-input' },
  { key: 'outputTokens', label: '输出', className: 'token-output' },
  { key: 'reasoningTokens', label: '推理输出', className: 'token-reasoning' },
  { key: 'cacheReadTokens', label: '缓存读取', className: 'token-cache-read' },
  { key: 'cacheWriteTokens', label: '缓存写入', className: 'token-cache-write' },
  { key: 'otherTokens', label: '其他', className: 'token-other' },
]

function usageValue(usage: TokenUsage | undefined): number {
  return tokenTotal(usage)
}

function sumUsage(values: readonly (TokenUsage | undefined)[]): TokenUsage | undefined {
  const result: TokenUsage = {}
  for (const usage of values) {
    if (usage === undefined) continue
    for (const key of Object.keys(usage) as Array<keyof TokenUsage>) {
      const value = usage[key]
      if (value !== undefined) result[key] = (result[key] ?? 0) + value
    }
  }
  return Object.keys(result).length === 0 ? undefined : result
}

function tokenUsageText(
  usage: TokenUsage | undefined,
  includeTotal = true,
): string {
  const breakdown = nestedTokenBreakdown(usage)
  return [
    ...(includeTotal
      ? [`总量 ${formatNumber(breakdown.totalTokens)}`]
      : []),
    `输入 ${formatNumber(breakdown.inputTokens)}（缓存 ${
      formatNumber(breakdown.cacheTokens)
    }）`,
    `输出 ${formatNumber(breakdown.outputTokens)}（推理 ${
      formatNumber(breakdown.reasoningTokens)
    }）`,
  ].join(' · ')
}

function evidenceLabel(level: AnalysisStep['reasonLevel']): string {
  if (level === 'fact') return '轨迹记录'
  if (level === 'inferred') return '相邻步骤推断'
  return '未记录'
}

function confidenceLabel(confidence: AnalysisConfidence): string {
  if (confidence === 'high') return '高置信'
  if (confidence === 'medium') return '中置信'
  return '低置信'
}

function statusLabel(status: AnalysisStep['status']): string {
  if (status === 'complete') return '完成'
  if (status === 'running') return '执行中'
  if (status === 'error') return '失败'
  return '中断'
}

function truncateCorrectionContent(value: string): {
  display: string
  truncated: boolean
} {
  const characters = Array.from(value)
  return {
    display: characters.slice(0, CORRECTION_CONTENT_LIMIT).join(''),
    truncated: characters.length > CORRECTION_CONTENT_LIMIT,
  }
}

function evaluationIcon(evaluation: AnalysisEvaluation): LucideIcon {
  if (evaluation.id === 'outcome') return ShieldCheck
  if (evaluation.id === 'reliability') return Activity
  if (evaluation.id === 'recovery') return RotateCcw
  if (evaluation.id === 'efficiency') return BarChart3
  return Eye
}

function EvidenceButton({
  recordId,
  onOpenRecord,
  children,
  className = '',
  showIconWhenUnavailable = false,
}: {
  recordId: string | undefined
  onOpenRecord: (recordId: string) => void
  children: React.ReactNode
  className?: string
  showIconWhenUnavailable?: boolean
}) {
  if (recordId === undefined) {
    return (
      <span className={`${showIconWhenUnavailable ? 'summary-evidence-link ' : ''}${className}`}>
        {children}
        {showIconWhenUnavailable && <LocateFixed size={13} />}
      </span>
    )
  }
  return (
    <button
      className={`summary-evidence-link ${className}`}
      type="button"
      onClick={() => onOpenRecord(recordId)}
    >
      {children}
      <LocateFixed size={13} />
    </button>
  )
}

function qualityBlockCount(quality: FactsQualityReport | undefined, criterion: AnalysisEvaluation['id']): number {
  return quality?.issues.filter(issue => issue.severity === 'blocking'
    && issue.affectedCriterionIds.includes(criterion)).length ?? 0
}

function QualityBoundary({ count }: { count: number }) {
  return <>
    <p>现有数据不足，暂无法判断。</p>
    <a className="quality-basis-link" href="#analysis-basis">查看数据质量（{count} 项限制）</a>
  </>
}

function OutcomeHero({
  analysis,
  source,
  sourceSessionId,
  onOpenRecord,
  records,
  onReview,
  factsQuality,
  withObjective = false,
}: TrajectorySummaryProps & {
  withObjective?: boolean
}) {
  const blocked = qualityBlockCount(factsQuality, 'outcome')
  return (
    <section
      className={`summary-outcome outcome-${analysis.outcome.tone}${
        withObjective ? ' with-objective' : ''
      }`}
    >
      <div className="outcome-icon">
        {analysis.outcome.tone === 'positive'
          ? <CheckCircle2 size={22} />
          : analysis.outcome.tone === 'negative'
            ? <CircleAlert size={22} />
            : <CircleHelp size={22} />}
      </div>
      <div className="outcome-copy">
        <span className="summary-eyebrow">
          执行结论 · {confidenceLabel(analysis.outcome.confidence)}
        </span>
        <h1>{analysis.outcome.label}</h1>
        {blocked > 0 ? <QualityBoundary count={blocked} /> : <p>
          <HoverDetailText text={analysis.outcome.summary} />
        </p>}
        {blocked === 0 && analysis.outcome.evidenceRecordIds.length > 0 && <EvidenceLinks
          title="执行结论"
          recordIds={analysis.outcome.evidenceRecordIds}
          onOpenRecord={onOpenRecord}
          records={records}
          onReview={onReview}
        />}
      </div>
      <TrajectoryDiagnosisButton
        source={source}
        sourceSessionId={sourceSessionId}
      />
      {withObjective && <Objective analysis={analysis} />}
    </section>
  )
}

function StatStrip({
  analysis,
  sessionMeta,
}: {
  analysis: TrajectoryAnalysis
  sessionMeta?: SummarySessionMeta
}) {
  const items: Array<{
    icon: LucideIcon
    label: string
    value: string
    detail?: string
    className?: string
  }> = [
    {
      icon: Clock3,
      label: '墙钟耗时 / 活跃耗时',
      value: `${
        sessionMeta === undefined
          ? '—'
          : formatDuration(Math.max(
              0,
              Math.max(
                sessionMeta.updatedAt,
                sessionMeta.projectionEndTime ?? sessionMeta.updatedAt,
              )
                - Math.min(
                  sessionMeta.createdAt,
                  sessionMeta.projectionStartTime ?? sessionMeta.createdAt,
                ),
            ))
      } / ${formatDuration(analysis.stats.durationMs)}`,
      detail: sessionMeta === undefined
        ? undefined
        : `更新于 ${formatTime(sessionMeta.updatedAt)}`,
    },
    {
      icon: Activity,
      label: '事件 / 记录',
      value: sessionMeta === undefined
        ? '—'
        : `${formatNumber(sessionMeta.eventCount)} / ${formatNumber(sessionMeta.recordCount)}`,
      detail: sessionMeta === undefined
        ? undefined
        : `${sessionMeta.eventTypeCount} 种事件类型`,
    },
    {
      icon: GitBranch,
      label: '轮次 / 步骤',
      value: `${analysis.stats.turns} / ${analysis.stats.steps}`,
      detail: sessionMeta === undefined
        ? undefined
        : `${sessionMeta.completedTurns} / ${analysis.stats.turns} 轮已完成`,
    },
    {
      icon: RotateCcw,
      label: '异常 / 已恢复',
      value: `${analysis.stats.errors + analysis.stats.retries} / ${analysis.stats.recovered}`,
    },
    {
      icon: Coins,
      label: 'Token',
      value: formatNumber(analysis.stats.totalTokens),
      detail: `${tokenUsageText({
        inputTokens: analysis.stats.inputTokens,
        outputTokens: analysis.stats.outputTokens,
        reasoningTokens: analysis.stats.reasoningTokens,
        cacheReadTokens: analysis.stats.cacheReadTokens,
        cacheWriteTokens: analysis.stats.cacheWriteTokens,
        totalTokens: analysis.stats.totalTokens,
      }, false)}${
        analysis.stats.tokenAllocationCoverage === undefined
          ? ''
          : ` · 步骤覆盖 ${Math.round(analysis.stats.tokenAllocationCoverage * 100)}%`
      }${
        (analysis.stats.unallocatedTokens ?? 0) > 0
          ? ` · 未分配 ${formatNumber(analysis.stats.unallocatedTokens)}`
          : (analysis.stats.overallocatedTokens ?? 0) > 0
            ? ` · 步骤超出 ${formatNumber(analysis.stats.overallocatedTokens)}`
            : ''
      }`,
      className: 'summary-stat-token',
    },
  ]
  return (
    <section className="summary-stat-strip" aria-label="轨迹核心指标">
      {items.map(({ icon: Icon, label, value, detail, className = '' }) => (
        <div
          className={`summary-stat${detail === undefined ? '' : ' with-detail'} ${className}`}
          key={label}
        >
          <Icon size={15} />
          <span>{label}</span>
          <strong>{value}</strong>
          {detail !== undefined && <small className="summary-stat-detail">{detail}</small>}
        </div>
      ))}
    </section>
  )
}

function Objective({
  analysis,
}: {
  analysis: TrajectoryAnalysis
}) {
  return (
    <section className="summary-objective">
      <header>
        <Target size={16} />
        <span>{analysis.objectiveLabel}</span>
      </header>
      <strong>
        <HoverDetailText
          placement="below"
          text={analysis.objective}
        />
      </strong>
    </section>
  )
}

function StepCard({
  step,
  onOpenRecord,
  onReview,
  review,
  capabilities,
  selected = false,
  onSelect,
}: {
  step: AnalysisStep
  onOpenRecord: (recordId: string) => void
  onReview?: TrajectorySummaryProps['onReview']
  review?: ReviewStep
  capabilities?: SourceCapabilities
  selected?: boolean
  onSelect?: (stepId: string) => void
}) {
  const stepNumber = step.step > 0 ? String(step.step) : '—'
  const evidence = review ?? { title: step.action, recordIds: step.recordIds,
    description: step.result, level: step.reasonLevel }
  const openEvidence = () => onReview === undefined ? onOpenRecord(step.recordId) : onReview(evidence, step.recordId)
  return (
    <div
      className={`analysis-step status-${step.status}${
        selected ? ' story-selected' : ''
      }`}
      id={`decision-${step.id.replace(/[^A-Za-z0-9_-]/g, '-')}`}
    >
      <div className="step-rail">
        <span
          className={`step-number-badge status-${step.status}`}
          aria-label={step.step > 0 ? `轮内第 ${step.step} 步` : '会话级步骤'}
        >
          {stepNumber}
        </span>
      </div>
      <div className="step-card-shell">
        <button
          type="button"
          className="step-body"
          aria-pressed={onSelect === undefined ? undefined : selected}
          onClick={() => {
            if (onSelect === undefined) openEvidence()
            else onSelect(step.id)
          }}
          aria-label={onSelect === undefined
            ? `查看轨迹证据：${step.action}`
            : `在故事线中选择：${step.action}`}
        >
          <header>
            <span className={`kind-badge kind-${step.kind}`}>{KIND_LABELS[step.kind]}</span>
            <strong>{step.action}</strong>
            <small>{statusLabel(step.status)}</small>
          </header>
          {review !== undefined && <div className="review-tags">{review.tags.map(tag =>
            <span key={tag}>{REVIEW_FILTERS.find(([id]) => id === tag)?.[1]}</span>)}</div>}
          <div className="step-reason">
            <Brain size={13} />
            <span>{step.reason}</span>
            <em className={`evidence-${step.reasonLevel}`}>{evidenceLabel(step.reasonLevel)}</em>
          </div>
          <div className="step-result step-execution">
            <span>执行</span>
            <strong>{step.execution}</strong>
          </div>
          <div className="step-result">
            <span>结果</span>
            <strong>{review?.result ?? step.result}</strong>
          </div>
          {review?.recovery !== undefined && <p className="step-recovery">{review.recovery}（关系来自轨迹分析）</p>}
          <footer>
            <span><Clock3 size={12} />{formatDuration(capabilities?.timing === false ? null : step.durationMs)}</span>
            <span className="step-token-usage">
              <Coins size={12} />
              {tokenUsageText(capabilities?.usage === false ? undefined : step.usage)}
            </span>
          </footer>
        </button>
        <button
          type="button"
          className="step-evidence-action"
          aria-label={onReview === undefined ? `查看轨迹证据：${step.action}` : `审阅 ${evidence.recordIds.length} 条证据：${step.action}`}
          title={`审阅 ${evidence.recordIds.length} 条证据`}
          onClick={openEvidence}
        >
          <LocateFixed size={13} />
        </button>
      </div>
    </div>
  )
}

function DecisionPath({
  analysis,
  onOpenRecord,
  onReview,
  records,
  capabilities,
  reviewSteps,
  story,
  selectedStageId,
  openStageRequest,
  onSelectStage,
}: TrajectorySummaryProps & {
  story?: Story
  selectedStageId?: string
  openStageRequest?: { stageId: string; revision: number }
  onSelectStage?: (stageId: string) => void
  reviewSteps: readonly ReviewStep[]
}) {
  const [filters, setFilters] = useState<Set<ReviewFilter>>(() => new Set())
  const reviews = useMemo(() => new Map(reviewSteps.map(step => [step.id, step])), [reviewSteps])
  const groups = useMemo(() => {
    const result = new Map<number, AnalysisStep[]>()
    const ordered = [...analysis.steps].sort((left, right) =>
      left.turn - right.turn
      || left.step - right.step
      || left.id.localeCompare(right.id))
    for (const step of ordered) {
      if (![...filters].every(filter => reviews.get(step.id)?.tags.includes(filter))) continue
      const group = result.get(step.turn) ?? []
      group.push(step)
      result.set(step.turn, group)
    }
    return [...result.entries()]
  }, [analysis.steps, reviews, filters])
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const handledStageRequest = useRef<typeof openStageRequest>()
  const selectedStage = story?.stages.find(stage => stage.id === selectedStageId)
  const selectedStepIds = useMemo(
    () => new Set(selectedStage?.stepIds ?? []),
    [selectedStage],
  )

  useEffect(() => {
    if (openStageRequest === undefined || handledStageRequest.current === openStageRequest) return
    const requestedStage = story?.stages.find(stage =>
      stage.id === openStageRequest.stageId)
    if (requestedStage === undefined) return
    handledStageRequest.current = openStageRequest
    setFilters(new Set())
    setExpanded(current => new Set([...current, ...requestedStage.turns]))
    const firstStepId = requestedStage.stepIds[0]
    if (firstStepId === undefined) return
    const timer = window.setTimeout(() => {
      document.getElementById(
        `decision-${firstStepId.replace(/[^A-Za-z0-9_-]/g, '-')}`,
      )?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [openStageRequest, story])

  const selectStep = (stepId: string) => {
    const stageId = story?.stageIdByStepId[stepId]
    if (stageId !== undefined) onSelectStage?.(stageId)
  }
  const changeFilters = (next: Set<ReviewFilter>) => {
    setFilters(next)
    if (next.size > 0) setExpanded(new Set(analysis.steps.filter(step =>
      [...next].every(filter => reviews.get(step.id)?.tags.includes(filter))).map(step => step.turn)))
  }

  return (
    <section className="summary-panel decision-panel" aria-label="步骤详情">
      <header className="summary-panel-heading">
        <div>
          <GitBranch size={17} />
          <span>
            <strong>步骤详情</strong>
            <small>按轮次查看行动、结果和完整关联证据</small>
          </span>
        </div>
      </header>
      {records !== undefined && <ReviewFilters steps={reviewSteps} total={analysis.steps.length}
        visible={groups.reduce((total, [, steps]) => total + steps.length, 0)}
        filters={filters} onChange={changeFilters} />}
      <div className="decision-turns">
        {groups.length === 0
          ? <div className="summary-empty">{filters.size > 0 ? '没有同时满足这些条件的步骤' : '没有可分析的行动步骤'}</div>
          : groups.map(([turn, steps]) => {
              const isExpanded = expanded.has(turn)
              const duration = stepsActiveDuration(steps, records, capabilities?.timing)
              const usage = capabilities?.usage === false ? undefined : sumUsage(steps.map(step => step.usage))
              const breakdown = nestedTokenBreakdown(usage)
              return (
                <section className="decision-turn" key={turn}>
                  <button
                    type="button"
                    className={`decision-turn-toggle${
                      selectedStage?.turns.includes(turn) === true ? ' story-selected' : ''
                    }`}
                    aria-expanded={isExpanded}
                    onClick={() => {
                      const stageId = story?.stageIdByStepId[steps[0]?.id ?? '']
                      if (stageId !== undefined) onSelectStage?.(stageId)
                      setExpanded((current) => {
                        const next = new Set(current)
                        if (next.has(turn)) next.delete(turn)
                        else next.add(turn)
                        return next
                      })
                    }}
                  >
                    {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    <strong>{turn === 0 ? '会话级动作' : `第 ${turn} 轮`}</strong>
                    <span>{steps.length} 步</span>
                    <span className="decision-turn-metric decision-turn-duration">
                      活跃 {formatDuration(duration)}
                    </span>
                    <span
                      className="decision-turn-separator separator-after-duration"
                      aria-hidden="true"
                    >
                      ·
                    </span>
                    <span className="decision-turn-metric decision-turn-total">
                      总量 {formatNumber(breakdown.totalTokens)}
                    </span>
                    <span
                      className="decision-turn-separator separator-after-total"
                      aria-hidden="true"
                    >
                      ·
                    </span>
                    <span className="decision-turn-metric decision-turn-input">
                      {`输入 ${formatNumber(breakdown.inputTokens)}（缓存 ${
                        formatNumber(breakdown.cacheTokens)
                      }）`}
                    </span>
                    <span
                      className="decision-turn-separator separator-after-input"
                      aria-hidden="true"
                    >
                      ·
                    </span>
                    <span className="decision-turn-metric decision-turn-output">
                      {`输出 ${formatNumber(breakdown.outputTokens)}（推理 ${
                        formatNumber(breakdown.reasoningTokens)
                      }）`}
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="decision-steps">
                      {steps.map(step => (
                        <StepCard
                          key={step.id}
                          step={step}
                          onOpenRecord={onOpenRecord}
                          onReview={onReview}
                          review={reviews.get(step.id)}
                          capabilities={capabilities}
                          selected={selectedStepIds.has(step.id)}
                          onSelect={story === undefined ? undefined : selectStep}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )
            })}
      </div>
    </section>
  )
}

function EvaluationPanel({
  analysis,
  onOpenRecord,
  records,
  onReview,
  factsQuality,
  sourceStatus,
}: {
  analysis: TrajectoryAnalysis
  onOpenRecord: (recordId: string) => void
  records?: readonly TrajectoryRecord[]
  onReview?: TrajectorySummaryProps['onReview']
  factsQuality?: FactsQualityReport
  sourceStatus?: SourceStatus
}) {
  return (
    <section className="summary-panel evaluation-panel" aria-label="过程评测">
      <header className="summary-panel-heading">
        <div>
          <ShieldCheck size={17} />
          <span>
            <strong>过程评测</strong>
            <small>分项结论，不合成虚假精确的总分</small>
          </span>
        </div>
      </header>
      <div className="evaluation-list">
        {analysis.evaluations.filter(item => item.id !== 'observability').map((evaluation) => {
          const Icon = evaluationIcon(evaluation)
          const blocked = qualityBlockCount(factsQuality, evaluation.id)
          return (
            <article className={`evaluation-item grade-${evaluation.grade}`} key={evaluation.id}>
              <div className="evaluation-icon"><Icon size={16} /></div>
              <div>
                <span>
                  {evaluation.title} · {confidenceLabel(evaluation.confidence)}
                </span>
                <strong>{evaluation.label}</strong>
                {blocked > 0 ? <QualityBoundary count={blocked} /> : <p>{evaluation.summary}</p>}
                {blocked === 0 && <EvidenceLinks
                  title={evaluation.title}
                  recordIds={evaluation.evidenceRecordIds}
                  records={records}
                  onOpenRecord={onOpenRecord}
                  onReview={onReview}
                />}
              </div>
            </article>
          )
        })}
        <FactsQualityDetails analysis={analysis} quality={factsQuality} sourceStatus={sourceStatus} onReview={onReview} />
      </div>
    </section>
  )
}

function TokenSegments({
  usage,
  maxValue,
  selected,
}: {
  usage: TokenUsage | undefined
  maxValue: number
  selected: ReadonlySet<TokenBreakdownKey>
}) {
  const breakdown = exclusiveTokenBreakdown(usage)
  const selectedTotal = TOKEN_SEGMENTS.reduce(
    (total, segment) =>
      total + (selected.has(segment.key) ? breakdown[segment.key] : 0),
    0)
  if (selectedTotal === 0) {
    return <div className="cost-bar-empty">所选类型无 Token</div>
  }
  return (
    <div
      className="token-segments"
      style={{
        width: `${Math.max(1.5, selectedTotal / Math.max(1, maxValue) * 100)}%`,
      }}
    >
      {TOKEN_SEGMENTS.map(segment => {
        if (!selected.has(segment.key)) return null
        const value = breakdown[segment.key]
        if (value <= 0) return null
        return (
          <span
            className={segment.className}
            key={segment.key}
            style={{ width: `${value / selectedTotal * 100}%` }}
            title={`${segment.label} ${formatNumber(value)}`}
          />
        )
      })}
    </div>
  )
}

function CostChart({
  analysis,
  onOpenRecord,
}: TrajectorySummaryProps) {
  const [mode, setMode] = useState<CostMode>('time')
  const [turn, setTurn] = useState<number | 'all'>('all')
  const [tokenTypes, setTokenTypes] = useState<Set<TokenBreakdownKey>>(
    () => new Set(TOKEN_BREAKDOWN_KEYS),
  )
  const turns = useMemo(
    () => [...new Set(analysis.costSteps.map(step => step.turn))]
      .sort((left, right) => left - right),
    [analysis.costSteps],
  )
  useEffect(() => {
    setTurn('all')
    setTokenTypes(new Set(TOKEN_BREAKDOWN_KEYS))
  }, [analysis])
  const ranked = useMemo(() => {
    const metric = (step: AnalysisStep) =>
      mode === 'time'
        ? step.durationMs ?? 0
        : selectedTokenTotal(step.usage, tokenTypes)
    return analysis.costSteps
      .filter(step => turn === 'all' || step.turn === turn)
      .filter(step => mode === 'time' || metric(step) > 0)
      .sort((left, right) =>
        metric(right) - metric(left)
        || left.turn - right.turn || left.step - right.step)
      .slice(0, 24)
  }, [analysis.costSteps, mode, tokenTypes, turn])
  const max = Math.max(1, ...ranked.map(step =>
    mode === 'time'
      ? step.durationMs ?? 0
      : selectedTokenTotal(step.usage, tokenTypes)))
  const toggleTokenType = (key: TokenBreakdownKey) => {
    setTokenTypes(current => {
      if (current.has(key) && current.size === 1) return current
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <section className="summary-panel cost-panel">
      <header className="summary-panel-heading">
        <div>
          <BarChart3 size={17} />
          <span>
            <strong>每一步成本</strong>
            <small>
              {turn === 'all' ? '全部轮次' : turn === 0 ? '会话级' : `第 ${turn} 轮`}
              {' · '}
              {`按${mode === 'time' ? '耗时' : 'Token'}从高到低`}
              ，显示前 24 个逻辑步骤
            </small>
          </span>
        </div>
        <div className="cost-controls">
          <label>
            <span>轮次</span>
            <select
              aria-label="筛选成本轮次"
              value={turn}
              onChange={event => setTurn(
                event.target.value === 'all' ? 'all' : Number(event.target.value),
              )}
            >
              <option value="all">全部轮次</option>
              {turns.map(value => (
                <option value={value} key={value}>
                  {value === 0 ? '会话级' : `第 ${value} 轮`}
                </option>
              ))}
            </select>
          </label>
          <div className="cost-mode" role="group" aria-label="切换成本指标">
            <button
              type="button"
              className={mode === 'time' ? 'active' : ''}
              onClick={() => setMode('time')}
            >
              耗时
            </button>
            <button
              type="button"
              className={mode === 'tokens' ? 'active' : ''}
              onClick={() => setMode('tokens')}
            >
              Token
            </button>
          </div>
        </div>
      </header>
      {mode === 'tokens' && (
        <div className="token-legend" role="group" aria-label="筛选 Token 类型">
          {TOKEN_SEGMENTS.map(segment => (
            <button
              type="button"
              key={segment.key}
              className={tokenTypes.has(segment.key) ? 'selected' : ''}
              aria-pressed={tokenTypes.has(segment.key)}
              onClick={() => toggleTokenType(segment.key)}
            >
              <i className={segment.className} />{segment.label}
            </button>
          ))}
          <button
            type="button"
            className={tokenTypes.size === TOKEN_BREAKDOWN_KEYS.length
              ? 'selected all' : 'all'}
            aria-pressed={tokenTypes.size === TOKEN_BREAKDOWN_KEYS.length}
            onClick={() => setTokenTypes(new Set(TOKEN_BREAKDOWN_KEYS))}
          >
            全部
          </button>
        </div>
      )}
      <div className="cost-rows">
        {ranked.length === 0
          ? <div className="summary-empty">来源没有提供可比较的耗时或 Token 数据</div>
          : ranked.map((step, index) => {
              const value = mode === 'time'
                ? step.durationMs ?? 0
                : selectedTokenTotal(step.usage, tokenTypes)
              return (
                <button
                  className="cost-row"
                  type="button"
                  key={step.id}
                  onClick={() => onOpenRecord(step.recordId)}
                >
                  <span className="cost-rank">{index + 1}</span>
                  <span className="cost-name">
                    <strong>{step.action}</strong>
                    <small>{step.turn === 0 ? '会话级' : `第 ${step.turn} 轮`} · 步骤 {step.step || '—'}</small>
                  </span>
                  <span className="cost-track">
                    {mode === 'time'
                      ? (
                          <i
                            className="time-bar"
                            style={{ width: `${Math.max(1.5, value / max * 100)}%` }}
                          />
                        )
                      : (
                          <TokenSegments
                            usage={step.usage}
                            maxValue={max}
                            selected={tokenTypes}
                          />
                        )}
                  </span>
                  <strong className="cost-value">
                    {mode === 'time'
                      ? formatDuration(step.durationMs)
                      : formatNumber(value || undefined)}
                  </strong>
                  <LocateFixed size={12} />
                </button>
              )
            })}
      </div>
      <p className="cost-footnote">
        活跃耗时与轨迹概览一致，按记录区间并集计算；图中步骤耗时可重叠。Token 条长度表示
        步骤总量，颜色拆分输入、输出与缓存；不同提供方的字段仍保持来源原始口径。
        {(analysis.stats.unallocatedTokens ?? 0) > 0 && (
          <> 当前有 {formatNumber(analysis.stats.unallocatedTokens)} Token 无法归属到具体步骤。</>
        )}
        {(analysis.stats.overallocatedTokens ?? 0) > 0 && (
          <> 当前步骤合计比会话总量多 {formatNumber(analysis.stats.overallocatedTokens)} Token。</>
        )}
      </p>
    </section>
  )
}

function CorrectionPanel({
  analysis,
  onOpenRecord,
  records,
  onReview,
}: TrajectorySummaryProps) {
  const locationLabel = (location: AnalysisLocation | undefined): string =>
    location === undefined
      ? '位置未记录'
      : location.turn === 0
        ? `会话级·步骤${location.step || '—'}`
        : `第${location.turn}轮·步骤${location.step || '—'}`
  const locationRange = (locations: AnalysisCorrection['locations']): string => {
    const available = [
      locations.trigger,
      locations.diagnosis,
      locations.change,
      locations.result,
    ].filter((location): location is AnalysisLocation => location !== undefined)
    if (available.length === 0) return '位置未记录'
    const start = locations.trigger ?? available[0]
    const end = locations.result ?? available[available.length - 1]
    return `${locationLabel(start)}→${locationLabel(end)}`
  }
  return (
    <section className="summary-panel correction-panel">
      <header className="summary-panel-heading">
        <div>
          <TimerReset size={17} />
          <span>
            <strong>纠错与恢复</strong>
            <small>触发 → 模型判断 → 具体调整 → 后续结果</small>
          </span>
        </div>
      </header>
      {analysis.corrections.length === 0
        ? (
            <div className="correction-none">
              <CheckCircle2 size={17} />
              <span>
                <strong>没有观察到显式纠错</strong>
                <small>轨迹中未出现失败、中断、重试或用户中途引导。</small>
              </span>
            </div>
          )
        : (
            <div className="correction-list">
              {analysis.corrections.map((correction) => {
                const stages = [
                  {
                    label: '触发',
                    content: correction.trigger,
                    className: 'stage-trigger',
                  },
                  {
                    label: '模型判断',
                    content: correction.diagnosis,
                    className: 'stage-diagnosis',
                  },
                  {
                    label: '调整',
                    content: correction.change,
                    className: 'stage-change',
                  },
                  {
                    label: '结果',
                    content: correction.result,
                    className: 'stage-result',
                  },
                ]
                return (
                  <article
                    className={`correction-item correction-${correction.status}`}
                    key={correction.id}
                  >
                    <div className="correction-status">
                      <RotateCcw size={15} />
                      <strong>{correction.title}</strong>
                      <span>{confidenceLabel(correction.confidence)}</span>
                    </div>
                    <div className="correction-range">
                      {locationRange(correction.locations)}
                    </div>
                    <div className="correction-stages">
                      {stages.map((stage) => {
                        const content = truncateCorrectionContent(stage.content)
                        return (
                          <span
                            className={`correction-stage ${stage.className}`}
                            key={stage.label}
                          >
                            <strong>{stage.label}</strong>
                            <HoverDetailText
                              ariaLabel={content.truncated
                                ? `${stage.label}：${stage.content}`
                                : undefined}
                              className="correction-stage-content"
                              display={content.display}
                              enabled={content.truncated}
                              text={stage.content}
                              visibleClassName="correction-stage-visible"
                            />
                          </span>
                        )
                      })}
                    </div>
                    <EvidenceLinks
                      title="证据链"
                      recordIds={correction.recordIds}
                      records={records}
                      onOpenRecord={onOpenRecord}
                      onReview={onReview}
                    />
                  </article>
                )
              })}
            </div>
          )}
    </section>
  )
}

function SummaryContent(props: TrajectorySummaryProps) {
  const factsQuality = props.factsQuality
  const reviewSteps = useMemo(() => props.records === undefined ? []
    : buildReviewSteps(props.analysis, props.records, props.turns, props.capabilities),
  [props.analysis, props.records, props.turns, props.capabilities])
  const story = useMemo(
    () => buildTrajectoryStory(props.analysis, 8, {
      records: props.records, capabilities: props.capabilities, quality: factsQuality,
      reviewSteps: props.records === undefined ? undefined : reviewSteps,
    }),
    [props.analysis, props.records, props.capabilities, factsQuality, reviewSteps],
  )
  const [selectedStageId, setSelectedStageId] = useState<string>()
  const [openStageRequest, setOpenStageRequest] = useState<{
    stageId: string
    revision: number
  }>()
  useEffect(() => {
    setSelectedStageId(current =>
      story.stages.some(stage => stage.id === current)
        ? current
        : story.stages[0]?.id)
  }, [story])
  const selectStage = useCallback((stageId: string) => {
    setSelectedStageId(stageId)
  }, [])
  const openStageDetails = useCallback((stageId: string) => {
    setSelectedStageId(stageId)
    setOpenStageRequest(current => ({
      stageId,
      revision: (current?.revision ?? 0) + 1,
    }))
  }, [])

  return (
    <div className="summary-variant">
      <OutcomeHero
        {...props}
        factsQuality={factsQuality}
        withObjective
      />
      <StatStrip analysis={props.analysis} sessionMeta={props.sessionMeta} />
      <TrajectoryStory
        story={story}
        selectedStageId={selectedStageId}
        onSelectStage={selectStage}
        onOpenStageDetails={openStageDetails}
      />
      <div className="summary-primary-grid">
        <DecisionPath
          key={`${props.source}:${props.sourceSessionId}`}
          {...props}
          reviewSteps={reviewSteps}
          story={story}
          selectedStageId={selectedStageId}
          openStageRequest={openStageRequest}
          onSelectStage={selectStage}
        />
        <aside className="summary-insight-column">
          <EvaluationPanel
            analysis={props.analysis}
            sourceStatus={props.sourceStatus}
            factsQuality={factsQuality}
            onOpenRecord={props.onOpenRecord}
            records={props.records}
            onReview={props.onReview}
          />
          <OptimizationPanel
            analysis={props.analysis}
            onOpenRecord={props.onOpenRecord}
            onReview={props.onReview}
          />
        </aside>
      </div>
      <CostChart {...props} />
      <CorrectionPanel {...props} />
    </div>
  )
}

export function TrajectorySummary(props: TrajectorySummaryProps) {
  return (
    <section className="trajectory-summary" aria-label="轨迹评测">
      <SummaryContent {...props} />
    </section>
  )
}
