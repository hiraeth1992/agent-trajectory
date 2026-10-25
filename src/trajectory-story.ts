import type {
  AnalysisCorrection,
  AnalysisEvidenceLevel,
  AnalysisStep,
  TrajectoryAnalysis,
} from './trajectory-analysis'
import type { TokenUsage } from './types'

export type TrajectoryStoryPhase =
  | 'orient'
  | 'inspect'
  | 'implement'
  | 'validate'
  | 'recover'
  | 'communicate'
  | 'context'

export interface TrajectoryStoryStage {
  id: string
  phase: TrajectoryStoryPhase
  title: string
  summary: string
  rationale: string
  judgment: string
  actions: string[]
  outcome: string
  rationaleLevel: AnalysisEvidenceLevel
  turnStart: number
  turnEnd: number
  turns: number[]
  stepIds: string[]
  recordIds: string[]
  stepCount: number
  errorCount: number
  recoveredCount: number
  durationMs: number | null
  usage?: TokenUsage
}

export interface TrajectoryStory {
  stages: TrajectoryStoryStage[]
  stageIdByStepId: Record<string, string>
}

interface StorySegment {
  phaseCounts: Record<TrajectoryStoryPhase, number>
  steps: AnalysisStep[]
}

const PHASES: TrajectoryStoryPhase[] = [
  'recover',
  'validate',
  'implement',
  'inspect',
  'orient',
  'communicate',
  'context',
]

const PHASE_LABELS: Record<TrajectoryStoryPhase, string> = {
  orient: '分析目标与方案',
  inspect: '检查现状与证据',
  implement: '修改实现',
  validate: '运行验证',
  recover: '处理异常与改道',
  communicate: '汇报阶段结果',
  context: '整理模型上下文',
}

const VALIDATION_PATTERN =
  /测试|验证|构建|类型检查|typecheck|lint|compile|pytest|vitest|jest|npm test|cargo test|go test/i
const IMPLEMENTATION_PATTERN =
  /修改|实现|新增|创建|删除|更新|重构|修复|配置|接入|写入|保存|apply_patch/i
const INSPECTION_PATTERN =
  /读取|搜索|检查代码|查看|核对|分析|调查|探针|查询|请求并检查|定位|发现/i
const COMMUNICATION_PATTERN =
  /汇报|说明执行|形成响应|回复用户|执行结果|阶段结果|结论/i

function phaseFor(step: AnalysisStep): TrajectoryStoryPhase {
  const text = `${step.action} ${step.execution} ${step.result}`
  if (step.status === 'error' || step.status === 'interrupted') return 'recover'
  if (VALIDATION_PATTERN.test(text)) return 'validate'
  if (IMPLEMENTATION_PATTERN.test(text)) return 'implement'
  if (INSPECTION_PATTERN.test(text)) return 'inspect'
  if (step.kind === 'compaction') return 'context'
  if (COMMUNICATION_PATTERN.test(text)) return 'communicate'
  return 'orient'
}

function emptyPhaseCounts(): Record<TrajectoryStoryPhase, number> {
  return {
    orient: 0,
    inspect: 0,
    implement: 0,
    validate: 0,
    recover: 0,
    communicate: 0,
    context: 0,
  }
}

function countsFor(step: AnalysisStep): Record<TrajectoryStoryPhase, number> {
  const counts = emptyPhaseCounts()
  counts[phaseFor(step)] = 1
  return counts
}

function dominantPhase(
  counts: Record<TrajectoryStoryPhase, number>,
): TrajectoryStoryPhase {
  return [...PHASES].sort((left, right) =>
    counts[right] - counts[left] || PHASES.indexOf(left) - PHASES.indexOf(right))[0]!
}

function phaseTitle(
  counts: Record<TrajectoryStoryPhase, number>,
): string {
  const present = new Set(PHASES.filter(phase => counts[phase] > 0))
  if (present.has('recover') && present.has('implement')) return '处理异常并修正实现'
  if (present.has('recover') && present.has('validate')) return '验证失败后调整方案'
  if (present.has('recover') && present.has('inspect')) return '排查异常并恢复执行'
  if (present.has('recover') && present.has('orient')) return '分析异常并调整方案'
  if (present.has('implement') && present.has('validate')) return '修改实现并运行验证'
  if (present.has('inspect') && present.has('implement')) return '检查现状并修改实现'
  if (present.has('inspect') && present.has('validate')) return '检查现状并验证'
  if (present.has('orient') && present.has('inspect')) return '分析方案与现状'
  return PHASE_LABELS[dominantPhase(counts)]
}

