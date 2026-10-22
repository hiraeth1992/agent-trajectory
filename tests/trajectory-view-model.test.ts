import { describe, expect, it } from 'vitest'
import {
  buildTimelineGeometry,
  timelineAxisLabel,
} from '../src/trajectory-view-model'
import type { TrajectoryRecord } from '../src/types'

function record(
  id: string,
  seq: number,
  startTime: number,
  endTime: number,
): TrajectoryRecord {
  return {
    id,
    source: 'codex',
    sourceEventIds: [id],
    fidelity: 'exact',
    seq,
    turn: 1,
    step: 1,
    kind: 'assistant',
    title: id,
    summary: id,
    startTime,
    endTime,
    status: 'complete',
    depth: 0,
    searchText: id,
  }
}

describe('timeline geometry', () => {
  it('merges intervals by time and reverses compressed coordinates for axis labels', () => {
    const geometry = buildTimelineGeometry([
      record('first-by-seq', 1, 10_000, 20_000),
      record('middle-by-seq', 2, 5_000, 15_000),
      record('covering-last-by-seq', 3, 0, 30_000),
      record('separate', 4, 50_000, 60_000),
    ], true)

    expect(geometry.mode).toBe('duration')
    expect(geometry.durationMs).toBe(40_000)
    expect(geometry.byId.get('covering-last-by-seq')).toEqual({
      start: 0,
      end: 0.75,
    })
    expect(geometry.timeAt(0)).toBe(0)
    expect(geometry.timeAt(0.75)).toBe(50_000)
    expect(geometry.timeAt(0.75, 'end')).toBe(30_000)
    expect(geometry.timeAt(1)).toBe(60_000)
  })

  it('labels sequence geometry with record positions instead of wall-clock time', () => {
    const geometry = buildTimelineGeometry([
      record('a', 1, 10_000, 10_000),
      record('b', 2, 20_000, 20_000),
    ], false)

    expect(geometry.mode).toBe('sequence')
    expect(timelineAxisLabel(geometry, 0)).toBe('#1')
    expect(timelineAxisLabel(geometry, 1)).toBe('#2')
  })

  it('builds geometry for 40,000 visible records without quadratic slowdown', () => {
    const records = Array.from({ length: 40_000 }, (_, index) =>
      record(String(index), index, index * 2, index * 2 + 1))
    const started = performance.now()

    const geometry = buildTimelineGeometry(records, true)

    expect(geometry.byId.size).toBe(40_000)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})
