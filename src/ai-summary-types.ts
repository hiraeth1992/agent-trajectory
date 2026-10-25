import type {
  AnalysisConfidence,
  AnalysisEvaluation,
  TrajectoryAnalysis,
} from './trajectory-analysis'
import type { SourceId, TokenUsage } from './types'
import type { AiOptimization, OptimizationSuggestion } from './trajectory-optimization'
import type { TrajectoryStory } from './trajectory-story'

export const AI_ENHANCEMENT_MODULES = [
  'outcome',
  'objective',
  'story',
  'evaluation',
  'optimization',
] as const

export type AiEnhancementModule = typeof AI_ENHANCEMENT_MODULES[number]

export const AI_ENHANCEMENT_MODULE_LABELS: Record<AiEnhancementModule, string> = {
  outcome: '执行结论',
  objective: '会话目标',
  story: '执行故事线',
  evaluation: '过程评测',
  optimization: '优化建议',
}

export type SummaryAdapterType = 'codex-app-server' | 'openai-compatible'

export interface SummaryModel {
  adapterId: string
  adapterType: SummaryAdapterType
  id: string
  label: string
  provider?: string
  isDefault?: boolean
}

export interface SummaryAdapterStatus {
  id: string
  type: SummaryAdapterType
  label: string
  available: boolean
  reason?: string
  models: SummaryModel[]
}

export interface SummaryModelSelection {
  adapterId: string
  model: string
}

export interface HiddenSummaryModel extends SummaryModelSelection {
  label: string
  adapterType: SummaryAdapterType
}

export interface SummaryModelMapping {
  source: SourceId
  sessionProvider?: string
  sessionModel?: string
  selection: SummaryModelSelection
}

export interface OpenAiCompatibleConfig {
  id: string
  type: 'openai-compatible'
  label: string
  baseUrl: string
  model: string
  structuredOutputMode?: 'auto' | 'json-schema' | 'json-object'
  apiKeyEnv?: string
  hasCredential?: boolean
}

export interface SummarySettings {
  defaultSelection?: SummaryModelSelection
  mappings: SummaryModelMapping[]
  openAiCompatible: OpenAiCompatibleConfig[]
  hiddenModels?: HiddenSummaryModel[]
  lastModules: AiEnhancementModule[]
}

export interface SummaryFactStep {
  id: string
  turn: number
  step: number
  action: string
  rationale: string
  rationaleLevel: 'fact' | 'inferred' | 'unknown'
  execution: string
  outcome: string
  status: string
  localFacts: {
    durationMs: number | null
    usage?: TokenUsage
  }
  evidenceRecordIds: string[]
}

export interface SummaryFactCorrection {
  id: string
  trigger: string
  diagnosis: string
  adjustment: string
  outcome: string
  confidence: AnalysisConfidence
  evidenceRecordIds: string[]
}

export interface SummaryFactPackage {
  schemaVersion: 2
  source: SourceId
  sourceSessionId: string
  modules: AiEnhancementModule[]
  sessionProvider?: string
  sessionModel?: string
  localFacts: TrajectoryAnalysis['stats']
  objective?: Pick<TrajectoryAnalysis, 'objective' | 'objectiveLabel'>
  outcome?: TrajectoryAnalysis['outcome']
  steps: SummaryFactStep[]
  corrections: SummaryFactCorrection[]
  story?: TrajectoryStory
  evaluations?: AnalysisEvaluation[]
  optimizations?: OptimizationSuggestion[]
}

export interface AiOutcomeEnhancement {
  headline: string
  summary: string
  verification: string
  unresolved: string[]
  evidenceRecordIds: string[]
}

export interface AiObjectiveEnhancement {
  statement: string
  successCriteria: string[]
  constraints: string[]
  evolution: string
  evidenceRecordIds: string[]
}

export interface AiStoryStageEnhancement {
  stageId: string
  title: string
  judgment: string
  actions: string[]
  outcome: string
  evidenceRecordIds: string[]
}

export interface AiStoryEnhancement {
  summary: string
  stages: AiStoryStageEnhancement[]
}

export interface AiEvaluationEnhancement {
  evaluationId: AnalysisEvaluation['id']
  label: string
  summary: string
  strengths: string[]
  risks: string[]
  evidenceRecordIds: string[]
}

export interface AiEvidenceRequest {
  recordId: string
  reason: string
}

export interface AiEnhancementResultMap {
  outcome: AiOutcomeEnhancement
  objective: AiObjectiveEnhancement
  story: AiStoryEnhancement
  evaluation: AiEvaluationEnhancement[]
  optimization: AiOptimization[]
}

export type AiEnhancementDraft = Partial<AiEnhancementResultMap> & {
  evidenceRequests: AiEvidenceRequest[]
}

export interface AiEnhancementModuleEntry<T> {
  value: T
  generatedAt: number
  factsHash: string
  adapterId: string
  model: string
  promptVersion: number
}

export type AiEnhancementModuleEntries = {
  [K in AiEnhancementModule]?: AiEnhancementModuleEntry<AiEnhancementResultMap[K]>
}

export interface ValidatedAiSummary {
  modules: AiEnhancementModuleEntries
  lastRun: {
    modules: AiEnhancementModule[]
    generatedAt: number
    adapterId: string
    model: string
    promptVersion: number
  }
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
  durationMs: number
}

export interface AiSummaryOptions {
  source: SourceId
  sourceSessionId: string
  sessionProvider?: string
  sessionModel?: string
  sessionModelAvailability: 'direct' | 'mapped' | 'fallback' | 'unknown'
  sessionModelReason?: string
  adapters: SummaryAdapterStatus[]
  selected?: SummaryModelSelection
  selectedReason: 'exact-session-model' | 'remembered' | 'default' | 'unavailable'
  selectedModules: AiEnhancementModule[]
  cached?: ValidatedAiSummary
  cacheStatus: 'current' | 'stale' | 'missing'
  moduleStatus: Record<AiEnhancementModule, 'current' | 'stale' | 'missing'>
  factsHashes: Record<AiEnhancementModule, string>
  factStepCount: number
  estimatedInputTokens: number
}

export interface AiSummaryGenerateRequest {
  adapterId: string
  model: string
  remember: boolean
  modules: AiEnhancementModule[]
}

export type AiSummaryGenerationStage =
  | 'preparing'
  | 'generating'
  | 'repairing'
  | 'evidence'
  | 'validating'
  | 'saving'

export interface AiSummaryGenerationProgress {
  stage: AiSummaryGenerationStage
  message: string
}

export type AiSummaryGenerationEvent =
  | ({ type: 'progress' } & AiSummaryGenerationProgress)
  | { type: 'result'; summary: ValidatedAiSummary }
  | { type: 'error'; error: string }

export interface SummaryPreview {
  modules: AiEnhancementModule[]
  factsHashes: Record<AiEnhancementModule, string>
  estimatedInputTokens: number
  factStepCount: number
  facts: SummaryFactPackage
}
