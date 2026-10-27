import type { SessionDetail, TrajectoryRecord } from './types'
import { toolCommand, validationSemantics } from './tool-semantics'

export const OPTIMIZATION_MEASURES = [
  'code', 'rule', 'hook', 'plugin', 'environment', 'workflow', 'verification',
] as const
export const OPTIMIZATION_CATEGORIES = [
  'duplicate', 'retry', 'environment', 'verification', 'detour', 'search', 'context', 'constraint',
] as const
export const OPTIMIZATION_ACTION_KINDS = [
  'rule', 'code', 'hook', 'plugin', 'workflow',
] as const
export type OptimizationMeasure = typeof OPTIMIZATION_MEASURES[number]
export type OptimizationCategory = typeof OPTIMIZATION_CATEGORIES[number]

export interface OptimizationExecutionAction {
  kind: typeof OPTIMIZATION_ACTION_KINDS[number]
  title: string
  target: string
  instruction: string
  content?: string
  verification: string
}

export interface OptimizationSuggestion {
  id: string
  category: OptimizationCategory
  title: string
  priority: 'high' | 'medium' | 'low'
  confidence: 'high' | 'medium' | 'low'
  measures: OptimizationMeasure[]
  effort: 'low' | 'medium' | 'high'
  observation: string
  cause: string
  action: string
  target: string
  expectedBenefit: string
  verification: string
  limitation: string
  executionActions: OptimizationExecutionAction[]
  occurrences: number
  evidence: Array<{ recordId: string; turn: number; step: number }>
}

export interface OptimizationContext {
  unresolvedRecordIds?: string[]
}

type Advice = Pick<OptimizationSuggestion,
  'title' | 'measures' | 'cause' | 'action' | 'target' | 'expectedBenefit'
  | 'verification' | 'limitation' | 'executionActions'>

function optimizationProblemKey(
  suggestion: Pick<OptimizationSuggestion,
    'category' | 'title' | 'target' | 'measures' | 'executionActions'>,
): string {
  const actions = suggestion.executionActions.map(action => [
    action.kind,
    action.title.trim(),
    action.target.trim(),
  ].join('\0')).sort()
  return [
    suggestion.category,
    suggestion.title.trim(),
    suggestion.target.trim(),
    [...suggestion.measures].sort().join('\0'),
    actions.join('\x01'),
  ].join('\x02')
}

function mergeEquivalentSuggestions(
  suggestions: OptimizationSuggestion[],
): OptimizationSuggestion[] {
  const merged = new Map<string, OptimizationSuggestion>()
  for (const suggestion of suggestions) {
    const key = optimizationProblemKey(suggestion)
    const existing = merged.get(key)
    if (existing === undefined) {
      merged.set(key, {
        ...suggestion,
        evidence: [...suggestion.evidence],
      })
      continue
    }
    const evidence = new Map(existing.evidence.map(item => [item.recordId, item]))
    for (const item of suggestion.evidence) evidence.set(item.recordId, item)
    existing.evidence = [...evidence.values()]
    existing.occurrences += suggestion.occurrences
  }
  return [...merged.values()]
}

const ADVICE: Record<
  'duplicate' | 'retry' | 'parameters' | 'environment' | 'verification'
  | 'unresolved' | 'recoveredFailures',
  Advice
