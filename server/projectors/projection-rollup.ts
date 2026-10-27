import type {
  TokenUsage,
  TrajectoryRecord,
  TrajectoryTurnSummary,
} from '../../src/types'

export function sumTokenUsage(
  values: readonly (TokenUsage | undefined)[],
): TokenUsage | undefined {
  const present = values.filter((value): value is TokenUsage =>
    value !== undefined)
  if (present.length === 0) return undefined
  const total: TokenUsage = {}
  for (const usage of present) {
    for (const key of Object.keys(usage) as Array<keyof TokenUsage>) {
      const value = usage[key]
      if (value !== undefined) total[key] = (total[key] ?? 0) + value
    }
  }
  return total
}

export function recordTimeBounds(
  records: readonly TrajectoryRecord[],
  fallbackStart: number,
  fallbackEnd = fallbackStart,
): { startTime: number; endTime: number } {
  let startTime = Number.POSITIVE_INFINITY
  let endTime = Number.NEGATIVE_INFINITY
  for (const record of records) {
    if (Number.isFinite(record.startTime) && record.startTime > 0) {
      startTime = Math.min(startTime, record.startTime)
      endTime = Math.max(endTime, record.startTime)
    }
    if (record.endTime !== null
      && Number.isFinite(record.endTime)
      && record.endTime > 0) {
      startTime = Math.min(startTime, record.endTime)
      endTime = Math.max(endTime, record.endTime)
    }
  }
  return {
    startTime: Number.isFinite(startTime) ? startTime : fallbackStart,
    endTime: Number.isFinite(endTime) ? endTime : fallbackEnd,
  }
}

function turnStatus(
  base: TrajectoryTurnSummary['status'],
  records: readonly TrajectoryRecord[],
): TrajectoryTurnSummary['status'] {
  if (records.some(record => record.status === 'running')) return 'running'
  if (records.some(record => record.status === 'error')) return 'error'
  if (records.some(record => record.status === 'interrupted')) return 'interrupted'
  return base
}

export function rollupTurns(
  turns: readonly TrajectoryTurnSummary[],
  records: readonly TrajectoryRecord[],
): TrajectoryTurnSummary[] {
  const byTurn = new Map<number, TrajectoryRecord[]>()
  for (const record of records) {
    const selected = byTurn.get(record.turn) ?? []
    selected.push(record)
    byTurn.set(record.turn, selected)
  }
  return turns.map((turn) => {
    const selected = byTurn.get(turn.number) ?? []
    const status = turnStatus(turn.status, selected)
    const usage = sumTokenUsage(selected.map(record => record.usage))
      ?? turn.usage
    return {
      ...turn,
      status,
      usage,
      endTime: status === 'running' ? null : turn.endTime,
    }
  })
}
