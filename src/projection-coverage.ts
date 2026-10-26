import type {
  EventDisposition,
  ProjectionCoverage,
  ProjectionCoverageSummary,
  TrajectoryRecord,
} from './types'

export interface ProjectionCoveragePolicy {
  consumed?: number
  disposition: EventDisposition
  reason?: string
}

export interface ProjectionCoverageResult {
  coverage: ProjectionCoverage[]
  coverageSummary: ProjectionCoverageSummary
}

export function projectedSourceEventIds(
  records: readonly TrajectoryRecord[],
): ReadonlySet<string> {
  return new Set(records.flatMap(record => record.sourceEventIds))
}

export function projectionCoverage(
  eventTypeCounts: Readonly<Record<string, number>>,
  eventCount: number,
  policy: (type: string, total: number) => ProjectionCoveragePolicy,
): ProjectionCoverageResult {
  const counted = Object.values(eventTypeCounts).reduce(
    (total, count) => total + count,
    0,
  )
  if (counted !== eventCount) {
    throw new Error(
      `projection coverage count mismatch: eventCount=${eventCount}, counted=${counted}`,
    )
  }
  const coverage = Object.entries(eventTypeCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, total]) => {
      const selected = policy(type, total)
      const defaultConsumed = selected.disposition === 'raw-only'
        || selected.disposition === 'unsupported'
        ? 0
        : total
      const consumed = selected.consumed ?? defaultConsumed
      if (!Number.isInteger(consumed) || consumed < 0 || consumed > total) {
        throw new Error(
          `invalid projection coverage for ${type}: ${consumed}/${total}`,
        )
      }
      return {
        type,
        total,
        consumed,
        disposition: selected.disposition,
        ...(selected.reason === undefined ? {} : { reason: selected.reason }),
      }
    })
  const consumed = coverage.reduce((total, item) => total + item.consumed, 0)
  return {
    coverage,
    coverageSummary: {
      total: eventCount,
      consumed,
      gap: eventCount - consumed,
    },
  }
}
