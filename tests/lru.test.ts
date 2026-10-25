import { describe, expect, it } from 'vitest'
import { WeightedLruCache } from '../server/lru'

describe('weighted LRU metrics', () => {
  it('reports hits, misses, weight, and evictions without exposing keys', () => {
    const cache = new WeightedLruCache<string, string>({
      maxEntries: 2,
      maxWeight: 5,
      weight: value => value.length,
    })
    cache.set('first-private-key', 'aa')
    cache.set('second-private-key', 'bb')
    expect(cache.get('first-private-key')).toBe('aa')
    expect(cache.get('missing-private-key')).toBeUndefined()
    cache.set('third-private-key', 'ccc')

    expect(cache.metrics()).toEqual({
      entries: 2,
      weight: 5,
      hits: 1,
      misses: 1,
      sets: 3,
      evictions: 1,
    })
    expect(cache.metrics()).not.toHaveProperty('keys')
  })
})
