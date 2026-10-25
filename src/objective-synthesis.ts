import type { SessionDetail, TrajectoryRecord } from './types'

export interface ObjectiveSummary {
  objective: string
  objectiveLabel: '当前执行目标' | '会话目标'
}

interface ObjectiveMessage {
  seq: number
  text: string
  turn: number
}

interface ObjectiveIntent extends ObjectiveMessage {
  kind: 'objective'
}

interface ContextActionIntent extends ObjectiveMessage {
  action: string
  constraint?: string
  kind: 'context-action'
}

interface FlowControlIntent extends ObjectiveMessage {
  kind: 'flow-control'
}

type MessageIntent = ObjectiveIntent | ContextActionIntent | FlowControlIntent

function compact(value: string, length = 180): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= length) return normalized
  return `${normalized.slice(0, Math.max(0, length - 1)).trimEnd()}…`
}

function cleanText(value: string): string {
  return value
    .replace(/[`*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    const block = entry as Record<string, unknown>
    return typeof block.text === 'string' ? [block.text] : []
  }).join('\n')
}

function recordObjectiveText(record: TrajectoryRecord): string {
  return contentText(record.input) || record.summary
}

function browserFeedbackObjective(value: string): string | undefined {
  const marker = '# Browser comments:'
  const markerIndex = value.indexOf(marker)
  if (markerIndex < 0) return undefined
  const requestIndex = value.indexOf('\n## My request:', markerIndex + marker.length)
  const feedback = value.slice(
    markerIndex + marker.length,
    requestIndex < 0 ? value.length : requestIndex,
  )
  const comments = [...feedback.matchAll(
    /Target:\s*"([^"]+)"\s*\nComment:\s*\n([\s\S]*?)(?=\n## User Comment \d+|\nTarget:\s*"|$)/g,
  )].map(match => ({
    target: cleanText(match[1] ?? ''),
    comment: cleanText(match[2] ?? ''),
  })).filter(item => item.target !== '' && item.comment !== '')
  if (comments.length === 0) return undefined
  const recent = comments.slice(-6)
  return `根据页面反馈调整：${recent
    .map(item => `“${item.target}”（${item.comment}）`)
    .join('；')}`
}

function cleanObjective(value: string): string | undefined {
  const browserFeedback = browserFeedbackObjective(value)
  if (browserFeedback !== undefined) return compact(browserFeedback, 240)
  const trimmed = value.trim()
  if (trimmed === ''
    || trimmed.startsWith('# AGENTS.md instructions')
    || trimmed.startsWith('<environment_context')
    || trimmed.startsWith('<INSTRUCTIONS>')
    || trimmed.startsWith('<in-app-browser-context')) return undefined
  const cleaned = cleanText(trimmed
    .replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/g, '')
    .replace(/^## My request:\s*/m, '')
    .replace(/The next image is untrusted page evidence[\s\S]*/g, ''))
  return cleaned === '' ? undefined : compact(cleaned, 240)
}

function conciseObjective(value: string): string {
  const cleaned = value
    .replace(/^修正[:：]\s*/u, '')
    .replace(/\s*\d+\.\s*/g, '；')
    .replace(/其他没问题[，,]\s*执行吧/u, '其余按已确认方案实施')
    .replace(/\s+其余按已确认方案实施/u, '；其余按已确认方案实施')
    .replace(/；{2,}/g, '；')
    .replace(/^；|；$/g, '')
    .trim()
  return compact(cleaned, 240)
}

const CONTEXT_REFERENCE = /(?:结论|方案|计划|建议|前述|上述|前面|先前|这个|这些|此|该项|其余)/u
const ADDITION_TRANSITION = /[，,；;]?\s*(?:同时(?:还)?|但(?:是)?|不过|另外|此外|并(?:且)?)\s*/gu
const RESPONSE_CUES = /(?:确认|同意|认可|接受|收到|明白|好的|可以|没问题)/gu
const REFERENCE_CUES = /(?:(?:按(?:照)?|照(?:着)?|根据|基于)\s*)?(?:已确认的?)?(?:结论|方案|计划|建议|前述|上述|前面|先前|这个|这些|此|该项|其余)(?:的)?/gu
const EXECUTION_CUES = /(?:继续|开始|执行|实施|落实|推进|开发|处理|优化|改进|调整|修改|修复|完成)/gu
const DISCOURSE_CUES = /(?:请|就|都|直接|现在|然后|再|并|也|吧|即可|一下|下去|的)/gu

function semanticResidue(value: string): string {
  return cleanText(value
    .replace(RESPONSE_CUES, ' ')
    .replace(REFERENCE_CUES, ' ')
    .replace(EXECUTION_CUES, ' ')
    .replace(DISCOURSE_CUES, ' ')
    .replace(/[，,。.!！?？:：;；、“”"'（）()[\]{}]/g, ' '))
}

function additionSplits(value: string): Array<{
  head: string
  tail: string
}> {
  return [...value.matchAll(ADDITION_TRANSITION)].map(match => ({
    head: value.slice(0, match.index),
    tail: value.slice(match.index + match[0].length),
  }))
}

function contextualAction(value: string): {
  action: string
  constraint?: string
} | undefined {
  const selected = [
    ...additionSplits(value).reverse(),
    { head: value, tail: '' },
  ].find(candidate =>
    CONTEXT_REFERENCE.test(candidate.head)
    && semanticResidue(candidate.head) === '')
  if (selected === undefined) return undefined
  const { head } = selected
  const tail = selected.tail === '' ? undefined : selected.tail
  const referencesContext = CONTEXT_REFERENCE.test(head)
  if (!referencesContext) return undefined

  const reference = /结论/u.test(head)
    ? '结论'
    : /建议/u.test(head)
      ? '建议'
    : /方案|计划/u.test(head)
      ? '方案'
      : '前述要求'
  const operation = /优化|改进/u.test(head)
    ? '优化'
    : /执行|实施|落实|开发/u.test(head)
      ? '实施'
      : /修改|调整|修复/u.test(head)
        ? '调整'
        : '推进'
  const action = reference === '结论' && operation === '优化'
    ? '根据结论完成优化'
    : reference === '方案' && operation === '实施'
      ? '按已确认方案实施'
      : reference === '建议' && operation === '推进'
        ? '根据建议继续推进'
      : `${reference === '前述要求' ? '基于前述要求' : `根据${reference}`}${
          operation === '推进' ? '继续推进' : `完成${operation}`
        }`
  const constraint = tail === undefined || semanticResidue(tail) === ''
    ? undefined
    : conciseObjective(tail)
  return { action, constraint }
}

function classify(message: ObjectiveMessage): MessageIntent {
  const contextual = contextualAction(message.text)
  if (contextual !== undefined) {
    return {
      ...message,
      ...contextual,
      kind: 'context-action',
    }
  }
  const factualAddition = additionSplits(message.text).find(split =>
    semanticResidue(split.head) === '' && semanticResidue(split.tail) !== '')
  if (factualAddition !== undefined) {
    return {
      ...message,
      kind: 'objective',
      text: conciseObjective(factualAddition.tail),
    }
  }
  return semanticResidue(message.text) === ''
    ? { ...message, kind: 'flow-control' }
    : { ...message, kind: 'objective' }
}

function synthesizeObjectives(intents: readonly ObjectiveIntent[]): string | undefined {
  const goals = [...new Set(intents.map(intent => conciseObjective(intent.text)))]
  const initial = goals[0]
  const middle = goals.length > 2 ? goals.at(-2) : undefined
  const final = goals.at(-1)
  if (initial === undefined || final === undefined) return undefined
  if (initial === final) return final
  return middle === undefined || middle === initial || middle === final
    ? compact(`围绕“${initial}”，最终目标为“${final}”`, 240)
    : compact(`围绕“${initial}”，过程中推进“${middle}”，最终目标为“${final}”`, 240)
}

function completedObjective(intents: readonly MessageIntent[]): string | undefined {
  const objectives = intents.filter(
    (intent): intent is ObjectiveIntent => intent.kind === 'objective',
  )
  const base = synthesizeObjectives(objectives)
  if (base === undefined) return undefined
  const lastObjectiveSeq = objectives.at(-1)?.seq ?? -1
  const contextual = intents.filter(
    (intent): intent is ContextActionIntent =>
      intent.kind === 'context-action' && intent.seq > lastObjectiveSeq,
  ).at(-1)
  if (contextual === undefined) return base
  return compact(
    `在“${base}”基础上，${contextual.action}${
      contextual.constraint === undefined ? '' : `，并${contextual.constraint}`
    }`,
    240,
  )
}

function activeExecutionObjective(
  detail: SessionDetail,
  activeTurn: number,
): string | undefined {
  const summaries = detail.projection.records
    .filter(record =>
      record.turn === activeTurn
      && record.kind === 'assistant'
      && record.title !== '推理')
    .sort((left, right) => right.seq - left.seq || right.startTime - left.startTime)
    .map(record => cleanText(record.summary))
    .filter(Boolean)
  for (const summary of summaries) {
    const explicit = [
      /(?:接下来|下一步)(?:将|会|先)?([^。；\n]{4,140})/u,
      /现在(?:将|会|先)?([^。；\n]{4,140})/u,
      /我(?:将|会)([^。；\n]{4,140})/u,
      /当前(?:正在|先)([^。；\n]{4,140})/u,
    ].flatMap(pattern => {
      const match = summary.match(pattern)?.[1]?.trim()
      return match === undefined ? [] : [match]
    })[0]
    if (explicit !== undefined) return conciseObjective(explicit)
  }
  return undefined
}

function sessionInProgress(detail: SessionDetail): boolean {
  const targetStatus = detail.projection.taskState?.target?.status
  return targetStatus === 'active'
    || detail.projection.turns.some(turn => turn.status === 'running')
    || detail.projection.records.some(record => record.status === 'running')
}

export function objectiveFrom(detail: SessionDetail): ObjectiveSummary {
  const inProgress = sessionInProgress(detail)
  const target = detail.projection.taskState?.target?.objective
  if (target !== undefined && target.trim() !== '') {
    return {
      objective: compact(target, 240),
      objectiveLabel: inProgress ? '当前执行目标' : '会话目标',
    }
  }
  const messages = [...detail.projection.records]
    .sort((left, right) => left.seq - right.seq || left.startTime - right.startTime)
    .flatMap((record): ObjectiveMessage[] => {
      if (record.kind !== 'user' && record.kind !== 'steering') return []
      const candidate = cleanObjective(recordObjectiveText(record))
      return candidate === undefined
        ? []
        : [{
            text: candidate,
            turn: record.turn,
            seq: record.seq,
          }]
    })
  const intents = messages.map(classify)
  const activeTurn = Math.max(
    0,
    ...detail.projection.turns
      .filter(turn => turn.status === 'running')
      .map(turn => turn.number),
    ...detail.projection.records
      .filter(record => record.status === 'running')
      .map(record => record.turn),
  )
  const activeObjective = inProgress && activeTurn > 0
    ? activeExecutionObjective(detail, activeTurn)
    : undefined
  if (activeObjective !== undefined) {
    return {
      objective: activeObjective,
      objectiveLabel: '当前执行目标',
    }
  }
  if (inProgress) {
    const current = intents.filter(intent =>
      activeTurn === 0 || intent.turn <= activeTurn).at(-1)
    if (current?.kind === 'context-action') {
      return {
        objective: current.constraint === undefined
          ? current.action
          : `${current.action}，并${current.constraint}`,
        objectiveLabel: '当前执行目标',
      }
    }
    const latestObjective = [...intents].reverse().find(
      (intent): intent is ObjectiveIntent => intent.kind === 'objective',
    )
    if (latestObjective !== undefined) {
      return {
        objective: conciseObjective(latestObjective.text),
        objectiveLabel: '当前执行目标',
      }
    }
  } else {
    const objective = completedObjective(intents)
    if (objective !== undefined) {
      return { objective, objectiveLabel: '会话目标' }
    }
  }
  const sessionTitle = detail.summary.title.trim()
  if (sessionTitle !== ''
    && !/^DSH\s*·/i.test(sessionTitle)
    && sessionTitle !== detail.summary.sourceSessionId) {
    return {
      objective: compact(sessionTitle, 240),
      objectiveLabel: inProgress ? '当前执行目标' : '会话目标',
    }
  }
  return {
    objective: '轨迹未记录明确任务目标',
    objectiveLabel: inProgress ? '当前执行目标' : '会话目标',
  }
}
