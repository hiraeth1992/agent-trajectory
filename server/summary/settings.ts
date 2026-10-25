import { promises as fs } from 'node:fs'
import type {
  AiEnhancementModule,
  HiddenSummaryModel,
  OpenAiCompatibleConfig,
  SummaryModelMapping,
  SummaryModelSelection,
  SummarySettings,
} from '../../src/ai-summary-types'
import { AI_ENHANCEMENT_MODULES } from '../../src/ai-summary-types'
import type { SourceId } from '../../src/types'
import { SerialTransaction, writePrivateJson } from './file-transaction'
import type { SummarySecretStore } from './types'

const SETTINGS_VERSION = 2

interface StoredSummarySettings {
  version: number
  defaultSelection?: SummaryModelSelection
  mappings: SummaryModelMapping[]
  openAiCompatible: Array<Omit<OpenAiCompatibleConfig, 'hasCredential'>>
  hiddenModels: HiddenSummaryModel[]
  lastModules: AiEnhancementModule[]
}

function cleanString(value: unknown, maxLength = 500): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim()
  return cleaned === '' || cleaned.length > maxLength ? undefined : cleaned
}

function cleanSelection(value: unknown): SummaryModelSelection | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const adapterId = cleanString(source.adapterId, 120)
  const model = cleanString(source.model, 240)
  return adapterId === undefined || model === undefined
    ? undefined
    : { adapterId, model }
}

function cleanSource(value: unknown): SourceId | undefined {
  return value === 'dsh' || value === 'codex' || value === 'zcode'
    ? value
    : undefined
}

function cleanMapping(value: unknown): SummaryModelMapping | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const sessionSource = cleanSource(source.source)
  const selection = cleanSelection(source.selection)
  if (sessionSource === undefined || selection === undefined) return undefined
  return {
    source: sessionSource,
    sessionProvider: cleanString(source.sessionProvider, 240),
    sessionModel: cleanString(source.sessionModel, 240),
    selection,
  }
}

function normalizeBaseUrl(value: unknown): string | undefined {
  const text = cleanString(value, 1_000)
  if (text === undefined) return undefined
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  const loopback = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return undefined
  }
  return url.href.replace(/\/+$/, '')
}

function cleanCompatible(
  value: unknown,
): Omit<OpenAiCompatibleConfig, 'hasCredential'> | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const id = cleanString(source.id, 120)
  const label = cleanString(source.label, 120)
  const baseUrl = normalizeBaseUrl(source.baseUrl)
  const model = cleanString(source.model, 240)
  if (id === undefined || label === undefined || baseUrl === undefined || model === undefined) {
    return undefined
  }
  return {
    id,
    type: 'openai-compatible',
    label,
    baseUrl,
    model,
    structuredOutputMode: source.structuredOutputMode === 'json-schema'
      || source.structuredOutputMode === 'json-object'
      || source.structuredOutputMode === 'auto'
      ? source.structuredOutputMode
      : undefined,
    apiKeyEnv: cleanString(source.apiKeyEnv, 120),
  }
}

function cleanHiddenModel(value: unknown): HiddenSummaryModel | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const selection = cleanSelection(source)
  const label = cleanString(source.label, 240)
  const adapterType = source.adapterType === 'codex-app-server'
    || source.adapterType === 'openai-compatible'
    ? source.adapterType
    : undefined
  return selection === undefined || label === undefined || adapterType === undefined
    ? undefined
    : { ...selection, label, adapterType }
}

function sameModel(
  left: SummaryModelSelection,
  right: SummaryModelSelection,
): boolean {
  return left.adapterId === right.adapterId && left.model === right.model
}

function cleanModules(value: unknown): AiEnhancementModule[] {
  if (!Array.isArray(value)) return [...AI_ENHANCEMENT_MODULES]
  const selected = AI_ENHANCEMENT_MODULES.filter(module => value.includes(module))
  return selected.length === 0 ? [...AI_ENHANCEMENT_MODULES] : selected
}

function normalizeStored(value: unknown): StoredSummarySettings {
  const source = value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
  return {
    version: SETTINGS_VERSION,
    defaultSelection: cleanSelection(source.defaultSelection),
    mappings: Array.isArray(source.mappings)
      ? source.mappings.flatMap(item => {
          const mapping = cleanMapping(item)
          return mapping === undefined ? [] : [mapping]
        })
      : [],
    openAiCompatible: Array.isArray(source.openAiCompatible)
      ? source.openAiCompatible.flatMap(item => {
          const config = cleanCompatible(item)
          return config === undefined ? [] : [config]
        })
      : [],
    hiddenModels: Array.isArray(source.hiddenModels)
      ? source.hiddenModels.flatMap(item => {
          const hidden = cleanHiddenModel(item)
          return hidden === undefined ? [] : [hidden]
        })
      : [],
    lastModules: cleanModules(source.lastModules),
  }
}

