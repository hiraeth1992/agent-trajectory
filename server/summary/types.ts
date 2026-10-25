import type {
  AiEnhancementDraft,
  AiEnhancementModule,
  AiSummaryGenerationProgress,
  SummaryAdapterStatus,
  SummaryModel,
} from '../../src/ai-summary-types'

export interface SummaryCompletionRequest {
  model: string
  prompt: string
  modules: AiEnhancementModule[]
  outputSchema: Record<string, unknown>
  signal?: AbortSignal
  onProgress?: (progress: AiSummaryGenerationProgress) => void
}

export interface SummaryCompletionResponse {
  draft: AiEnhancementDraft
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
}

export interface SummaryModelAdapter {
  readonly id: string
  status(): Promise<SummaryAdapterStatus>
  listModels(): Promise<SummaryModel[]>
  complete(request: SummaryCompletionRequest): Promise<SummaryCompletionResponse>
  close?(): Promise<void>
}

export interface SummarySecretStore {
  get(id: string): Promise<string | undefined>
  set(id: string, value: string): Promise<void>
  delete(id: string): Promise<void>
}

export class MemorySummarySecretStore implements SummarySecretStore {
  private readonly values = new Map<string, string>()

  async get(id: string): Promise<string | undefined> {
    return this.values.get(id)
  }

  async set(id: string, value: string): Promise<void> {
    this.values.set(id, value)
  }

  async delete(id: string): Promise<void> {
    this.values.delete(id)
  }
}