> = {
  duplicate: {
    title: '复用重复读取结果，减少无新增信息的调用',
    measures: ['workflow', 'rule'],
    cause: '可能未复用已有读取结果；轨迹本身不能证明外部状态完全未变化。',
    action: '读取前检查已有结果是否仍适用；仅在文件、输入或环境变化后重新读取。必要时增加带失效条件的结果缓存。',
    target: 'Agent 执行规则或只读工具封装',
    expectedBenefit: '减少无新增信息的调用和重复上下文。',
    verification: '在输入不变与文件已更新的两类场景下，检查结果能复用且不会使用过期内容。',
    limitation: '仅比较同一请求区间内参数和结果完全相同的只读调用；未观察到变更不代表没有外部变更。',
    executionActions: [{
      kind: 'rule',
      title: '增加只读结果复用规则',
      target: '项目根目录 AGENTS.md（不存在时可新建）',
      instruction: '将以下内容加入工具调用或执行效率章节。',
      content: [
        '- 参数和输入未变化时，复用已有只读结果，不得原样重复读取。',
        '- 文件、会话或环境发生变化后，才允许重新读取。',
        '- 无法确认结果是否过期时，先说明失效条件，再决定是否刷新。',
      ].join('\n'),
      verification: '使用输入不变和文件已修改两组场景，确认前者复用、后者刷新。',
    }],
  },
  retry: {
    title: '相同错误再次出现时，先诊断再重试',
    measures: ['code', 'rule'],
    cause: '可能在未改变失败条件的情况下再次调用。',
    action: '根据错误类型选择下一步；同样输入仍失败时，先核对根因、调整输入或环境，再重新执行。',
    target: '错误处理代码或 Agent 重试规则',
    expectedBenefit: '减少原样重试，保留有依据的恢复路径。',
    verification: '复现该类错误，检查再次执行前是否产生了与根因相关的调整。',
    limitation: '相同错误不等于根因相同；正常网络退避和中断不纳入此规则。',
    executionActions: [
      {
        kind: 'rule',
        title: '增加失败后禁止原样重试规则',
        target: '项目根目录 AGENTS.md（不存在时可新建）',
        instruction: '将以下内容加入异常处理章节。',
        content: [
          '- 工具调用失败后，不得在输入和环境均未变化时原样重试。',
          '- 再次执行前必须记录失败条件、根因假设和本次调整。',
          '- 无法恢复时明确报告阻塞条件，不得宣称任务完成。',
        ].join('\n'),
        verification: '复现同类错误，确认第二次调用前存在与根因相关的输入或环境调整。',
      },
      {
        kind: 'code',
        title: '在重试入口增加确定性错误门禁',
        target: '候选位置：工具调用器的 retry/error handler',
        instruction: '区分确定性输入错误与暂时性错误；确定性错误只有输入或环境变化后才能重试。',
        content: [
          'if (isDeterministicError(error) && !inputOrEnvironmentChanged) {',
          '  return requireDiagnosisBeforeRetry(error)',
          '}',
          'return retryWithBoundedBackoff(error)',
        ].join('\n'),
        verification: '分别覆盖参数错误与网络超时，确认门禁只阻止确定性错误原样重试。',
      },
    ],
  },
  parameters: {
    title: '为参数错误增加重试前检查',
    measures: ['code', 'hook'],
    cause: '可能缺少调用前参数校验，或未将参数错误与暂时性错误分开处理。',
    action: '校验必填参数和允许值；参数错误必须调整输入后才能重试。支持调用前 Hook 时可前置校验，否则放入工具封装。',
    target: '工具输入校验；Hook 需先确认当前 Agent 支持',
    expectedBenefit: '减少确定性输入错误的重复调用。',
    verification: '分别测试参数错误与网络超时，确认前者要求修正输入，后者仍可有上限地退避重试。',
    limitation: '不阻断正常网络恢复；不自动写入 Hook 或修改工具。',
    executionActions: [{
      kind: 'code',
      title: '在工具调用前增加参数校验',
      target: '候选位置：工具输入 schema 或调用前校验器',
      instruction: '校验必填字段、允许值和互斥参数；参数错误返回可修正信息，不进入自动重试。',
      content: [
        'const validation = validateToolInput(input)',
        'if (!validation.ok) {',
        '  return { retryable: false, reason: validation.message }',
        '}',
      ].join('\n'),
      verification: '对缺失参数、非法值和网络超时分别测试，确认只有网络类错误可进入退避重试。',
    }],
  },
  environment: {
    title: '执行前确认所需命令和依赖可用',
    measures: ['environment', 'workflow'],
    cause: '记录显示命令或依赖不可用，可能需要环境配置或执行路径调整。',
    action: '核对工作目录、运行环境和依赖声明，再选择安装已确认的依赖、修正路径或采用现有可用工具。',
    target: '项目运行环境与执行前预检',
    expectedBenefit: '减少环境缺口导致的试错。',
    verification: '先运行最小可用性检查，再复现原调用，确认同类环境错误不再出现。',
    limitation: '轨迹不能确认实际安装状态；不自动安装依赖或推荐未经核实的插件。',
    executionActions: [{
      kind: 'workflow',
      title: '增加执行前环境预检',
      target: '项目启动脚本或 Agent 执行规则',
      instruction: '在进入主流程前检查工作目录、所需命令和依赖声明；缺失时立即报告具体阻塞项。',
      content: [
        '1. 确认当前工作目录与目标项目一致。',
        '2. 检查所需命令是否可用，并读取项目已有依赖声明。',
        '3. 仅在确认依赖名称和版本后提出安装动作。',
        '4. 预检失败时停止后续调用并报告缺失项。',
      ].join('\n'),
      verification: '在命令存在和缺失两种环境运行预检，确认主流程仅在预检通过后启动。',
    }],
  },
  verification: {
    title: '为最后的文件修改补充验证闭环',
    measures: ['verification', 'hook'],
    cause: '当前轨迹未包含最后修改之后的成功验证，可能是验证遗漏或记录不完整。',
    action: '根据修改内容执行相关测试、构建或人工核查，并保存结果；支持完成前 Hook 时可提醒提供验证证据。',
    target: '项目验证流程；Hook 需先确认当前 Agent 支持',
    expectedBenefit: '让完成结论有对应的验证依据。',
    verification: '检查最终修改之后是否有相关验证结果，并明确未覆盖的检查项。',
    limitation: '没有记录不代表没有验证；任意命令成功也不等于结果正确。',
    executionActions: [{
      kind: 'rule',
      title: '增加完成前验证规则',
      target: '项目根目录 AGENTS.md（不存在时可新建）',
      instruction: '将以下内容加入完成条件章节。',
      content: [
        '- 修改文件后，必须执行与改动范围对应的测试、构建或人工检查。',
        '- 最终回复必须列出已执行验证、结果以及未覆盖项。',
        '- 验证失败或未执行时，不得表述为“已完成且正确”。',
      ].join('\n'),
      verification: '完成一次文件修改，确认最终修改之后存在验证记录且交付说明列出结果。',
    }],
  },
  unresolved: {
    title: '为未恢复错误建立明确的收敛路径',
    measures: ['workflow', 'rule'],
    cause: '当前错误之后没有观察到成功恢复证据，可能仍缺少根因判断、替代方案或验证动作。',
    action: '先记录失败条件和已排除项，再选择修正输入、调整环境或改用替代路径；完成前必须补充与该错误对应的验证结果。',
    target: '异常处理流程与完成条件',
    expectedBenefit: '避免在问题尚未收敛时结束执行或重复试错。',
    verification: '从该错误继续执行，确认后续出现针对性调整以及成功验证，或明确记录无法继续的阻塞条件。',
    limitation: '恢复状态依据相邻步骤和验证记录判断；轨迹未记录的线下处理不可见。',
    executionActions: [{
      kind: 'rule',
      title: '增加未恢复错误收敛规则',
      target: '项目根目录 AGENTS.md（不存在时可新建）',
      instruction: '将以下内容加入异常处理与完成条件章节。',
      content: [
        '- 出现未恢复错误时，先记录失败条件、已排除项和下一步假设。',
        '- 必须选择修正输入、调整环境或替代路径中的一项，并说明选择理由。',
        '- 后续没有成功验证时，明确报告阻塞条件，不得结束为成功。',
      ].join('\n'),
      verification: '从该错误继续执行，确认轨迹出现针对性调整和对应验证，或明确的阻塞报告。',
    }],
  },
  recoveredFailures: {
    title: '增加能力预检，减少连续失败后的反复改道',
    measures: ['workflow', 'environment'],
    cause: '同一轮出现多次不同工具错误后才恢复，可能在能力、页面状态或运行环境未确认时过早进入了试错。',
    action: '执行前先检查目标能力、当前页面或环境状态；首次失败后记录错误类型，并优先选择能验证假设的最小探针，再决定是否切换路径。',
    target: '执行前预检与异常后的工具选择流程',
    expectedBenefit: '减少多路径盲试和无效改道，同时保留必要的探索。',
    verification: '在相同任务上比较首次失败后的动作，确认后续调用由明确假设驱动，且不同失败次数下降。',
    limitation: '多次不同错误不必然代表绕路；本建议仅在同一轮达到阈值时作为中置信改进提示。',
    executionActions: [{
      kind: 'workflow',
      title: '加入能力预检和最小探针',
      target: 'Agent 执行流程或项目根目录 AGENTS.md',
      instruction: '主流程前确认目标能力；首次失败后只运行一个能区分根因的最小探针，再决定是否改道。',
      content: [
        '- 执行前确认目标应用、工具、页面和环境是否可用。',
        '- 首次失败后写出可证伪的根因假设。',
        '- 下一次调用必须是验证该假设的最小探针。',
        '- 连续两次探针无信息增益时暂停并重新选择路径。',
      ].join('\n'),
      verification: '复现同类任务，检查首次失败后的每个调用都有明确假设，并统计不同失败数是否下降。',
    }],
  },
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function command(record: TrajectoryRecord): string {
  return toolCommand(record)
}

// Exact, bounded comparison: do not remove whitespace from shell arguments or output.
function fingerprint(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  try {
    const serialized = JSON.stringify(value, (_key, item: unknown) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    })
    return serialized !== undefined && serialized.length <= 16_384 ? serialized : undefined
  } catch {
    return undefined
  }
}

