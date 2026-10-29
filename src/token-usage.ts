import type { TokenUsage } from './types'

export interface ExclusiveTokenBreakdown {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  otherTokens: number
}

export interface NestedTokenBreakdown {
  totalTokens?: number
  inputTokens?: number
  cacheTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

export const TOKEN_BREAKDOWN_KEYS = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'otherTokens',
] as const

export type TokenBreakdownKey = typeof TOKEN_BREAKDOWN_KEYS[number]

export function tokenTotal(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0
  return usage.totalTokens
    ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
}

interface BreakdownCandidate extends ExclusiveTokenBreakdown {
  representedTokens: number
  preference: number
}

function candidate(
  usage: TokenUsage,
  cacheAdditional: boolean,
  reasoningAdditional: boolean,
): BreakdownCandidate {
  const input = Math.max(0, usage.inputTokens ?? 0)
  const output = Math.max(0, usage.outputTokens ?? 0)
  const rawCacheRead = Math.max(0, usage.cacheReadTokens ?? 0)
  const rawCacheWrite = Math.max(0, usage.cacheWriteTokens ?? 0)
  const rawReasoning = Math.max(0, usage.reasoningTokens ?? 0)
  const cacheRead = cacheAdditional
    ? rawCacheRead
    : Math.min(input, rawCacheRead)
  const afterCacheRead = cacheAdditional
    ? input
    : Math.max(0, input - cacheRead)
  const cacheWrite = cacheAdditional
    ? rawCacheWrite
    : Math.min(afterCacheRead, rawCacheWrite)
  const inputTokens = cacheAdditional
    ? input
    : Math.max(0, afterCacheRead - cacheWrite)
  const reasoningTokens = reasoningAdditional
    ? rawReasoning
    : Math.min(output, rawReasoning)
  const outputTokens = reasoningAdditional
    ? output
    : Math.max(0, output - reasoningTokens)
  const representedTokens = inputTokens
    + outputTokens
    + reasoningTokens
    + cacheRead
    + cacheWrite
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    otherTokens: 0,
    representedTokens,
    preference: Number(cacheAdditional) * 2 + Number(reasoningAdditional),
  }
}

export function exclusiveTokenBreakdown(
  usage: TokenUsage | undefined,
): ExclusiveTokenBreakdown {
  if (usage === undefined) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      otherTokens: 0,
    }
  }
  const total = tokenTotal(usage)
  const candidates = [
    candidate(usage, false, false),
    candidate(usage, false, true),
    candidate(usage, true, false),
    candidate(usage, true, true),
  ].sort((left, right) =>
    Math.abs(total - left.representedTokens)
      - Math.abs(total - right.representedTokens)
    || left.preference - right.preference)
  const selected = candidates[0]!
  return {
    inputTokens: selected.inputTokens,
    outputTokens: selected.outputTokens,
    reasoningTokens: selected.reasoningTokens,
    cacheReadTokens: selected.cacheReadTokens,
    cacheWriteTokens: selected.cacheWriteTokens,
    otherTokens: Math.max(0, total - selected.representedTokens),
  }
}

export function nestedTokenBreakdown(
  usage: TokenUsage | undefined,
): NestedTokenBreakdown {
  if (usage === undefined) return {}
  const breakdown = exclusiveTokenBreakdown(usage)
  const hasInput = usage.inputTokens !== undefined
    || usage.cacheReadTokens !== undefined
    || usage.cacheWriteTokens !== undefined
  const hasOutput = usage.outputTokens !== undefined
    || usage.reasoningTokens !== undefined
  const hasTotal = usage.totalTokens !== undefined || hasInput || hasOutput
  return {
    totalTokens: hasTotal ? tokenTotal(usage) : undefined,
    inputTokens: hasInput
      ? breakdown.inputTokens
        + breakdown.cacheReadTokens
        + breakdown.cacheWriteTokens
      : undefined,
    cacheTokens: usage.cacheReadTokens !== undefined
      || usage.cacheWriteTokens !== undefined
      ? (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      : undefined,
    outputTokens: hasOutput
      ? breakdown.outputTokens + breakdown.reasoningTokens
      : undefined,
    reasoningTokens: usage.reasoningTokens,
  }
}

export function selectedTokenTotal(
  usage: TokenUsage | undefined,
  selected: ReadonlySet<TokenBreakdownKey>,
): number {
  const breakdown = exclusiveTokenBreakdown(usage)
  return TOKEN_BREAKDOWN_KEYS.reduce(
    (total, key) => total + (selected.has(key) ? breakdown[key] : 0),
    0,
  )
}