function baseSegments(steps: readonly AnalysisStep[]): StorySegment[] {
  const segments: StorySegment[] = []
  for (const step of steps) {
    const phase = phaseFor(step)
    const previous = segments.at(-1)
    if (previous !== undefined
      && previous.steps.at(-1)?.turn === step.turn
      && dominantPhase(previous.phaseCounts) === phase) {
      previous.steps.push(step)
      previous.phaseCounts[phase]++
      continue
    }
    segments.push({
      phaseCounts: countsFor(step),
      steps: [step],
    })
  }
  return segments
}

function foldRecoverySegments(initial: StorySegment[]): StorySegment[] {
  const segments = [...initial]
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index]!
    const recoveryOnly = segment.steps.every(step =>
      step.status === 'error' || step.status === 'interrupted')
    if (!recoveryOnly) continue
    const next = segments[index + 1]
    const previous = segments[index - 1]
    if (next !== undefined && next.steps[0]?.turn === segment.steps[0]?.turn) {
      segments.splice(index, 2, mergeSegments(segment, next))
      continue
    }
    if (previous !== undefined
      && previous.steps.at(-1)?.turn === segment.steps[0]?.turn) {
      segments.splice(index - 1, 2, mergeSegments(previous, segment))
    }
  }
  return segments
}

function errorCount(segment: StorySegment): number {
  return segment.steps.filter(step =>
    step.status === 'error' || step.status === 'interrupted').length
}

function mergeScore(left: StorySegment, right: StorySegment): number {
  const samePhase = dominantPhase(left.phaseCounts) === dominantPhase(right.phaseCounts)
  const sameTurn = left.steps.at(-1)?.turn === right.steps[0]?.turn
  const separatesErrors = (errorCount(left) > 0) !== (errorCount(right) > 0)
  const preservesFinalReport = dominantPhase(right.phaseCounts) === 'communicate'
  return left.steps.length + right.steps.length
    + (samePhase ? -1_000 : 0)
    + (sameTurn ? -300 : 0)
    + (separatesErrors ? 400 : 0)
    + (preservesFinalReport ? 80 : 0)
}

function mergeSegments(left: StorySegment, right: StorySegment): StorySegment {
  const phaseCounts = emptyPhaseCounts()
  for (const phase of PHASES) {
    phaseCounts[phase] = left.phaseCounts[phase] + right.phaseCounts[phase]
  }
  return {
    phaseCounts,
    steps: [...left.steps, ...right.steps],
  }
}

function compactSegments(
  initial: StorySegment[],
  maxStages: number,
): StorySegment[] {
  const segments = [...initial]
  while (segments.length > maxStages) {
    let selected = 0
    let selectedScore = Number.POSITIVE_INFINITY
    for (let index = 0; index < segments.length - 1; index++) {
      const score = mergeScore(segments[index]!, segments[index + 1]!)
      if (score < selectedScore) {
        selected = index
        selectedScore = score
      }
    }
    segments.splice(
      selected,
      2,
      mergeSegments(segments[selected]!, segments[selected + 1]!),
    )
  }
  return segments
}

function aggregateUsage(steps: readonly AnalysisStep[]): TokenUsage | undefined {
  const result: TokenUsage = {}
  for (const step of steps) {
    if (step.usage === undefined) continue
    for (const key of Object.keys(step.usage) as Array<keyof TokenUsage>) {
      const value = step.usage[key]
      if (value !== undefined) result[key] = (result[key] ?? 0) + value
    }
  }
  if (result.totalTokens === undefined
    && (result.inputTokens !== undefined || result.outputTokens !== undefined)) {
    result.totalTokens = (result.inputTokens ?? 0) + (result.outputTokens ?? 0)
  }
  return Object.keys(result).length === 0 ? undefined : result
}

function evidenceLevel(steps: readonly AnalysisStep[]): AnalysisEvidenceLevel {
  if (steps.some(step => step.reasonLevel === 'unknown')) return 'unknown'
  if (steps.some(step => step.reasonLevel === 'inferred')) return 'inferred'
  return 'fact'
}

function cleanStoryText(value: string, maxLength = 180): string {
  const normalized = value
    .replace(/\s+/g, ' ')
    .replace(/^模型判断[:：]\s*/, '')
    .trim()
  const clauses = normalized
    .split(/(?<=[。！？；])\s*|\n+/u)
    .map(clause => clause.trim())
    .filter(Boolean)
    .filter(clause => !/(?:原因|根因)(?:是|为)[:：]?[。；]/u.test(clause))
    .filter(clause => !/^\d+[.、]\s*/u.test(clause))
  const selected = clauses[0] ?? normalized
  return selected.length <= maxLength
    ? selected
    : `${selected.slice(0, maxLength - 1).trimEnd()}…`
}

function inferredJudgment(value: string): string {
  const objective = value.match(/推断本步骤目的是[“"](.+?)[”"]/u)?.[1]
  return objective === undefined
    ? cleanStoryText(value)
    : `根据实际动作判断，需要${cleanStoryText(objective, 100)}`
}

