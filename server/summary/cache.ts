import { promises as fs } from 'node:fs'
import type { ValidatedAiSummary } from '../../src/ai-summary-types'
import { SerialTransaction, writePrivateJson } from './file-transaction'

interface CacheEntry {
  source: string
  sourceSessionId: string
  summary: ValidatedAiSummary
}

const MAX_ENTRIES = 128
const MAX_BYTES = 16 * 1024 * 1024

export class SummaryCache {
  private loaded = false
  private readonly entries = new Map<string, CacheEntry>()
  private readonly transaction = new SerialTransaction()

  constructor(private readonly file: string) {}

  private key(source: string, sourceSessionId: string): string {
    return `${source}:${sourceSessionId}`
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown
      if (!Array.isArray(parsed)) return
      for (const value of parsed) {
        if (value === null || typeof value !== 'object') continue
        const item = value as Partial<CacheEntry>
        if (typeof item.source !== 'string'
          || typeof item.sourceSessionId !== 'string'
          || item.summary === undefined) continue
        this.remember(
          this.entries,
          this.key(item.source, item.sourceSessionId),
          item as CacheEntry,
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    } finally {
      this.loaded = true
    }
  }

  async get(source: string, sourceSessionId: string): Promise<ValidatedAiSummary | undefined> {
    return this.transaction.run(async () => {
      await this.load()
      const key = this.key(source, sourceSessionId)
      const entry = this.entries.get(key)
      if (entry === undefined) return undefined
      this.entries.delete(key)
      this.entries.set(key, entry)
      return entry.summary
    })
  }

  async set(
    source: string,
    sourceSessionId: string,
    summary: ValidatedAiSummary,
  ): Promise<void> {
    await this.transaction.run(async () => {
      await this.load()
      const next = new Map(this.entries)
      this.remember(next, this.key(source, sourceSessionId), {
        source,
        sourceSessionId,
        summary,
      })
      await this.persist(next)
      this.entries.clear()
      for (const [key, entry] of next) this.entries.set(key, entry)
    })
  }

  private remember(
    entries: Map<string, CacheEntry>,
    key: string,
    entry: CacheEntry,
  ): void {
    entries.delete(key)
    entries.set(key, entry)
    while (entries.size > MAX_ENTRIES
      || Buffer.byteLength(JSON.stringify([...entries.values()])) > MAX_BYTES) {
      const oldest = entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }

  private async persist(entries: Map<string, CacheEntry>): Promise<void> {
    await writePrivateJson(this.file, [...entries.values()])
  }
}
