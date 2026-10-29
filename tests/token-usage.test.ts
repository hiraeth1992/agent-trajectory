import { describe, expect, it } from 'vitest'
import {
  exclusiveTokenBreakdown,
  nestedTokenBreakdown,
  selectedTokenTotal,
  tokenTotal,
} from '../src/token-usage'

describe('token usage semantics', () => {
  it('keeps additive cache reads visible for DSH-style usage', () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 90,
      totalTokens: 104,
    }

    expect(tokenTotal(usage)).toBe(104)
    expect(exclusiveTokenBreakdown(usage)).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: 0,
      cacheReadTokens: 90,
      cacheWriteTokens: 0,
      otherTokens: 0,
    })
  })

  it('does not double-count cache and reasoning when they are included in totals', () => {
    expect(exclusiveTokenBreakdown({
      inputTokens: 20,
      outputTokens: 8,
      cacheReadTokens: 5,
      reasoningTokens: 2,
      totalTokens: 28,
    })).toEqual({
      inputTokens: 15,
      outputTokens: 6,
      reasoningTokens: 2,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      otherTokens: 0,
    })
  })

  it('handles included cache and additive reasoning in ZCode-style usage', () => {
    expect(exclusiveTokenBreakdown({
      inputTokens: 20,
      outputTokens: 7,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
      totalTokens: 30,
    })).toEqual({
      inputTokens: 13,
      outputTokens: 7,
      reasoningTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      otherTokens: 0,
    })
  })

  it('sums only the selected exclusive token types', () => {
    const usage = {
      inputTokens: 20,
      outputTokens: 8,
      cacheReadTokens: 5,
      reasoningTokens: 2,
      totalTokens: 28,
    }

    expect(selectedTokenTotal(usage, new Set(['outputTokens']))).toBe(6)
    expect(selectedTokenTotal(
      usage,
      new Set(['outputTokens', 'reasoningTokens']),
    )).toBe(8)
    expect(selectedTokenTotal(usage, new Set(['cacheReadTokens']))).toBe(5)
  })

  it('nests included cache and reasoning without double-counting them', () => {
    expect(nestedTokenBreakdown({
      inputTokens: 49_897,
      outputTokens: 214,
      cacheReadTokens: 28_160,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 50_111,
    })).toEqual({
      totalTokens: 50_111,
      inputTokens: 49_897,
      cacheTokens: 28_160,
      outputTokens: 214,
      reasoningTokens: 0,
    })
  })

  it('nests additive cache and reasoning under inclusive parent totals', () => {
    expect(nestedTokenBreakdown({
      inputTokens: 20,
      outputTokens: 7,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
      totalTokens: 30,
    })).toEqual({
      totalTokens: 30,
      inputTokens: 20,
      cacheTokens: 7,
      outputTokens: 10,
      reasoningTokens: 3,
    })
    expect(nestedTokenBreakdown({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 90,
      totalTokens: 104,
    })).toEqual({
      totalTokens: 104,
      inputTokens: 100,
      cacheTokens: 90,
      outputTokens: 4,
      reasoningTokens: undefined,
    })
  })
})
