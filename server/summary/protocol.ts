import type {
  AiEnhancementDraft,
  AiEnhancementModule,
  AiEvaluationEnhancement,
  AiEvidenceRequest,
  AiObjectiveEnhancement,
  AiOutcomeEnhancement,
  AiStoryEnhancement,
  AiStoryStageEnhancement,
} from '../../src/ai-summary-types'
import {
  OPTIMIZATION_ACTION_KINDS,
  OPTIMIZATION_CATEGORIES,
  OPTIMIZATION_MEASURES,
  type AiOptimization,
  type OptimizationExecutionAction,
} from '../../src/trajectory-optimization'

const TEXT = { type: 'string' } as const
const STRINGS = {
  type: 'array',
  maxItems: 12,
  items: TEXT,
} as const
const EVIDENCE_IDS = {
  type: 'array',
  maxItems: 32,
  items: TEXT,
} as const
const OPTIMIZATION_TEXT_FIELDS = [
  'title', 'observation', 'cause', 'action', 'target',
  'expectedBenefit', 'verification', 'limitation',
] as const
const OPTIMIZATION_ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'title', 'target', 'instruction', 'content', 'verification'],
  properties: {
    kind: { enum: [...OPTIMIZATION_ACTION_KINDS] },
    title: TEXT,
    target: TEXT,
    instruction: TEXT,
    content: TEXT,
    verification: TEXT,
  },
} as const

const MODULE_SCHEMAS: Record<AiEnhancementModule, Record<string, unknown>> = {
  outcome: {
    type: 'object',
    additionalProperties: false,
    required: ['headline', 'summary', 'verification', 'unresolved', 'evidenceRecordIds'],
    properties: {
      headline: TEXT,
      summary: TEXT,
      verification: TEXT,
      unresolved: STRINGS,
      evidenceRecordIds: EVIDENCE_IDS,
    },
  },
  objective: {
    type: 'object',
    additionalProperties: false,
    required: ['statement', 'successCriteria', 'constraints', 'evolution', 'evidenceRecordIds'],
    properties: {
      statement: TEXT,
      successCriteria: STRINGS,
      constraints: STRINGS,
      evolution: TEXT,
      evidenceRecordIds: EVIDENCE_IDS,
    },
  },
  story: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'stages'],
    properties: {
      summary: TEXT,
      stages: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['stageId', 'title', 'judgment', 'actions', 'outcome', 'evidenceRecordIds'],
          properties: {
            stageId: TEXT,
            title: TEXT,
            judgment: TEXT,
            actions: STRINGS,
            outcome: TEXT,
            evidenceRecordIds: EVIDENCE_IDS,
          },
        },
      },
    },
  },
  evaluation: {
    type: 'array',
    maxItems: 5,
    items: {
      type: 'object',
      additionalProperties: false,
      required: [
        'evaluationId', 'label', 'summary', 'strengths', 'risks', 'evidenceRecordIds',
      ],
      properties: {
        evaluationId: {
          enum: ['outcome', 'reliability', 'recovery', 'efficiency', 'observability'],
        },
        label: TEXT,
        summary: TEXT,
        strengths: STRINGS,
        risks: STRINGS,
        evidenceRecordIds: EVIDENCE_IDS,
      },
    },
  },
  optimization: {
    type: 'array',
    maxItems: 8,
    items: {
      type: 'object',
      additionalProperties: false,
      required: [
        'findingId', 'category', ...OPTIMIZATION_TEXT_FIELDS,
        'executionActions', 'measures', 'evidenceRecordIds',
      ],
      properties: {
        findingId: TEXT,
        category: { enum: [...OPTIMIZATION_CATEGORIES] },
        ...Object.fromEntries(OPTIMIZATION_TEXT_FIELDS.map(key => [key, TEXT])),
        measures: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: { enum: [...OPTIMIZATION_MEASURES] },
        },
        executionActions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: OPTIMIZATION_ACTION_SCHEMA,
        },
        evidenceRecordIds: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: TEXT,
        },
      },
    },
  },
}

export function enhancementOutputSchema(
  modules: readonly AiEnhancementModule[],
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...modules, 'evidenceRequests'],
    properties: {
      ...Object.fromEntries(modules.map(module => [module, MODULE_SCHEMAS[module]])),
      evidenceRequests: {
        type: 'array',
        maxItems: 24,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['recordId', 'reason'],
          properties: {
            recordId: TEXT,
            reason: TEXT,
          },
        },
      },
    },
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown, max = 4_000): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim()
  return cleaned === '' ? undefined : cleaned.slice(0, max)
}