function stageJudgment(
  steps: readonly AnalysisStep[],
  corrections: readonly AnalysisCorrection[],
): string {
  const diagnosis = [...corrections]
    .reverse()
    .map(correction => cleanStoryText(correction.diagnosis))
    .find(value => value !== '')
  if (diagnosis !== undefined) return diagnosis
  const factual = steps.find(step => step.reasonLevel === 'fact')?.reason
  if (factual !== undefined) return cleanStoryText(factual)
  const inferred = steps.find(step => step.reasonLevel === 'inferred')?.reason
  if (inferred !== undefined) return inferredJudgment(inferred)
  return cleanStoryText(steps[0]?.reason ?? '来源未记录模型判断')
}

function stageActions(steps: readonly AnalysisStep[]): string[] {
  const actions = new Set<string>()
  for (const step of steps) {
    const action = cleanStoryText(step.action, 100)
    if (action !== '') actions.add(action)
  }
  const entries = [...actions]
  if (entries.length <= 3) return entries
  return [...entries.slice(0, 3), `另有 ${entries.length - 3} 类行动`]
}

function stageOutcome(
  steps: readonly AnalysisStep[],
  corrections: readonly AnalysisCorrection[],
): string {
  const verified = [...steps].reverse().find(step =>
    step.status === 'complete'
    && VALIDATION_PATTERN.test(`${step.action} ${step.execution}`)
    && /通过|成功|完成|无错误/u.test(step.result))
  if (verified !== undefined) return cleanStoryText(verified.result, 200)
  const recovered = [...corrections].reverse()
    .find(correction => correction.status === 'recovered')
  if (recovered !== undefined) return cleanStoryText(recovered.result, 200)
  const completed = [...steps].reverse().find(step =>
    step.status === 'complete' && step.result.trim() !== '')
  if (completed !== undefined) return cleanStoryText(completed.result, 200)
  return cleanStoryText(steps.at(-1)?.result ?? '阶段尚未形成结果', 200)
}

function overlaps(
  correction: AnalysisCorrection,
  steps: readonly AnalysisStep[],
  recordIds: ReadonlySet<string>,
): boolean {
  if (correction.recordIds.some(recordId => recordIds.has(recordId))) return true
  const locations = [
    correction.locations.trigger,
    correction.locations.diagnosis,
    correction.locations.change,
    correction.locations.result,
  ].filter(location => location !== undefined)
  return locations.some(location =>
    steps.some(step => step.turn === location.turn && step.step === location.step))
}

function stageFrom(
  segment: StorySegment,
  corrections: readonly AnalysisCorrection[],
): TrajectoryStoryStage {
  const steps = segment.steps
  const first = steps[0]!
  const last = steps.at(-1)!
  const recordIds = [...new Set(steps.flatMap(step => step.recordIds))]
  const recordIdSet = new Set(recordIds)
  const stageCorrections = corrections.filter(correction =>
    overlaps(correction, steps, recordIdSet))
  const durations = steps
    .map(step => step.durationMs)
    .filter((duration): duration is number => duration !== null)
  const turns = [...new Set(steps.map(step => step.turn))]
  const rationale = steps.find(step => step.reasonLevel === 'fact')?.reason
    ?? steps.find(step => step.reasonLevel === 'inferred')?.reason
    ?? first.reason
  return {
    id: `story:${first.id}:${last.id}`,
    phase: dominantPhase(segment.phaseCounts),
    title: phaseTitle(segment.phaseCounts),
    summary: stageOutcome(steps, stageCorrections),
    rationale,
    judgment: stageJudgment(steps, stageCorrections),
    actions: stageActions(steps),
    outcome: stageOutcome(steps, stageCorrections),
    rationaleLevel: evidenceLevel(steps),
    turnStart: turns[0]!,
    turnEnd: turns.at(-1)!,
    turns,
    stepIds: steps.map(step => step.id),
    recordIds,
    stepCount: steps.length,
    errorCount: errorCount(segment),
    recoveredCount: stageCorrections.filter(correction =>
      correction.status === 'recovered').length,
    durationMs: durations.length === 0
      ? null
      : durations.reduce((total, duration) => total + duration, 0),
    usage: aggregateUsage(steps),
  }
}

export function buildTrajectoryStory(
  analysis: TrajectoryAnalysis,
  maxStages = 8,
): TrajectoryStory {
  const limit = Math.max(1, Math.floor(maxStages))
  const ordered = [...analysis.steps].sort((left, right) =>
    left.turn - right.turn
    || left.step - right.step
    || left.id.localeCompare(right.id))
  const stages = compactSegments(foldRecoverySegments(baseSegments(ordered)), limit)
    .map(segment => stageFrom(segment, analysis.corrections))
  return {
    stages,
    stageIdByStepId: Object.fromEntries(stages.flatMap(stage =>
      stage.stepIds.map(stepId => [stepId, stage.id]))),
  }
}
