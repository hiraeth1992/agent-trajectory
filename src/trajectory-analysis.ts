import type {
  RecordKind,
  RecordStatus,
  SessionDetail,
  TokenUsage,
  TrajectoryRecord,
} from './types'
import { objectiveFrom } from './objective-synthesis'
import { tokenTotal } from './token-usage'
import { buildTimelineGeometry } from './trajectory-view-model'
import {
  analyzeTrajectoryOptimizations,
  type OptimizationSuggestion,
} from './trajectory-optimization'
import {
  classifyCommand,
  toolCommand,
  validationSemantics,
} from './tool-semantics'

export type AnalysisEvidenceLevel = 'fact' | 'inferred' | 'unknown'
export type AnalysisConfidence = 'high' | 'medium' | 'low'
export type AnalysisTone = 'positive' | 'warning' | 'negative' | 'neutral'

export interface AnalysisStep {
  id: string
  recordId: string
  recordIds: string[]
  turn: number
  step: number
  kind: RecordKind
  action: string
  detail: string
  reason: string
  reasonLevel: AnalysisEvidenceLevel
  execution: string
  result: string
  status: RecordStatus
  durationMs: number | null
  usage?: TokenUsage
}

export interface AnalysisCorrection {
  id: string
  title: string
  summary: string
  trigger: string
  diagnosis: string
  change: string
  result: string
  locations: {
    trigger?: AnalysisLocation
    diagnosis?: AnalysisLocation
    change?: AnalysisLocation
    result?: AnalysisLocation
  }
  status: 'recovered' | 'unresolved' | 'redirected'
  confidence: AnalysisConfidence
  recordIds: string[]
}

export interface AnalysisLocation {
  turn: number
  step: number
}

export interface AnalysisEvaluation {
  id: 'outcome' | 'reliability' | 'recovery' | 'efficiency' | 'observability'
  title: string
  grade: 'good' | 'warning' | 'bad' | 'unknown'
  label: string
  summary: string
  confidence: AnalysisConfidence
  evidenceRecordIds: string[]
}

export interface TrajectoryAnalysis {
  objective: string
  objectiveLabel: '当前执行目标' | '会话目标'
  outcome: {
    label: string
    summary: string
    tone: AnalysisTone
    confidence: AnalysisConfidence
    evidenceRecordIds: string[]
  }
  stats: {
    durationMs: number | null
    turns: number
    steps: number
    errors: number
    retries: number
    recovered: number
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    totalTokens?: number
    allocatedTokens?: number
    unallocatedTokens?: number
    overallocatedTokens?: number
    tokenAllocationCoverage?: number
  }
  steps: AnalysisStep[]
  costSteps: AnalysisStep[]
  corrections: AnalysisCorrection[]
  evaluations: AnalysisEvaluation[]
  optimizations?: OptimizationSuggestion[]
}

function compact(value: string, length = 180): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= length) return normalized
  return `${normalized.slice(0, Math.max(0, length - 1)).trimEnd()}…`
}

function contentText(value: unknown, requestedType?: string): string {
  if (typeof value === 'string') return requestedType === undefined ? value : ''
  if (!Array.isArray(value)) return ''
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    const block = entry as Record<string, unknown>
    const type = typeof block.type === 'string' ? block.type : undefined
    if (requestedType !== undefined && type !== requestedType) return []
    return typeof block.text === 'string' ? [block.text] : []
  }).join('\n')
}

function visibleText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(visibleText).filter(Boolean).join('\n')
  if (value === null || typeof value !== 'object') return ''
  const source = value as Record<string, unknown>
  return [
    source.text,
    source.output,
    source.stdout,
    source.stderr,
    source.preview,
    source.result,
    source.content,
  ].map(visibleText).filter(Boolean).join('\n')
}