function strings(value: unknown, maxItems = 32): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined
  const selected = value.map(item => text(item, 1_200))
  return selected.some(item => item === undefined)
    ? undefined
    : selected as string[]
}

const QUANTIFIED_FACT_PATTERN =
  /(?:\d|[零一二三四五六七八九十百千万]+(?:个|项|次|轮|步|秒|分钟|毫秒|文件|错误|失败|Token|token))/u

function semanticText(value: unknown, max = 4_000): string | undefined {
  const selected = text(value, max)
  if (selected !== undefined && QUANTIFIED_FACT_PATTERN.test(selected)) {
    throw new Error('AI semantic text contains a numeric fact')
  }
  return selected
}

function semanticStrings(value: unknown, maxItems = 12): string[] | undefined {
  const selected = strings(value, maxItems)
  if (selected?.some(item => QUANTIFIED_FACT_PATTERN.test(item))) {
    throw new Error('AI semantic list contains a numeric fact')
  }
  return selected
}

function evidenceIds(value: unknown): string[] | undefined {
  return strings(value, 32)
}

function parseOutcome(value: unknown): AiOutcomeEnhancement | undefined {
  const source = object(value)
  if (source === undefined) return undefined
  const headline = semanticText(source.headline)
  const summary = semanticText(source.summary, 8_000)
  const verification = semanticText(source.verification)
  const unresolved = semanticStrings(source.unresolved)
  const ids = evidenceIds(source.evidenceRecordIds)
  return headline === undefined || summary === undefined || verification === undefined
    || unresolved === undefined || ids === undefined
    ? undefined
    : { headline, summary, verification, unresolved, evidenceRecordIds: ids }
}

function parseObjective(value: unknown): AiObjectiveEnhancement | undefined {
  const source = object(value)
  if (source === undefined) return undefined
  const statement = semanticText(source.statement, 8_000)
  const successCriteria = semanticStrings(source.successCriteria)
  const constraints = semanticStrings(source.constraints)
  const evolution = semanticText(source.evolution)
  const ids = evidenceIds(source.evidenceRecordIds)
  return statement === undefined || successCriteria === undefined
    || constraints === undefined || evolution === undefined || ids === undefined
    ? undefined
    : { statement, successCriteria, constraints, evolution, evidenceRecordIds: ids }
}

function parseStoryStage(value: unknown): AiStoryStageEnhancement | undefined {
  const source = object(value)
  if (source === undefined) return undefined
  const stageId = text(source.stageId, 300)
  const title = semanticText(source.title)
  const judgment = semanticText(source.judgment)
  const actions = semanticStrings(source.actions)
  const outcome = semanticText(source.outcome)
  const ids = evidenceIds(source.evidenceRecordIds)
  return stageId === undefined || title === undefined || judgment === undefined
    || actions === undefined || outcome === undefined || ids === undefined
    ? undefined
    : { stageId, title, judgment, actions, outcome, evidenceRecordIds: ids }
}

function parseStory(value: unknown): AiStoryEnhancement | undefined {
  const source = object(value)
  if (source === undefined || !Array.isArray(source.stages)) return undefined
  const summary = semanticText(source.summary, 8_000)
  const stages = source.stages.slice(0, 8).map(parseStoryStage)
  return summary === undefined || stages.some(stage => stage === undefined)
    ? undefined
    : { summary, stages: stages as AiStoryStageEnhancement[] }
}

function parseEvaluationItem(value: unknown): AiEvaluationEnhancement | undefined {
  const source = object(value)
  if (source === undefined) return undefined
  const evaluationId = source.evaluationId
  if (evaluationId !== 'outcome' && evaluationId !== 'reliability'
    && evaluationId !== 'recovery' && evaluationId !== 'efficiency'
    && evaluationId !== 'observability') return undefined
  const label = semanticText(source.label)
  const summary = semanticText(source.summary)
  const strengths = semanticStrings(source.strengths)
  const risks = semanticStrings(source.risks)
  const ids = evidenceIds(source.evidenceRecordIds)
  return label === undefined || summary === undefined || strengths === undefined
    || risks === undefined || ids === undefined
    ? undefined
    : { evaluationId, label, summary, strengths, risks, evidenceRecordIds: ids }
}

function parseEvaluations(value: unknown): AiEvaluationEnhancement[] | undefined {
  if (!Array.isArray(value) || value.length > 5) return undefined
  const selected = value.map(parseEvaluationItem)
  return selected.some(item => item === undefined)
    ? undefined
    : selected as AiEvaluationEnhancement[]
}