function readStored(value: unknown): StoredSummarySettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid summary settings: expected an object')
  }
  const source = value as Record<string, unknown>
  if (!Number.isInteger(source.version) || (source.version as number) < 1) {
    throw new Error('invalid summary settings version')
  }
  const version = source.version as number
  if (version > SETTINGS_VERSION) {
    throw new Error(
      `summary settings version ${version} is newer than supported version ${SETTINGS_VERSION}`,
    )
  }
  if (version < SETTINGS_VERSION) {
    throw new Error(
      `summary settings version ${version} requires migration to version ${SETTINGS_VERSION}`,
    )
  }
  return normalizeStored(source)
}

export class SummarySettingsStore {
  private cached?: StoredSummarySettings
  private readonly transaction = new SerialTransaction()

  constructor(
    private readonly file: string,
    private readonly secrets: SummarySecretStore,
  ) {}

  private async stored(): Promise<StoredSummarySettings> {
    if (this.cached !== undefined) return this.cached
    try {
      this.cached = readStored(JSON.parse(await fs.readFile(this.file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.cached = normalizeStored(undefined)
    }
    return this.cached
  }

  private async write(value: StoredSummarySettings): Promise<void> {
    await writePrivateJson(this.file, value)
    this.cached = value
  }

  private async materialize(stored: StoredSummarySettings): Promise<SummarySettings> {
    const compatible = await Promise.all(stored.openAiCompatible.map(async config => ({
      ...config,
      hasCredential: config.apiKeyEnv !== undefined
        ? process.env[config.apiKeyEnv] !== undefined
        : await this.secrets.get(config.id) !== undefined,
    })))
    return {
      defaultSelection: stored.defaultSelection,
      mappings: stored.mappings,
      openAiCompatible: compatible,
      hiddenModels: stored.hiddenModels,
      lastModules: stored.lastModules,
    }
  }

  async read(): Promise<SummarySettings> {
    return this.transaction.run(async () => this.materialize(await this.stored()))
  }

  async update(value: unknown): Promise<SummarySettings> {
    return this.transaction.run(async () => {
      const current = await this.stored()
      const next = normalizeStored(value)
      if (value === null || typeof value !== 'object'
        || !Object.prototype.hasOwnProperty.call(value, 'lastModules')) {
        next.lastModules = current.lastModules
      }
      await this.write(next)
      return this.materialize(next)
    })
  }

  async setCredential(id: string, value: string | undefined): Promise<void> {
    await this.transaction.run(async () => {
      const config = (await this.stored()).openAiCompatible.find(item => item.id === id)
      if (config === undefined) throw new Error('unknown summary adapter')
      if (value === undefined || value.trim() === '') await this.secrets.delete(id)
      else await this.secrets.set(id, value.trim())
    })
  }

  async removeModel(model: HiddenSummaryModel): Promise<SummarySettings> {
    return this.transaction.run(async () => {
      const stored = await this.stored()
      const custom = stored.openAiCompatible.find(config =>
        config.id === model.adapterId && config.model === model.model)
      const removing = { adapterId: model.adapterId, model: model.model }
      const next = {
        ...stored,
        defaultSelection: stored.defaultSelection !== undefined
          && sameModel(stored.defaultSelection, removing)
          ? undefined
          : stored.defaultSelection,
        mappings: stored.mappings.filter(mapping =>
          !sameModel(mapping.selection, removing)),
        openAiCompatible: stored.openAiCompatible.filter(config =>
          config.id !== model.adapterId || config.model !== model.model),
        hiddenModels: custom === undefined
          ? [
              ...stored.hiddenModels.filter(hidden => !sameModel(hidden, removing)),
              model,
            ]
          : stored.hiddenModels.filter(hidden => !sameModel(hidden, removing)),
      }
      await this.write(next)
      if (custom !== undefined) await this.secrets.delete(custom.id)
      return this.materialize(next)
    })
  }

  async restoreModel(selection: SummaryModelSelection): Promise<SummarySettings> {
    return this.transaction.run(async () => {
      const stored = await this.stored()
      const next = {
        ...stored,
        hiddenModels: stored.hiddenModels.filter(hidden =>
          !sameModel(hidden, selection)),
      }
      await this.write(next)
      return this.materialize(next)
    })
  }

  async remember(
    source: SourceId,
    sessionProvider: string | undefined,
    sessionModel: string | undefined,
    selection: SummaryModelSelection,
  ): Promise<void> {
    await this.transaction.run(async () => {
      const stored = await this.stored()
      const matches = (mapping: SummaryModelMapping) =>
        mapping.source === source
        && mapping.sessionProvider === sessionProvider
        && mapping.sessionModel === sessionModel
      await this.write({
        ...stored,
        mappings: [
          ...stored.mappings.filter(mapping => !matches(mapping)),
          { source, sessionProvider, sessionModel, selection },
        ],
      })
    })
  }

  async rememberRun(
    source: SourceId,
    selection: SummaryModelSelection,
    modules: AiEnhancementModule[],
  ): Promise<void> {
    await this.transaction.run(async () => {
      const stored = await this.stored()
      const matches = (mapping: SummaryModelMapping) =>
        mapping.source === source
        && mapping.sessionProvider === undefined
        && mapping.sessionModel === undefined
      await this.write({
        ...stored,
        lastModules: cleanModules(modules),
        mappings: [
          ...stored.mappings.filter(mapping => !matches(mapping)),
          { source, selection },
        ],
      })
    })
  }
}
