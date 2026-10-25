import type {
  AiEnhancementModule,
  AiEnhancementResultMap,
  AiSummaryOptions,
  ValidatedAiSummary,
} from './ai-summary-types'
import type { TrajectoryStory } from './trajectory-story'

export function currentEnhancement<K extends AiEnhancementModule>(
  summary: ValidatedAiSummary | undefined,
  status: AiSummaryOptions['moduleStatus'] | undefined,
  module: K,
): AiEnhancementResultMap[K] | undefined {
  if (status?.[module] !== 'current') return undefined
  const entry = summary?.modules[module]
  return entry?.value as AiEnhancementResultMap[K] | undefined
}

export function enhanceStory(
  local: TrajectoryStory,
  enhancement: AiEnhancementResultMap['story'] | undefined,
): TrajectoryStory {
  if (enhancement === undefined) return local
  const enhanced = new Map(enhancement.stages.map(stage => [stage.stageId, stage]))
  return {
    ...local,
    stages: local.stages.map(stage => {
      const selected = enhanced.get(stage.id)
      return selected === undefined
        ? stage
        : {
            ...stage,
            title: selected.title,
            judgment: selected.judgment,
            actions: selected.actions,
            outcome: selected.outcome,
            summary: selected.outcome,
          }
    }),
  }
}