export function parseAiOptimization(value: unknown): AiOptimization | undefined {
  const source = object(value)
  if (source === undefined
    || typeof source.findingId !== 'string' || source.findingId.length > 500
    || !OPTIMIZATION_CATEGORIES.includes(source.category as AiOptimization['category'])
    || !Array.isArray(source.measures) || source.measures.length === 0
    || source.measures.length > 3
    || source.measures.some(item => !OPTIMIZATION_MEASURES.includes(item))
    || !Array.isArray(source.evidenceRecordIds) || source.evidenceRecordIds.length === 0
    || source.evidenceRecordIds.length > 32
    || source.evidenceRecordIds.some(item => typeof item !== 'string' || item.trim() === '')
    || !Array.isArray(source.executionActions)
    || source.executionActions.length === 0
    || source.executionActions.length > 4) {
    return undefined
  }
  const fields: Partial<Record<typeof OPTIMIZATION_TEXT_FIELDS[number], string>> = {}
  try {
    for (const key of OPTIMIZATION_TEXT_FIELDS) {
      const selected = semanticText(source[key], 1_200)
      if (selected === undefined) return undefined
      fields[key] = selected
    }
  } catch {
    return undefined
  }
  const executionActions = source.executionActions.map((value) => {
    const action = object(value)
    if (action === undefined
      || !OPTIMIZATION_ACTION_KINDS.includes(
        action.kind as OptimizationExecutionAction['kind'],
      )) return undefined
    const title = text(action.title, 500)
    const target = text(action.target, 1_000)
    const instruction = text(action.instruction, 2_000)
    const content = text(action.content, 8_000)
    const verification = text(action.verification, 2_000)
    return title === undefined || target === undefined
      || instruction === undefined || content === undefined
      || verification === undefined
      ? undefined
      : {
          kind: action.kind as OptimizationExecutionAction['kind'],
          title,
          target,
          instruction,
          content,
          verification,
        }
  })
  if (executionActions.some(action => action === undefined)) return undefined
  return {
    ...fields as Pick<AiOptimization, typeof OPTIMIZATION_TEXT_FIELDS[number]>,
    findingId: source.findingId,
    category: source.category as AiOptimization['category'],
    measures: [...new Set(source.measures)] as AiOptimization['measures'],
    evidenceRecordIds: [...new Set(source.evidenceRecordIds)] as string[],
    executionActions: executionActions as OptimizationExecutionAction[],
  }
}

function parseOptimizations(value: unknown): AiOptimization[] | undefined {
  if (!Array.isArray(value) || value.length > 8) return undefined
  const selected = value.map(parseAiOptimization)
  return selected.some(item => item === undefined)
    ? undefined
    : selected as AiOptimization[]
}

function evidenceRequest(value: unknown): AiEvidenceRequest | undefined {
  const source = object(value)
  if (source === undefined) return undefined
  const recordId = text(source.recordId, 300)
  const reason = text(source.reason, 1_000)
  return recordId === undefined || reason === undefined
    ? undefined
    : { recordId, reason }
}

function jsonText(value: string): string {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  return fenced?.trim() ?? value.trim()
}

export function parseAiEnhancementDraft(
  value: unknown,
  modules: readonly AiEnhancementModule[],
): AiEnhancementDraft {
  const parsed = typeof value === 'string'
    ? JSON.parse(jsonText(value)) as unknown
    : value
  const source = object(parsed)
  if (source === undefined) throw new Error('AI enhancement response must be a JSON object')
  const requests = Array.isArray(source.evidenceRequests)
    ? source.evidenceRequests.slice(0, 24).map(evidenceRequest)
    : undefined
  if (requests === undefined || requests.some(item => item === undefined)) {
    throw new Error('AI enhancement response has invalid evidence requests')
  }
  const result: AiEnhancementDraft = {
    evidenceRequests: requests as AiEvidenceRequest[],
  }
  for (const module of modules) {
    const selected = module === 'outcome' ? parseOutcome(source.outcome)
      : module === 'objective' ? parseObjective(source.objective)
      : module === 'story' ? parseStory(source.story)
      : module === 'evaluation' ? parseEvaluations(source.evaluation)
      : parseOptimizations(source.optimization)
    if (selected === undefined) {
      throw new Error(`AI enhancement response is missing or invalid: ${module}`)
    }
    Object.assign(result, { [module]: selected })
  }
  return result
}
