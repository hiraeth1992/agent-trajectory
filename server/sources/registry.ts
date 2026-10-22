import type {
  SessionDetail,
  SessionSummary,
  SourceId,
  SourceStatus,
} from '../../src/types'
import { jsonWeight, WeightedLruCache } from '../lru'
import { codexSource } from './codex'
import { dshSource } from './dsh'
import {
  capabilities,
  sourceMetadata,
  type SessionSource,
  type SourceSessionRef,
} from './types'
import { zcodeSource } from './zcode'

interface TimedValue<T> {
  expiresAt: number
  value: Promise<T>
}

interface DetailCacheEntry {
  fingerprint: string
  detail: SessionDetail
}

interface SourceRegistryOptions {
  detailCacheEntries?: number
  detailCacheBytes?: number
}

const CACHE_WINDOW_MS = 1_000
const MISSING_WINDOW_MS = 5_000
const DEFAULT_DETAIL_CACHE_ENTRIES = 16
const DEFAULT_DETAIL_CACHE_BYTES = 128 * 1024 * 1024

function failedStatus(source: SessionSource, _error: unknown): SourceStatus {
  return {
    source: source.id,
    availability: 'blocked',
    ...sourceMetadata(source.id),
    sessionCount: 0,
    capabilities: capabilities(),
    reason: 'probe_failed',
    detail: '来源探针失败；其他来源仍可继续使用',
  }
}

export class SourceRegistry {
  private readonly sources: ReadonlyMap<SourceId, SessionSource>
  private readonly refCache = new Map<SourceId, TimedValue<readonly SourceSessionRef[]>>()
  private readonly knownRefs = new Map<SourceId, Map<string, SourceSessionRef>>()
  private readonly missingRefs = new Map<string, number>()
  private statusCache?: TimedValue<SourceStatus[]>
  private readonly detailCache: WeightedLruCache<string, DetailCacheEntry>

  constructor(
    sources: readonly SessionSource[],
    options: SourceRegistryOptions = {},
  ) {
    this.sources = new Map(sources.map(source => [source.id, source]))
    this.detailCache = new WeightedLruCache({
      maxEntries: options.detailCacheEntries ?? DEFAULT_DETAIL_CACHE_ENTRIES,
      maxWeight: options.detailCacheBytes ?? DEFAULT_DETAIL_CACHE_BYTES,
      weight: entry => jsonWeight(entry.detail),
    })
  }

  private source(id: SourceId): SessionSource {
    const source = this.sources.get(id)
    if (source === undefined) throw new Error(`unknown session source: ${id}`)
    return source
  }

  private refs(id: SourceId, fresh = false): Promise<readonly SourceSessionRef[]> {
    const now = Date.now()
    const cached = this.refCache.get(id)
    if (!fresh && cached !== undefined && cached.expiresAt > now) return cached.value
    const value = this.source(id).list().then(refs => {
      this.knownRefs.set(id, new Map(refs.map(ref => [ref.sourceSessionId, ref])))
      for (const ref of refs) this.missingRefs.delete(`${id}:${ref.sourceSessionId}`)
      return refs
    })
    this.refCache.set(id, { expiresAt: now + CACHE_WINDOW_MS, value })
    return value
  }

  async listSources(fresh = false): Promise<SourceStatus[]> {
    const now = Date.now()
    if (!fresh && this.statusCache !== undefined && this.statusCache.expiresAt > now) {
      return this.statusCache.value
    }
    const value = Promise.all([...this.sources.values()].map(async (source) => {
      try {
        const status = await source.probe()
        if (status.availability === 'blocked') return status
        try {
          const refs = await this.refs(source.id, fresh)
          return { ...status, sessionCount: refs.length }
        } catch {
          return {
            ...status,
            availability: 'degraded' as const,
            sessionCount: 0,
            reason: 'list_failed',
            detail: '会话列表读取失败',
          }
        }
      } catch (error) {
        return failedStatus(source, error)
      }
    }))
    this.statusCache = { expiresAt: now + CACHE_WINDOW_MS, value }
    return value
  }

  async listSessions(source: SourceId | 'all' = 'all'): Promise<SessionSummary[]> {
    const statuses = await this.listSources()
    const enabled = statuses
      .filter(status => status.availability !== 'blocked')
      .filter(status => source === 'all' || status.source === source)
    const settled = await Promise.allSettled(enabled.map(status => this.refs(status.source)))
    return settled
      .flatMap(result => result.status === 'fulfilled' ? result.value.map(ref => ref.summary) : [])
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private async ref(source: SourceId, sourceSessionId: string): Promise<SourceSessionRef | undefined> {
    const missingUntil = this.missingRefs.get(`${source}:${sourceSessionId}`)
    if (missingUntil !== undefined) {
      if (missingUntil > Date.now()) return undefined
      this.missingRefs.delete(`${source}:${sourceSessionId}`)
    }
    const known = this.knownRefs.get(source)?.get(sourceSessionId)
    if (known !== undefined) return known
    return (await this.refs(source, true)).find(
      candidate => candidate.sourceSessionId === sourceSessionId,
    )
  }

  async load(source: SourceId, sourceSessionId: string): Promise<SessionDetail | undefined> {
    const adapter = this.source(source)
    const ref = await this.ref(source, sourceSessionId)
    if (ref === undefined) return undefined
    const key = `${source}:${sourceSessionId}`
    const loadRef = async (candidate: SourceSessionRef): Promise<SessionDetail> => {
      const fingerprint = await adapter.fingerprint(candidate)
      const cached = this.detailCache.get(key)
      if (cached?.fingerprint === fingerprint) return cached.detail
      const detail = await adapter.load(candidate)
      this.detailCache.set(key, { fingerprint, detail })
      return detail
    }
    try {
      return await loadRef(ref)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.knownRefs.get(source)?.delete(sourceSessionId)
      const refreshed = (await this.refs(source, true)).find(
        candidate => candidate.sourceSessionId === sourceSessionId,
      )
      if (refreshed === undefined) {
        this.missingRefs.set(key, Date.now() + MISSING_WINDOW_MS)
        this.detailCache.delete(key)
        return undefined
      }
      this.missingRefs.delete(key)
      return loadRef(refreshed)
    }
  }

  async raw(
    source: SourceId,
    sourceSessionId: string,
    recordId: string,
  ): Promise<unknown[] | undefined> {
    const detail = await this.load(source, sourceSessionId)
    return detail?.projection.records.find(record => record.id === recordId)?.raw
  }

  async fingerprint(source: SourceId, sourceSessionId: string): Promise<string | undefined> {
    const adapter = this.source(source)
    const ref = await this.ref(source, sourceSessionId)
    if (ref === undefined) return undefined
    try {
      return await adapter.fingerprint(ref)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.knownRefs.get(source)?.delete(sourceSessionId)
      const refreshed = (await this.refs(source, true)).find(
        candidate => candidate.sourceSessionId === sourceSessionId,
      )
      if (refreshed === undefined) {
        this.missingRefs.set(`${source}:${sourceSessionId}`, Date.now() + MISSING_WINDOW_MS)
        this.detailCache.delete(`${source}:${sourceSessionId}`)
        return undefined
      }
      this.missingRefs.delete(`${source}:${sourceSessionId}`)
      return adapter.fingerprint(refreshed)
    }
  }
}

export const sourceRegistry = new SourceRegistry([
  dshSource,
  codexSource,
  zcodeSource,
])
