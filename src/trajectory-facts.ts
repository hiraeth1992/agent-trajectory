import { createHash } from 'node:crypto'
import type {
  AiEnhancementModule,
  SummaryFactPackage,
  SummaryPreview,
} from './ai-summary-types'
import type { TrajectoryAnalysis } from './trajectory-analysis'
import { buildTrajectoryStory } from './trajectory-story'
import type { SessionDetail } from './types'
import { redactSensitive } from './projector-utils'

function includes(
  modules: readonly AiEnhancementModule[],
  ...selected: AiEnhancementModule[]
): boolean {
  return selected.some(module => modules.includes(module))
}

export function buildSummaryFacts(
  detail: SessionDetail,
  analysis: TrajectoryAnalysis,
  modules: AiEnhancementModule[],
): SummaryFactPackage {
  const needsSteps = includes(modules, 'outcome', 'objective', 'story', 'evaluation', 'optimization')
  const needsCorrections = includes(modules, 'outcome', 'story', 'evaluation', 'optimization')
  return redactSensitive({
    schemaVersion: 2,
    source: detail.summary.source,
    sourceSessionId: detail.summary.sourceSessionId,
    modules,
    sessionProvider: detail.projection.header.provider,
    sessionModel: detail.projection.header.model,
    localFacts: analysis.stats,
    objective: includes(modules, 'outcome', 'objective', 'story')
      ? {
          objective: analysis.objective,
          objectiveLabel: analysis.objectiveLabel,
        }
      : undefined,
    outcome: includes(modules, 'outcome', 'evaluation')
      ? analysis.outcome
      : undefined,
    steps: needsSteps ? analysis.steps.map(step => ({
      id: step.id,
      turn: step.turn,
      step: step.step,
      action: step.action,
      rationale: step.reason,
      rationaleLevel: step.reasonLevel,
      execution: step.execution,
      outcome: step.result,
      status: step.status,
      localFacts: {
        durationMs: step.durationMs,
        usage: step.usage,
      },
      evidenceRecordIds: step.recordIds,
    })) : [],
    corrections: needsCorrections ? analysis.corrections.map(correction => ({
      id: correction.id,
      trigger: correction.trigger,
      diagnosis: correction.diagnosis,
      adjustment: correction.change,
      outcome: correction.result,
      confidence: correction.confidence,
      evidenceRecordIds: correction.recordIds,
    })) : [],
    story: modules.includes('story') ? buildTrajectoryStory(analysis) : undefined,
    evaluations: modules.includes('evaluation') ? analysis.evaluations : undefined,
    optimizations: modules.includes('optimization')
      ? analysis.optimizations ?? []
      : undefined,
  }) as SummaryFactPackage
}

export function summaryFactsHash(facts: SummaryFactPackage): string {
  return createHash('sha256')
    .update(JSON.stringify(facts))
    .digest('base64url')
}

export function estimateSummaryInputTokens(facts: SummaryFactPackage): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(facts), 'utf8') / 3)
}

export function buildSummaryPreview(
  detail: SessionDetail,
  analysis: TrajectoryAnalysis,
  modules: AiEnhancementModule[],
): SummaryPreview {
  const facts = buildSummaryFacts(detail, analysis, modules)
  const factsHashes = Object.fromEntries(modules.map(module => [
    module,
    summaryFactsHash(buildSummaryFacts(detail, analysis, [module])),
  ])) as SummaryPreview['factsHashes']
  return {
    modules,
    facts,
    factsHashes,
    estimatedInputTokens: estimateSummaryInputTokens(facts),
    factStepCount: facts.steps.length,
  }
}