function cleanText(value: string): string {
  return value
    .replace(/[`*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function firstClause(value: string, length = 120): string {
  const cleaned = cleanText(value)
  const clause = cleaned.split(/(?<=[。！？!?])\s+|\n+/)[0] ?? cleaned
  return compact(clause, length)
}

function containsChinese(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value)
}

function commandFrom(record: TrajectoryRecord): string {
  return toolCommand(record)
}

function patchText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(patchText).filter(Boolean).join('\n')
  if (value === null || typeof value !== 'object') return ''
  const source = value as Record<string, unknown>
  if (typeof source.preview === 'string') return source.preview
  return [source.patch, source.diff, source.content, source.changes]
    .map(patchText)
    .filter(Boolean)
    .join('\n')
}

function structuredPatchPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(structuredPatchPaths)
  if (value === null || typeof value !== 'object') return []
  const source = value as Record<string, unknown>
  const direct = [source.path, source.file, source.filename]
    .filter((entry): entry is string => typeof entry === 'string')
  return [
    ...direct,
    ...Object.values(source).flatMap(structuredPatchPaths),
  ]
}

function validPatchPath(value: string): string | undefined {
  const normalized = value
    .trim()
    .replace(/^["']|["',}\]]+$/g, '')
  if (normalized === ''
    || normalized.length > 320
    || /[{}<>]/.test(normalized)
    || normalized.includes('***')) return undefined
  const basename = normalized.replaceAll('\\', '/').split('/').at(-1)
  return basename === undefined || basename === '' ? undefined : basename
}

function patchPaths(record: TrajectoryRecord): string[] {
  const text = patchText(record.input)
  const marked = [...text.matchAll(
    /\*\*\* (?:Add|Update|Delete) File: (.*?)(?=\r?\n|\\n|\*\*\*|$)/g,
  )].flatMap((match) => {
    const path = validPatchPath(match[1]!)
    return path === undefined ? [] : [path]
  })
  const structured = structuredPatchPaths(record.input).flatMap((value) => {
    const path = validPatchPath(value)
    return path === undefined ? [] : [path]
  })
  return [...new Set([...marked, ...structured])]
}

function commandPurpose(command: string): string {
  const purpose = classifyCommand(command)
  if (purpose === 'dev-server') return '启动开发服务'
  if (purpose === 'test') return '运行测试'
  if (purpose === 'build') return '构建项目'
  if (purpose === 'typecheck') return '执行类型检查'
  if (purpose === 'check') return '执行检查'
  if (purpose === 'diff') return '检查代码变更'
  if (purpose === 'search') return '搜索相关代码和文件'
  if (purpose === 'read') return '读取相关文件内容'
  if (purpose === 'request') return '请求并检查接口数据'
  return command === '' ? '执行命令' : `执行命令 ${compact(command, 72)}`
}

function toolAction(record: TrajectoryRecord): string {
  if (record.title === 'exec_command' || record.title === 'write_stdin') {
    return commandPurpose(commandFrom(record))
  }
  if (record.title === 'apply_patch') {
    const paths = patchPaths(record)
    return paths.length === 0
      ? '修改代码实现'
      : `修改 ${paths.slice(0, 3).join('、')}${paths.length > 3 ? ` 等 ${paths.length} 个文件` : ''}`
  }
  if (record.title === 'js' || record.title.endsWith('.js')) return '通过脚本检查页面或数据'
  return `调用 ${record.title}`
}

function toolExecution(record: TrajectoryRecord): string {
  if (record.title === 'apply_patch') return toolAction(record)
  const command = commandFrom(record)
  if (command !== '') return `${commandPurpose(command)}：${compact(command, 110)}`
  const input = visibleText(record.input)
  return input === ''
    ? `调用 ${record.title}`
    : `调用 ${record.title}，参数摘要：${compact(input, 100)}`
}

function failureReason(record: TrajectoryRecord): string {
  const code = record.error?.code
  const normalizedCode = code === undefined
    ? undefined
    : /^-?\d+$/.test(code) ? `退出码 ${code}` : code
  return compact(
    record.error?.reason
      ?? normalizedCode
      ?? record.retry?.message
      ?? (record.status === 'interrupted' ? '执行被中断' : '执行失败'),
    150,
  )
}

function testResult(text: string): string | undefined {
  const files = text.match(/Test Files\s+(\d+)\s+passed/i)?.[1]
  const tests = text.match(/Tests\s+(\d+)\s+passed/i)?.[1]
  if (files !== undefined || tests !== undefined) {
    return `测试通过${files === undefined ? '' : `：${files} 个测试文件`}${
      tests === undefined ? '' : `、${tests} 项测试`
    }全部通过`
  }
  const generic = text.match(/(\d+)\s+(?:tests?|项测试).*passed/i)?.[1]
  return generic === undefined ? undefined : `测试通过：${generic} 项全部通过`
}

function toolResult(record: TrajectoryRecord): string {
  const action = toolAction(record)
  const validation = validationSemantics(record)
  if (validation?.outcome === 'failed') {
    return `${action}失败：${validation.summary ?? '验证未通过'}`
  }
  if (record.status === 'error' || record.status === 'interrupted') {
    return `${action}失败：${failureReason(record)}`
  }
  const output = cleanText(visibleText(record.output))
  const tested = validation?.summary ?? testResult(output)
  if (tested !== undefined) return tested
  if (/built in|build (?:completed|succeeded)|构建成功/i.test(output)) return '项目构建成功'
  if (/tsc --noemit|typecheck/i.test(commandFrom(record)) && record.status === 'complete') {
    return '类型检查通过'
  }
  if (record.title === 'apply_patch') return `${toolAction(record)}成功`
  const purpose = commandPurpose(commandFrom(record))
  if (purpose === '读取相关文件内容') return '已读取相关文件，内容可用于后续判断'
  if (purpose === '搜索相关代码和文件') return '搜索完成，已获得相关代码位置'
  if (purpose === '检查代码变更') return '已获得当前代码变更与工作区状态'
  if (purpose === '请求并检查接口数据') return '接口请求成功并返回数据'
  if (output !== '' && containsChinese(output)) return firstClause(output, 140)
  return `${action}成功，结果已记录`
}

function isActionRecord(record: TrajectoryRecord): boolean {
  return record.kind === 'steering'
    || record.kind === 'assistant'
    || record.kind === 'model'
    || record.kind === 'tool'
    || record.kind === 'subtool'
    || record.kind === 'compaction'
}

function sortedActions(detail: SessionDetail): TrajectoryRecord[] {
  return detail.projection.records
    .filter(isActionRecord)
    .sort((left, right) =>
      left.turn - right.turn
      || left.step - right.step
      || left.seq - right.seq
      || left.startTime - right.startTime
      || left.id.localeCompare(right.id))
}

interface LogicalStepGroup {
  id: string
  turn: number
  step: number
  records: TrajectoryRecord[]
}

function groupActions(actions: readonly TrajectoryRecord[]): LogicalStepGroup[] {
  const groups = new Map<string, LogicalStepGroup>()
  for (const record of actions) {
    const key = record.step > 0
      ? `${record.turn}:${record.step}`
      : `${record.turn}:${record.step}:${record.id}`
    const group = groups.get(key) ?? {
      id: `step:${key}`,
      turn: record.turn,
      step: record.step,
      records: [],
    }
    group.records.push(record)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function stepStatus(records: readonly TrajectoryRecord[]): RecordStatus {
  if (records.some(record => record.status === 'running')) return 'running'
  if (records.some(record => record.status === 'error')) return 'error'
  if (records.some(record => record.status === 'interrupted')) return 'interrupted'
  return 'complete'
}

function aggregateUsage(records: readonly TrajectoryRecord[]): TokenUsage | undefined {
  const modelUsage = records.filter(record => record.kind === 'model' && record.usage !== undefined)
  const candidates = modelUsage.length > 0
    ? modelUsage
    : records.filter(record => record.usage !== undefined)
  if (candidates.length === 0) return undefined
  const total: TokenUsage = {}
  for (const record of candidates) {
    const usage = record.usage!
    for (const key of Object.keys(usage) as Array<keyof TokenUsage>) {
      const value = usage[key]
      if (value !== undefined) total[key] = (total[key] ?? 0) + value
    }
  }
  return total
}

function groupDuration(records: readonly TrajectoryRecord[]): number | null {
  const geometry = buildTimelineGeometry(records, true)
  return geometry.mode === 'duration' ? geometry.durationMs : null
}

function reasoningSummary(records: readonly TrajectoryRecord[], action: string): {
  text: string
  level: AnalysisEvidenceLevel
} {
  const reasoning = records.find(record => record.title === '推理')
  const raw = reasoning === undefined
    ? ''
    : contentText(reasoning.output, 'reasoning')
      || contentText(reasoning.output)
      || reasoning.summary
  if (raw !== '') {
    const clause = firstClause(raw, 160)
    if (containsChinese(clause)) return { text: clause, level: 'fact' }
    const normalized = raw.toLowerCase()
    if (/diagnos|debug|fail|error|regression/.test(normalized)) {
      return { text: '模型先分析失败原因和复现证据，再决定修正方式', level: 'fact' }
    }
    if (/test|verify|validation|check/.test(normalized)) {
      return { text: '模型决定先执行验证，根据结果判断是否需要继续修改', level: 'fact' }
    }
    if (/implement|patch|edit|modify|refactor/.test(normalized)) {
      return { text: '模型根据已确认方案修改实现，并准备随后验证', level: 'fact' }
    }
    if (/inspect|read|search|explor/.test(normalized)) {
      return { text: '模型决定先检查现有代码、数据和约束，再确定后续操作', level: 'fact' }
    }
    if (/plan|design|approach/.test(normalized)) {
      return { text: '模型先梳理目标、约束和实现范围，再制定执行方案', level: 'fact' }
    }
    return { text: `模型围绕“${action}”进行了分析并形成执行依据`, level: 'fact' }
  }
  return {
    text: `来源未记录独立思考；根据实际动作推断本步骤目的是“${action}”`,
    level: 'inferred',
  }
}

function summarizeChineseConclusion(value: string): string {
  const cleaned = cleanText(value)
  const tested = testResult(cleaned)
  if (tested !== undefined) return tested
  if (/类型检查.{0,12}(?:通过|成功)/.test(cleaned)) return '确认类型检查通过'
  if (/(?:生产|项目|Web|桌面).{0,12}构建.{0,12}(?:通过|成功)/i.test(cleaned)) {
    return '确认项目构建通过'
  }
  const cause = cleaned.match(/(?:失败)?原因(?:是|为|：)?(.{8,100}?)(?=。|；|，并|$)/)?.[1]
  if (cause !== undefined) return `确认失败原因是${compact(cause, 100)}`
  const rootCause = cleaned.match(/根因(?:是|为|：)?(.{8,100}?)(?=。|；|，并|$)/)?.[1]
  if (rootCause !== undefined) return `确认根因是${compact(rootCause, 100)}`
  if (/测试.{0,30}失败/.test(cleaned)) {
    return '确认测试失败，并根据失败信息制定后续修正方案'
  }
  if (/测试.{0,30}(?:通过|成功)/.test(cleaned)) return '确认测试通过'
  if (/修复|修正|修改/.test(cleaned) && /验证|测试/.test(cleaned)) {
    return '完成实现调整，并准备通过测试或构建验证结果'
  }
  const decision = cleaned.match(/(?:决定|我会|下一步)(.{8,100}?)(?=。|；|$)/)?.[1]
  if (decision !== undefined) return `决定${compact(decision, 100)}`
  return firstClause(cleaned, 100)
}

function assistantConclusion(records: readonly TrajectoryRecord[]): string | undefined {
  const candidates = records.filter(record =>
    record.kind === 'assistant'
    && record.title !== '推理')
  for (const record of candidates.reverse()) {
    const text = contentText(record.output) || record.summary
    if (text !== '' && containsChinese(text)) return summarizeChineseConclusion(text)
  }
  return undefined
}

function stepAction(records: readonly TrajectoryRecord[]): string {
  const tools = records.filter(record => record.kind === 'tool' || record.kind === 'subtool')
  if (tools.some(validationRecord)) return '运行测试或构建验证'
  const patches = tools.filter(record => record.title === 'apply_patch')
  if (patches.length > 0) {
    const paths = [...new Set(patches.flatMap(patchPaths))]
    return paths.length === 0
      ? '修改代码实现'
      : `修改 ${paths.slice(0, 3).join('、')}${paths.length > 3 ? ` 等 ${paths.length} 个文件` : ''}`
  }
  if (tools.length > 0) {
    const actions = [...new Set(tools.map(toolAction))]
    return actions.length === 1
      ? actions[0]!
      : `${actions.slice(0, 2).join('并')}等 ${tools.length} 项操作`
  }
  const conclusion = assistantConclusion(records)
  if (conclusion !== undefined) {
    if (/完成|通过|结果|验证/.test(conclusion)) return '汇报执行结果'
    return '向用户说明执行情况'
  }
  if (records.some(record => record.title === '推理')) return '分析下一步方案'
  if (records.some(record => record.kind === 'compaction')) return '压缩模型上下文'
  return '完成模型响应'
}

function stepExecution(records: readonly TrajectoryRecord[]): string {
  const tools = records.filter(record => record.kind === 'tool' || record.kind === 'subtool')
  if (tools.length === 0) {
    const conclusion = assistantConclusion(records)
    return conclusion === undefined
      ? '本步骤未调用工具，由模型直接形成响应'
      : `未调用工具；模型向用户说明：${conclusion}`
  }
  const descriptions = tools.map(toolExecution)
  return descriptions.length <= 3
    ? descriptions.join('；')
    : `${descriptions.slice(0, 3).join('；')}；另有 ${descriptions.length - 3} 个工具调用`
}

function stepResult(records: readonly TrajectoryRecord[]): string {
  const tools = records.filter(record => record.kind === 'tool' || record.kind === 'subtool')
  const failed = tools.filter(record =>
    record.status === 'error' || record.status === 'interrupted')
  if (failed.length > 0) {
    const successful = tools.filter(record => record.status === 'complete')
    return compact([
      ...failed.map(toolResult),
      ...successful.map(record => `随后${toolResult(record)}`),
    ].join('；'), 320)
  }
  if (tools.length > 0) {
    const results = [...new Set(tools.map(toolResult))]
    const conclusion = assistantConclusion(records)
    const hasSpecificResult = results.some(result =>
      /测试通过|构建成功|类型检查通过|失败/.test(result))
    const hasInformativeToolResult = results.some(result =>
      /测试通过|构建成功|类型检查通过|失败|已读取|搜索完成|接口请求成功|已获得/.test(result))
    return compact([
      ...results.slice(0, 3),
      ...(results.length > 3 ? [`另有 ${results.length - 3} 项调用成功`] : []),
      ...(conclusion === undefined || hasSpecificResult || hasInformativeToolResult
        ? []
        : [`模型结论：${conclusion}`]),
    ].join('；'), 320)
  }
  const conclusion = assistantConclusion(records)
  if (conclusion !== undefined) return `模型结论：${conclusion}`
  const reasoning = records.find(record => record.title === '推理')
  return reasoning === undefined
    ? '步骤已完成，来源未记录可展示的结果摘要'
    : `形成下一步判断：${reasoningSummary(records, '分析下一步方案').text}`
}

function representativeRecord(records: readonly TrajectoryRecord[]): TrajectoryRecord {
  return records.find(record =>
    record.status === 'error' || record.status === 'interrupted')
    ?? records.find(record => record.kind === 'tool' || record.kind === 'subtool')
    ?? records.find(record => record.title === '推理')
    ?? records.find(record => record.kind !== 'model')
    ?? records[0]!
}

function buildSteps(groups: readonly LogicalStepGroup[]): AnalysisStep[] {
  return groups.map((group): AnalysisStep => {
    const representative = representativeRecord(group.records)
    const action = stepAction(group.records)
    const reason = reasoningSummary(group.records, action)
    const execution = stepExecution(group.records)
    return {
      id: group.id,
      recordId: representative.id,
      recordIds: group.records.map(record => record.id),
      turn: group.turn,
      step: group.step,
      kind: representative.kind,
      action,
      detail: execution,
      reason: reason.text,
      reasonLevel: reason.level,
      execution,
      result: stepResult(group.records),
      status: stepStatus(group.records),
      durationMs: groupDuration(group.records),
      usage: aggregateUsage(group.records),
    }
  })
}

function usageMagnitude(usage: TokenUsage | undefined): number {
  return tokenTotal(usage)
}

function validationRecord(record: TrajectoryRecord): boolean {
  return validationSemantics(record) !== undefined
}

function editRecord(record: TrajectoryRecord): boolean {
  return /^(?:apply_patch|edit_file|write_file|replace_in_file|multiedit|edit|write)$/i
    .test(record.title)
}

function completedAnswerAfterInterruptedTurn(
  detail: SessionDetail,
): TrajectoryRecord | undefined {
  const latestTurn = detail.projection.turns
    .slice()
    .sort((left, right) => left.number - right.number)
    .at(-1)
  if (latestTurn?.status !== 'complete') return undefined
  const interruptedTurnNumbers = detail.projection.turns
    .filter(turn => turn.status === 'interrupted' && turn.number < latestTurn.number)
    .map(turn => turn.number)
  if (interruptedTurnNumbers.length === 0) return undefined
  const latestInterruptedTurn = Math.max(...interruptedTurnNumbers)
  const hasFollowUpInput = detail.projection.records.some(record =>
    record.kind === 'user'
    && record.turn > latestInterruptedTurn
    && record.turn <= latestTurn.number)
  if (!hasFollowUpInput) return undefined
  return detail.projection.records
    .filter(record =>
      record.kind === 'assistant'
      && record.title !== '推理'
      && record.turn === latestTurn.number
      && record.status === 'complete'
      && cleanText(visibleText(record.output)) !== '')
    .sort((left, right) =>
      left.step - right.step
      || left.seq - right.seq
      || left.startTime - right.startTime)
    .at(-1)
}

function causedByInterruptedExit130(
  detail: SessionDetail,
  actions: readonly TrajectoryRecord[],
  correction: AnalysisCorrection,
  completedAnswer: TrajectoryRecord | undefined,
): boolean {
  if (completedAnswer === undefined) return false
  const trigger = correction.locations.trigger
  if (trigger === undefined || trigger.turn >= completedAnswer.turn) return false
  const interruptedTurn = detail.projection.turns.find(turn =>
    turn.number === trigger.turn && turn.status === 'interrupted')
  if (interruptedTurn === undefined) return false
  return actions.some(record =>
    record.turn === trigger.turn
    && record.step === trigger.step
    && (record.status === 'error' || record.status === 'interrupted')
    && String(record.error?.code ?? '') === '130')
}

function adjustmentSummary(step: AnalysisStep): string {
  return step.execution === step.action
    ? step.action
    : `${step.action}；${step.execution}`
}

function recordLocation(record: TrajectoryRecord | undefined): AnalysisLocation | undefined {
  return record === undefined ? undefined : { turn: record.turn, step: record.step }
}

function stepLocation(step: AnalysisStep | undefined): AnalysisLocation | undefined {
  return step === undefined ? undefined : { turn: step.turn, step: step.step }
}

function correctionSegment(value: string, maxLength = 68): string {
  return compact(value
    .replace(/执行命令\s+.*?失败[:：]/u, '执行命令失败：')
    .replace(/执行命令\s+.*?成功/u, '执行命令成功')
    .replace(/；执行命令[:：].*$/u, '')
    .replace(/；调用\s+\S+/u, '')
    .replace(/；模型结论[:：].*?(?=；后续验证[:：]|$)/u, '')
    .replace(/；后续验证[:：]/u, '；验证：'), maxLength)
}

function correctionSummary(
  trigger: string,
  change: string,
  result: string,
): string {
  return [
    correctionSegment(trigger, 54),
    correctionSegment(change, 54),
    correctionSegment(result, 72),
  ].join(' → ')
}

function buildCorrections(
  groups: readonly LogicalStepGroup[],
  steps: readonly AnalysisStep[],
): AnalysisCorrection[] {
  const corrections: AnalysisCorrection[] = []
  steps.forEach((step, index) => {
    const group = groups[index]!
    const steering = group.records.find(record => record.kind === 'steering')
    const next = steps[index + 1]
    if (steering !== undefined) {
      const trigger = `用户调整要求：${compact(steering.summary, 160)}`
      const diagnosis = next === undefined
        ? '尚未观察到模型对新要求的后续判断'
        : `模型根据新要求决定：${next.reason}`
      const change = next === undefined
        ? '等待后续行动'
        : adjustmentSummary(next)
      const result = next === undefined ? '尚未观察到后续结果' : next.result
      corrections.push({
        id: `steering:${step.id}`,
        title: '根据用户引导改道',
        summary: correctionSummary(trigger, change, result),
        trigger,
        diagnosis,
        change,
        result,
        locations: {
          trigger: recordLocation(steering),
          diagnosis: stepLocation(next),
          change: stepLocation(next),
          result: stepLocation(next),
        },
        status: 'redirected',
        confidence: 'high',
        recordIds: [steering.id, ...(next?.recordIds ?? [])],
      })
      return
    }
    const exceptionalRecords = group.records.filter(record =>
      record.status === 'error'
      || record.status === 'interrupted'
      || record.retry !== undefined)
    const exceptional = exceptionalRecords.length > 0
    if (!exceptional) return
    const failedRecord = exceptionalRecords[0]!
    const failedIndex = group.records.indexOf(failedRecord)
    const sameStepRecovery = group.records.slice(failedIndex + 1).find(record =>
      (record.kind === 'tool' || record.kind === 'subtool')
      && record.status === 'complete')
    const recoveredInPlace = failedRecord.retry !== undefined && failedRecord.status === 'complete'
    const recovered = recoveredInPlace
      || sameStepRecovery !== undefined
      || next?.status === 'complete'
    const laterValidation = steps.slice(index + 1).find((candidate, offset) => {
      const candidateGroup = groups[index + 1 + offset]
      return candidateGroup?.records.some(validationRecord)
        && candidate.status === 'complete'
    })
    const diagnosis = next?.reasonLevel === 'fact'
      ? `模型判断：${next.reason}`
      : next === undefined
        ? '来源未记录失败后的模型判断'
        : `来源未记录独立失败分析；根据后续动作推断模型决定“${next.action}”`
    const trigger = `${step.action}失败：${failureReason(failedRecord)}`
    const change = recoveredInPlace
      ? `重试 ${failedRecord.retry!.count} 次；${step.execution}`
      : sameStepRecovery !== undefined
        ? `在同一步内改为${toolExecution(sameStepRecovery)}`
      : next === undefined
        ? '轨迹中尚未出现替代方案'
        : adjustmentSummary(next)
    const result = recoveredInPlace
      ? step.result
      : sameStepRecovery !== undefined
        ? toolResult(sameStepRecovery)
      : next === undefined
        ? '仍需处理'
        : `${next.result}${
          laterValidation === undefined || laterValidation.id === next.id
            ? ''
            : `；后续验证：${laterValidation.result}`
        }`
    corrections.push({
      id: `recovery:${step.id}`,
      title: recovered ? '异常后恢复执行' : '异常尚未恢复',
      summary: correctionSummary(trigger, change, result),
      trigger,
      diagnosis,
      change,
      result,
      locations: {
        trigger: recordLocation(failedRecord),
        diagnosis: stepLocation(next) ?? stepLocation(step),
        change: recoveredInPlace
          ? recordLocation(failedRecord)
          : sameStepRecovery !== undefined
            ? recordLocation(sameStepRecovery)
            : stepLocation(next),
        result: laterValidation === undefined
          ? recoveredInPlace
            ? stepLocation(step)
            : sameStepRecovery !== undefined
              ? recordLocation(sameStepRecovery)
              : stepLocation(next)
          : stepLocation(laterValidation),
      },
      status: recovered ? 'recovered' : 'unresolved',
      confidence: recoveredInPlace || sameStepRecovery !== undefined
        ? 'high'
        : next === undefined ? 'high' : 'medium',
      recordIds: [...new Set([
        ...step.recordIds,
        ...(sameStepRecovery === undefined ? [] : [sameStepRecovery.id]),
        ...(next?.recordIds ?? []),
        ...(laterValidation?.recordIds ?? []),
      ])],
    })
  })
  return corrections
}

function analysisStats(
  detail: SessionDetail,
  steps: readonly AnalysisStep[],
  corrections: readonly AnalysisCorrection[],
): TrajectoryAnalysis['stats'] {
  const usage = detail.projection.usage
  const geometry = buildTimelineGeometry(detail.projection.records, true)
  const totalTokens = usage?.totalTokens
    ?? (usage === undefined
      ? undefined
      : (usage.inputTokens ?? 0)
        + (usage.outputTokens ?? 0))
  const allocatedTokens = steps.reduce(
    (total, step) => total + usageMagnitude(step.usage),
    0,
  )
  return {
    durationMs: geometry.mode === 'duration' ? geometry.durationMs : null,
    turns: detail.projection.turns.length,
    steps: steps.length,
    errors: detail.projection.records.filter(record =>
      record.status === 'error' || record.status === 'interrupted').length,
    retries: detail.projection.records.reduce(
      (total, record) => total + (record.retry?.count ?? 0),
      0,
    ),
    recovered: corrections.filter(correction => correction.status === 'recovered').length,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    reasoningTokens: usage?.reasoningTokens,
    cacheReadTokens: usage?.cacheReadTokens,
    cacheWriteTokens: usage?.cacheWriteTokens,
    totalTokens,
    allocatedTokens: totalTokens === undefined ? undefined : allocatedTokens,
    unallocatedTokens: totalTokens === undefined
      ? undefined
      : Math.max(0, totalTokens - allocatedTokens),
    overallocatedTokens: totalTokens === undefined
      ? undefined
      : Math.max(0, allocatedTokens - totalTokens),
    tokenAllocationCoverage: totalTokens === undefined || totalTokens <= 0
      ? undefined
      : Math.min(1, allocatedTokens / totalTokens),
  }
}

function outcomeEvaluation(
  detail: SessionDetail,
  actions: readonly TrajectoryRecord[],
  corrections: readonly AnalysisCorrection[],
): {
  outcome: TrajectoryAnalysis['outcome']
  evaluation: AnalysisEvaluation
} {
  const validations = actions.filter(validationRecord)
  const latestValidation = validations.at(-1)
  const latestEdit = actions.filter(editRecord).at(-1)
  const effectiveValidation = latestValidation !== undefined
    && (latestEdit === undefined
      || actions.indexOf(latestValidation) > actions.indexOf(latestEdit))
    ? latestValidation
    : undefined
  const effectiveValidationSemantics = effectiveValidation === undefined
    ? undefined
    : validationSemantics(effectiveValidation)
  const unresolved = corrections.filter(correction => correction.status === 'unresolved')
  const completedAnswer = completedAnswerAfterInterruptedTurn(detail)
  const blockingUnresolved = unresolved.filter(correction =>
    !causedByInterruptedExit130(detail, actions, correction, completedAnswer))
  const targetStatus = detail.projection.taskState?.target?.status
  const normalizedTargetStatus = targetStatus?.toLowerCase()
  const targetPartiallyComplete = normalizedTargetStatus !== undefined
    && /partial|部分/u.test(normalizedTargetStatus)
  const targetExplicitlyIncomplete = targetPartiallyComplete
    || normalizedTargetStatus === 'active'
    || normalizedTargetStatus === 'paused'
  const incompleteTodos = detail.projection.taskState?.todos.filter(todo =>
    !new Set([
      'cancelled', 'canceled', 'complete', 'completed', 'done',
      'resolved', 'skipped', 'superseded',
    ]).has(todo.status.toLowerCase())) ?? []
  const running = detail.projection.turns.some(turn => turn.status === 'running')
    || actions.some(record => record.status === 'running')
  if (running) {
    return {
      outcome: {
        label: '执行中',
        summary: '会话仍在运行，当前评测只反映已落盘的轨迹。',
        tone: 'neutral',
        confidence: 'high',
        evidenceRecordIds: actions.filter(record => record.status === 'running').map(record => record.id),
      },
      evaluation: {
        id: 'outcome',
        title: '结果证据',
        grade: 'unknown',
        label: '尚未形成最终结果',
        summary: '等待会话完成后再判断结果状态。',
        confidence: 'high',
        evidenceRecordIds: [],
      },
    }
  }
  if (normalizedTargetStatus === 'blocked') {
    return {
      outcome: {
        label: '结果存在未解决问题',
        summary: '任务状态明确标记为 blocked。',
        tone: 'negative',
        confidence: 'high',
        evidenceRecordIds: [],
      },
      evaluation: {
        id: 'outcome',
        title: '结果证据',
        grade: 'bad',
        label: '任务受阻',
        summary: '任务状态明确标记为 blocked，不能判定任务完成。',
        confidence: 'high',
        evidenceRecordIds: [],
      },
    }
  }
  if (targetPartiallyComplete) {
    const evidence = effectiveValidation === undefined ? [] : [effectiveValidation.id]
    const validationBoundary = effectiveValidationSemantics?.outcome === 'failed'
      ? `最后一次验证“${effectiveValidation!.title}”仍失败`
      : effectiveValidationSemantics?.outcome === 'passed'
        ? `最后一次验证“${effectiveValidation!.title}”成功，但只覆盖其实际检查范围`
        : '缺少独立验证证明所有要求均已完成'
    return {
      outcome: {
        label: '部分修复，仍有未完成项',
        summary: `任务状态明确标记为部分完成；${validationBoundary}。`,
        tone: 'warning',
        confidence: 'high',
        evidenceRecordIds: evidence,
      },
      evaluation: {
        id: 'outcome',
        title: '结果证据',
        grade: 'warning',
        label: '部分通过',
        summary: '来源明确记录了部分完成状态，不能按整体成功或整体失败处理。',
        confidence: 'high',
        evidenceRecordIds: evidence,
      },
    }
  }
  if (effectiveValidationSemantics?.outcome === 'failed') {
    const evidence = [
      ...(effectiveValidationSemantics?.outcome === 'failed'
        && effectiveValidation !== undefined ? [effectiveValidation.id] : []),
    ]
    return {
      outcome: {
        label: '结果存在未解决问题',
        summary: effectiveValidationSemantics?.outcome === 'failed'
          && effectiveValidation !== undefined
          ? `最后一次验证“${effectiveValidation.title}”失败，轨迹中没有后续通过证据。`
          : '轨迹中存在失败或中断步骤，尚未观察到恢复证据。',
        tone: 'negative',
        confidence: 'high',
        evidenceRecordIds: evidence,
      },
      evaluation: {
        id: 'outcome',
        title: '结果证据',
        grade: 'bad',
        label: '验证未通过',
        summary: '存在明确失败证据，不能判定任务完成。',
        confidence: 'high',
        evidenceRecordIds: evidence,
      },
    }
  }
  if (effectiveValidationSemantics?.outcome === 'passed'
    && effectiveValidation !== undefined) {
    const validationIndex = actions.indexOf(effectiveValidation)
    const unresolvedAfterValidation = unresolved.filter((correction) => {
      const triggerIndices = correction.recordIds.flatMap((id) => {
        const index = actions.findIndex(record => record.id === id
          && (record.status === 'error' || record.status === 'interrupted'))
        return index < 0 ? [] : [index]
      })
      if (triggerIndices.length > 0) {
        return Math.min(...triggerIndices) > validationIndex
      }
      const trigger = correction.locations.trigger
      return trigger === undefined
        || trigger.turn > effectiveValidation.turn
        || trigger.turn === effectiveValidation.turn
          && trigger.step > effectiveValidation.step
    })
    if (targetExplicitlyIncomplete
      || incompleteTodos.length > 0
      || unresolvedAfterValidation.length > 0) {
      const explicitIncomplete = targetExplicitlyIncomplete || incompleteTodos.length > 0
      const evidence = [
        effectiveValidation.id,
        ...unresolvedAfterValidation.flatMap(correction => correction.recordIds),
      ]
      const boundaries = [
        ...(targetExplicitlyIncomplete
          ? [`任务状态仍为“${targetStatus}”`]
          : []),
        ...(incompleteTodos.length === 0
          ? []
          : [`任务状态仍有 ${incompleteTodos.length} 个未完成项`]),
        ...(unresolvedAfterValidation.length === 0
          ? []
          : [`验证后仍有 ${unresolvedAfterValidation.length} 个异常没有恢复证据`]),
      ]
      return {
        outcome: {
          label: '部分修复，仍有未完成项',
          summary: `最后一次验证“${effectiveValidation.title}”成功，但${
            boundaries.join('，')
          }；成功证据仅覆盖该验证实际检查的范围。`,
          tone: 'warning',
          confidence: explicitIncomplete ? 'high' : 'medium',
          evidenceRecordIds: [...new Set(evidence)],
        },
        evaluation: {
          id: 'outcome',
          title: '结果证据',
          grade: 'warning',
          label: '部分通过',
          summary: '已观察到成功验证，但仍有明确未完成项或验证后的未恢复异常。',
          confidence: explicitIncomplete ? 'high' : 'medium',
          evidenceRecordIds: [...new Set(evidence)],
        },
      }
    }
    return {
      outcome: {
        label: '已完成并有验证证据',
        summary: `最后一次验证“${effectiveValidation.title}”成功；结论仅覆盖该验证实际检查的范围。`,
        tone: 'positive',
        confidence: 'high',
        evidenceRecordIds: [effectiveValidation.id],
      },
      evaluation: {
        id: 'outcome',
        title: '结果证据',
        grade: 'good',
        label: '存在成功验证',
        summary: `观察到 ${validations.length} 个测试、构建或检查步骤，最后一次执行成功。`,
        confidence: 'high',
        evidenceRecordIds: validations.map(record => record.id),
      },
    }
  }
  if (blockingUnresolved.length > 0) {
    const evidence = blockingUnresolved.flatMap(correction => correction.recordIds)
    const confidence = blockingUnresolved.every(correction => correction.confidence === 'high')
      ? 'high'
      : 'medium'
    return {
      outcome: {
        label: '结果存在未解决问题',
        summary: '轨迹中存在失败或中断步骤，尚未观察到恢复证据。',
        tone: 'negative',
        confidence,
        evidenceRecordIds: evidence,
      },
      evaluation: {
        id: 'outcome',
        title: '结果证据',
        grade: 'bad',
        label: '验证未通过',
        summary: '存在明确失败证据，不能判定任务完成。',
        confidence,
        evidenceRecordIds: evidence,
      },
    }
  }
  if (completedAnswer !== undefined && unresolved.length > 0) {
    const evidence = [
      ...unresolved.flatMap(correction => correction.recordIds),
      completedAnswer.id,
    ]
    return {
      outcome: {
        label: '已完成，但缺少独立验证',
        summary: '后续轮次已完成并给出最终答复；此前中断产生的退出码 130 不代表最终任务失败，但缺少独立验证证明答复正确。',
        tone: 'warning',
        confidence: 'medium',
        evidenceRecordIds: [...new Set(evidence)],
      },
      evaluation: {
        id: 'outcome',
        title: '结果证据',
        grade: 'warning',
        label: '缺少独立验证',
        summary: '后续轮次完整结束并形成答复；中断轮次仍作为路径稳定性证据保留。',
        confidence: 'medium',
        evidenceRecordIds: [...new Set(evidence)],
      },
    }
  }
  if (latestEdit !== undefined && latestValidation !== undefined) {
    return {
      outcome: {
        label: '最终修改尚未验证',
        summary: `验证“${latestValidation.title}”之后仍发生了文件修改，不能将此前结果作为最终状态证据。`,
        tone: 'warning',
        confidence: 'high',
        evidenceRecordIds: [latestValidation.id, latestEdit.id],
      },
      evaluation: {
        id: 'outcome',
        title: '结果证据',
        grade: 'warning',
        label: '最终修改缺少验证',
        summary: '需要在最后一次文件修改之后重新执行相关测试、构建或检查。',
        confidence: 'high',
        evidenceRecordIds: [latestValidation.id, latestEdit.id],
      },
    }
  }
  if (corrections.some(correction => correction.status === 'recovered')) {
    const evidence = corrections.flatMap(correction => correction.recordIds)
    return {
      outcome: {
        label: '已完成，但过程发生过纠错',
        summary: '失败或重试已出现后续恢复动作，但没有独立验证证据证明最终结果正确。',
        tone: 'warning',
        confidence: 'medium',
        evidenceRecordIds: evidence,
      },
      evaluation: {
        id: 'outcome',
        title: '结果证据',
        grade: 'warning',
        label: '缺少独立验证',
        summary: '轨迹结束且异常已恢复，但不能仅凭“没有继续报错”证明结果正确。',
        confidence: 'medium',
        evidenceRecordIds: evidence,
      },
    }
  }
  return {
    outcome: {
      label: targetStatus === 'complete' ? '任务标记完成' : '未发现错误证据',
      summary: '轨迹正常结束，但没有发现可证明最终结果正确的测试、构建或检查记录。',
      tone: 'neutral',
      confidence: targetStatus === 'complete' ? 'medium' : 'low',
      evidenceRecordIds: [],
    },
    evaluation: {
      id: 'outcome',
      title: '结果证据',
      grade: 'unknown',
      label: '无法判断正确性',
      summary: '需要测试结果、断言或业务真值才能评估最终答案。',
      confidence: 'low',
      evidenceRecordIds: [],
    },
  }
}

function buildEvaluations(
  detail: SessionDetail,
  actions: readonly TrajectoryRecord[],
  steps: readonly AnalysisStep[],
  corrections: readonly AnalysisCorrection[],
  outcome: AnalysisEvaluation,
): AnalysisEvaluation[] {
  const exceptional = actions.filter(record =>
    record.status === 'error' || record.status === 'interrupted')
  const retried = actions.filter(record => record.retry !== undefined)
  const unresolved = corrections.filter(correction => correction.status === 'unresolved')
  const recovered = corrections.filter(correction => correction.status === 'recovered')
  const costSteps = steps.filter(step => usageMagnitude(step.usage) > 0)
  const tokenSum = costSteps.reduce((total, step) => total + usageMagnitude(step.usage), 0)
  const tokenPeak = Math.max(0, ...costSteps.map(step => usageMagnitude(step.usage)))
  const concentration = tokenSum === 0 ? undefined : tokenPeak / tokenSum
  const sessionTokenTotal = usageMagnitude(detail.projection.usage)
  const allocationMismatch = detail.projection.usage !== undefined
    && tokenSum !== sessionTokenTotal
  const allocationIncomplete = allocationMismatch && tokenSum < sessionTokenTotal
  const allocationOverflow = allocationMismatch && tokenSum > sessionTokenTotal
  const reasoningVisible = actions.some(record =>
    record.title === '推理' || contentText(record.output, 'reasoning') !== '')
  const timingVisible = steps.some(step => step.durationMs !== null)
  const usageVisible = detail.projection.usage !== undefined || costSteps.length > 0
  const toolResultsVisible = actions.some(record =>
    (record.kind === 'tool' || record.kind === 'subtool') && record.output !== undefined)
  const observabilitySignals = [
    reasoningVisible,
    timingVisible,
    usageVisible,
    toolResultsVisible,
  ].filter(Boolean).length

  return [
    outcome,
    {
      id: 'reliability',
      title: '路径稳定性',
      grade: exceptional.length === 0 && retried.length === 0
        ? 'good'
        : unresolved.length > 0
          ? 'bad'
          : 'warning',
      label: exceptional.length === 0 && retried.length === 0
        ? '执行路径稳定'
        : unresolved.length > 0
          ? '存在未解决异常'
          : '有波折但已继续',
      summary: `${exceptional.length} 个失败或中断步骤，${retried.reduce(
        (total, record) => total + (record.retry?.count ?? 0),
        0,
      )} 次重试。`,
      confidence: 'high',
      evidenceRecordIds: [...exceptional, ...retried].map(record => record.id),
    },
    {
      id: 'recovery',
      title: '恢复能力',
      grade: unresolved.length > 0
        ? 'bad'
        : recovered.length > 0
          ? 'good'
          : 'unknown',
      label: unresolved.length > 0
        ? '恢复不完整'
        : recovered.length > 0
          ? '观察到恢复动作'
          : '没有可评估异常',
      summary: recovered.length > 0 && unresolved.length > 0
        ? `${recovered.length} 个异常后出现成功动作；${unresolved.length} 个异常没有后续成功证据。相邻步骤关联属于轨迹推断。`
        : recovered.length > 0
          ? `${recovered.length} 个异常后出现成功动作；相邻步骤关联属于轨迹推断。`
        : unresolved.length > 0
          ? `${unresolved.length} 个异常没有后续成功证据。`
          : '本次轨迹没有触发恢复流程。',
      confidence: recovered.length > 0 ? 'medium' : 'high',
      evidenceRecordIds: corrections.flatMap(correction => correction.recordIds),
    },
    {
      id: 'efficiency',
      title: '资源效率',
      grade: allocationMismatch
        ? 'unknown'
        : concentration === undefined
        ? 'unknown'
        : costSteps.length < 2
          ? 'unknown'
          : concentration > 0.72 || retried.length > 0
            ? 'warning'
            : 'good',
      label: allocationIncomplete
        ? '步骤成本覆盖不完整'
        : allocationOverflow
          ? '步骤成本口径不一致'
        : concentration === undefined
        ? '缺少 Token 数据'
        : costSteps.length < 2
          ? '样本不足'
          : concentration > 0.72
            ? '成本集中在少数步骤'
            : retried.length > 0
              ? '重试产生额外成本'
              : '成本分布较均衡',
      summary: allocationIncomplete
        ? `已分配到步骤的 Token 约占会话总量的 ${
            Math.round(tokenSum / Math.max(1, sessionTokenTotal) * 100)
          }%；未分配成本不参与步骤集中度判断。`
        : allocationOverflow
          ? `步骤 Token 合计超过会话权威总量；不同层级口径不一致，不据此判断成本集中度。`
        : concentration === undefined
        ? '来源未提供可用于步骤比较的 Token 记录。'
        : `最高成本步骤约占已记录步骤 Token 的 ${Math.round(concentration * 100)}%；不同来源口径按原值展示。`,
      confidence: allocationMismatch || concentration === undefined ? 'low' : 'medium',
      evidenceRecordIds: costSteps
        .filter(step => usageMagnitude(step.usage) === tokenPeak)
        .map(step => step.recordId),
    },
    {
      id: 'observability',
      title: '可观测性',
      grade: observabilitySignals >= 4
        ? 'good'
        : observabilitySignals >= 2
          ? 'warning'
          : 'bad',
      label: `${observabilitySignals} / 4 类证据可用`,
      summary: [
        reasoningVisible ? '原因' : '原因缺失',
        timingVisible ? '耗时' : '耗时缺失',
        usageVisible ? 'Token' : 'Token 缺失',
        toolResultsVisible ? '工具结果' : '工具结果缺失',
      ].join(' · '),
      confidence: 'high',
      evidenceRecordIds: [],
    },
  ]
}

export function analyzeTrajectory(detail: SessionDetail): TrajectoryAnalysis {
  const actions = sortedActions(detail)
  const groups = groupActions(actions)
  const steps = buildSteps(groups)
  const corrections = buildCorrections(groups, steps)
  const { outcome, evaluation } = outcomeEvaluation(detail, actions, corrections)
  const objective = objectiveFrom(detail)
  return {
    ...objective,
    outcome,
    stats: analysisStats(detail, steps, corrections),
    steps,
    costSteps: steps.filter(step =>
      step.durationMs !== null
      || usageMagnitude(step.usage) > 0),
    corrections,
    evaluations: buildEvaluations(detail, actions, steps, corrections, evaluation),
    optimizations: analyzeTrajectoryOptimizations(detail, {
      unresolvedRecordIds: corrections
        .filter(correction => correction.status === 'unresolved')
        .flatMap(correction => correction.recordIds),
    }),
  }
}
