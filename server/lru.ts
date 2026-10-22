export interface LruOptions<K, V> {
  maxEntries: number
  maxWeight: number
  weight: (value: V, key: K) => number
}

interface LruEntry<V> {
  value: V
  weight: number
}

export class WeightedLruCache<K, V> {
  private readonly entries = new Map<K, LruEntry<V>>()
  private totalWeight = 0

  constructor(private readonly options: LruOptions<K, V>) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new Error('LRU maxEntries must be a positive integer')
    }
    if (!Number.isFinite(options.maxWeight) || options.maxWeight <= 0) {
      throw new Error('LRU maxWeight must be positive')
    }
  }

  get size(): number {
    return this.entries.size
  }

  get weight(): number {
    return this.totalWeight
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  peek(key: K): V | undefined {
    return this.entries.get(key)?.value
  }

  set(key: K, value: V): this {
    this.delete(key)
    const weight = Math.max(0, this.options.weight(value, key))
    this.entries.set(key, { value, weight })
    this.totalWeight += weight
    this.evict()
    return this
  }

  delete(key: K): boolean {
    const entry = this.entries.get(key)
    if (entry === undefined) return false
    this.entries.delete(key)
    this.totalWeight -= entry.weight
    return true
  }

  clear(): void {
    this.entries.clear()
    this.totalWeight = 0
  }

  private evict(): void {
    while (this.entries.size > this.options.maxEntries
      || this.totalWeight > this.options.maxWeight) {
      const oldest = this.entries.keys().next().value as K | undefined
      if (oldest === undefined) break
      this.delete(oldest)
    }
  }
}

export function jsonWeight(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value))
  } catch {
    return 1
  }
}