function resultText(record: TrajectoryRecord): string {
  // Only returned error/output evidence is classified, never the command's own text.
  return [record.error?.code, record.error?.reason, fingerprint(record.output)]
    .filter(Boolean).join(' ').slice(0, 18_000)
}

function isValidation(record: TrajectoryRecord): boolean {
  return validationSemantics(record) !== undefined
}

function isEdit(record: TrajectoryRecord): boolean {
  return /^(?:apply_patch|edit_file|write_file|replace_in_file|multiedit|edit|write)$/i.test(record.title)
}

function isRead(record: TrajectoryRecord): boolean {
  if (record.policy?.readOnly === false || record.policy?.destructive === true) return false
  const cmd = command(record)
  if (/wait|poll|watch|status|write_stdin/i.test(record.title)
    || /(?:^|\s)(?:sleep|watch|tail|status)(?:\s|$)/i.test(cmd)) return false
  if (isValidation(record) || isEdit(record)) return false
  if (record.policy?.readOnly === true) return true
  if (/^(?:read_file|read|search|search_files|list_files|glob|grep)$/i.test(record.title)) return true
  return !/[\n;&|><`$]/.test(cmd)
    && /^(?:rg|grep|cat|head|ls|pwd)\b/.test(cmd.trim())
}

interface Group {
  first: TrajectoryRecord
  count: number
  records: TrajectoryRecord[]
  type: 'duplicate' | 'retry' | 'parameters' | 'environment'
}

function suggestion(group: Group): OptimizationSuggestion {
  const category = group.type === 'parameters' ? 'retry' : group.type
  return {
    ...ADVICE[group.type],
    id: `optimization:${category}:${group.first.id}`,
    category,
    priority: category === 'retry' ? 'high' : 'medium',
    confidence: category === 'environment' ? 'high' : 'medium',
    effort: 'low',
    observation: category === 'duplicate'
      ? `观察到 ${group.count} 次参数和结果相同的只读调用，期间未记录相关修改。`
      : category === 'environment'
        ? `观察到 ${group.count} 次命令或依赖不可用的错误记录。`
        : `观察到 ${group.count} 次输入和错误信息相同的失败调用。`,
    occurrences: group.count,
    evidence: group.records.map(record => ({
      recordId: record.id, turn: record.turn, step: record.step,
    })),
  }
}

/** No model calls or side effects. Missing inputs/outputs never imply equivalence. */
export function analyzeTrajectoryOptimizations(
  detail: SessionDetail,
  context: OptimizationContext = {},
): OptimizationSuggestion[] {
  const records = [...detail.projection.records].sort((a, b) => a.seq - b.seq || a.startTime - b.startTime)
  const groups: Group[] = []
  const repeated = new Map<string, Group>()
  const failures = new Map<string, Group>()
  const observedFailures: TrajectoryRecord[] = []
  const calls = new Set<string>()
  let turn: number | undefined
  let explicitRecheck = false
  let lastEdit: TrajectoryRecord | undefined
  let validated = false

  for (const [recordIndex, record] of records.entries()) {
    if (record.turn !== turn || record.kind === 'user' || record.kind === 'steering'
      || record.kind === 'compaction') {
      repeated.clear()
      failures.clear()
      if (record.turn !== turn) explicitRecheck = false
      turn = record.turn
    }
    if (record.kind === 'user' || record.kind === 'steering') {
      explicitRecheck = /再次|复核|重复|重跑|重新验证|recheck|repeat|again/i
        .test(`${record.summary} ${fingerprint(record.input) ?? ''}`)
    }
    if (record.kind !== 'tool' && record.kind !== 'subtool') continue
    // Nested/mirrored calls are not independent repetitions.
    if (record.parentCallId !== undefined || record.parentSpanId !== undefined) continue
    if (record.callId !== undefined) {
      const key = `${record.turn}:${record.callId}`
      if (calls.has(key)) continue
      calls.add(key)
    }
    if (isEdit(record) && record.status === 'complete') {
      lastEdit = record
      validated = false
    }
    if (isValidation(record)) {
      const hasLaterEdit = records.slice(recordIndex + 1).some(candidate =>
        candidate.turn === record.turn
        && candidate.status === 'complete'
        && isEdit(candidate))
      validated = validationSemantics(record)?.outcome === 'passed' && !hasLaterEdit
    }

    const input = fingerprint(record.input)
    const output = fingerprint(record.output)
    const result = resultText(record)
    const transient = /(?:request|connection|operation|command)\s+(?:timed?\s*out|timeout)|rate.?limit|too many requests|ECONNRESET|ECONNREFUSED|network (?:timeout|timed?\s*out|error|failure|unavailable)|temporar(?:y|ily) unavailable|请求超时|网络错误|网络不可用|限流/i.test(result)
    const failed = record.status === 'error' && !transient
    const environment = failed && /command not found|cannot find (?:module|package)|module not found|ModuleNotFoundError|No module named|ENOENT|命令不存在|找不到模块/i.test(result)
    const parameters = failed && /invalid (?:argument|parameter|option)|unknown option|unrecognized arguments?|missing required|参数(?:错误|无效|缺失)|缺少必填/i.test(result)
    const read = record.status === 'complete' && isRead(record)

    if (record.status === 'error') observedFailures.push(record)
    if (failed && input !== undefined && result !== '') {
      repeated.clear()
      const key = `${record.title}\0${input}\0${result}`
      let group = failures.get(key)
      if (group === undefined) {
        group = { first: record, count: 0, records: [], type: environment ? 'environment' : parameters ? 'parameters' : 'retry' }
        failures.set(key, group)
        groups.push(group)
      }
      group.count++
      if (group.records.length < 32) group.records.push(record)
    } else if (read) {
      // Reads may diagnose errors without changing their cause.
      if (input === undefined || output === undefined || explicitRecheck) continue
      const key = `${record.title}\0${input}\0${output}`
      let group = repeated.get(key)
      if (group === undefined) {
        group = { first: record, count: 0, records: [], type: 'duplicate' }
        repeated.set(key, group)
        groups.push(group)
      }
      group.count++
      if (group.records.length < 32) group.records.push(record)
    } else {
      // Unknown effects, writes, validation and polling invalidate equivalence.
      repeated.clear()
      failures.clear()
    }
  }

  const groupedProblems = new Map<Group['type'], Group>()
  for (const group of groups.filter(group =>
    group.type === 'environment' || group.count >= (group.type === 'duplicate' ? 3 : 2))) {
    const existing = groupedProblems.get(group.type)
    if (existing === undefined) {
      groupedProblems.set(group.type, {
        ...group,
        records: [...group.records],
      })
      continue
    }
    existing.count += group.count
    const recordIds = new Set(existing.records.map(record => record.id))
    for (const record of group.records) {
      if (existing.records.length >= 32) break
      if (!recordIds.has(record.id)) {
        existing.records.push(record)
        recordIds.add(record.id)
      }
    }
  }
  const result = [...groupedProblems.values()].map(suggestion)
  const recovered = (failure: TrajectoryRecord): boolean => {
    const nextTool = records.find(candidate =>
      candidate.turn === failure.turn
      && candidate.seq > failure.seq
      && (candidate.kind === 'tool' || candidate.kind === 'subtool')
      && candidate.parentCallId === undefined
      && candidate.parentSpanId === undefined)
    return nextTool?.status === 'complete'
  }
  const unresolvedIds = new Set(context.unresolvedRecordIds ?? [])
  const unresolved = [...observedFailures].reverse().find(failure =>
    unresolvedIds.has(failure.id))
    ?? [...observedFailures].reverse().find(failure => !recovered(failure))
  if (unresolved !== undefined && !result.some(item =>
    item.evidence.some(evidence => evidence.recordId === unresolved.id))) {
    result.push({
      ...ADVICE.unresolved,
      id: `optimization:retry:unresolved:${unresolved.id}`,
      category: 'retry',
      priority: 'high',
      confidence: 'high',
      effort: 'medium',
      observation: '轨迹中观察到一个错误在会话结束前没有后续成功恢复证据。',
      occurrences: 1,
      evidence: [{
        recordId: unresolved.id,
        turn: unresolved.turn,
        step: unresolved.step,
      }],
    })
  }
  const failuresByTurn = new Map<number, TrajectoryRecord[]>()
  for (const failure of observedFailures.filter(recovered)) {
    const turnFailures = failuresByTurn.get(failure.turn) ?? []
    turnFailures.push(failure)
    failuresByTurn.set(failure.turn, turnFailures)
  }
  for (const [failureTurn, turnFailures] of failuresByTurn) {
    if (turnFailures.length < 4) continue
    const evidence = turnFailures.slice(0, 12).map(failure => ({
      recordId: failure.id,
      turn: failure.turn,
      step: failure.step,
    }))
    if (result.some(item => item.category === 'detour'
      || evidence.some(ref =>
        item.evidence.some(existing => existing.recordId === ref.recordId)))) continue
    result.push({
      ...ADVICE.recoveredFailures,
      id: `optimization:detour:turn:${failureTurn}`,
      category: 'detour',
      priority: 'medium',
      confidence: 'medium',
      effort: 'low',
      observation: `第 ${failureTurn} 轮观察到 ${turnFailures.length} 个不同失败，之后均出现了成功动作。`,
      occurrences: turnFailures.length,
      evidence,
    })
  }
  const running = detail.projection.turns.some(item => item.status === 'running')
    || records.some(item => item.status === 'running')
    || detail.projection.taskState?.target?.status === 'active'
  if (lastEdit !== undefined && !validated && !running) {
    result.push({
      ...ADVICE.verification,
      id: `optimization:verification:${lastEdit.id}`,
      category: 'verification',
      priority: 'medium',
      confidence: 'low',
      effort: 'low',
      observation: '轨迹中最后的文件修改之后，未观察到成功的测试、构建或检查记录。',
      occurrences: 1,
      evidence: [{ recordId: lastEdit.id, turn: lastEdit.turn, step: lastEdit.step }],
    })
  }
  const rank = { high: 0, medium: 1, low: 2 }
  return mergeEquivalentSuggestions(result).sort((a, b) =>
    rank[a.priority] - rank[b.priority]
    || rank[a.confidence] - rank[b.confidence]
    || b.occurrences - a.occurrences
    || a.id.localeCompare(b.id)).slice(0, 24)
}
