import type { RecordKind, TrajectoryRecord } from './types'

export type TimelineRange = [number, number] | null

export const KIND_LABELS: Record<RecordKind, string> = {
  system: '系统',
  user: '用户',
  steering: '引导',
  context: '上下文',
  assistant: '助手',
  model: '模型调用',
  tool: '工具',
  subtool: '子工具',
  compaction: '压缩',
}

export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return '—'
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`
  }
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.floor((milliseconds % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function formatTime(time: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(time))
}

export function formatNumber(value: number | undefined): string {
  return value === undefined ? '—' : new Intl.NumberFormat('zh-CN').format(value)
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value)
}

export function clampRange(start: number, end: number): [number, number] {
  const span = Math.max(0.01, Math.min(1, end - start))
  let left = start
  if (left < 0) left = 0
  if (left + span > 1) left = 1 - span
  return [left, left + span]
}

export function laneFor(kind: RecordKind): 'input' | 'model' | 'tools' {
  if (kind === 'assistant' || kind === 'model' || kind === 'compaction') return 'model'
  if (kind === 'tool' || kind === 'subtool') return 'tools'
  return 'input'
}

export interface TimelineGeometry {
  byId: Map<string, { start: number; end: number }>
  durationMs: number
  mode: 'duration' | 'sequence'
  recordCount: number
  timeAt: (fraction: number, edge?: 'start' | 'end') => number
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (values[middle]! <= target) low = middle + 1
    else high = middle
  }
  return low
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (values[middle]! < target) low = middle + 1
    else high = middle
  }
  return low
}

export function buildTimelineGeometry(
  records: readonly TrajectoryRecord[],
  actualDuration: boolean,
): TimelineGeometry {
  const sequenceSorted = [...records].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
  const byId = new Map<string, { start: number; end: number }>()
  const sequenceGeometry = (): TimelineGeometry => {
    const slots = Math.max(1, sequenceSorted.length)
    sequenceSorted.forEach((record, index) => {
      byId.set(record.id, { start: index / slots, end: (index + 0.68) / slots })
    })
    return {
      byId,
      durationMs: sequenceSorted.length,
      mode: 'sequence',
      recordCount: sequenceSorted.length,
      timeAt: fraction => Math.max(
        0,
        Math.min(1, fraction),
      ) * Math.max(0, sequenceSorted.length - 1),
    }
  }
  if (!actualDuration) return sequenceGeometry()

  const timeSorted = [...records].sort((a, b) =>
    a.startTime - b.startTime
    || (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime)
    || a.id.localeCompare(b.id))
  const segments: Array<{ start: number; end: number }> = []
  for (const record of timeSorted) {
    const end = record.endTime ?? record.startTime
    if (end <= record.startTime) continue
    const previous = segments.at(-1)
    if (previous !== undefined && record.startTime <= previous.end) {
      previous.end = Math.max(previous.end, end)
    } else {
      segments.push({ start: record.startTime, end })
    }
  }
  if (segments.length === 0) return sequenceGeometry()

  const elapsedAtStart: number[] = []
  let durationMs = 0
  for (const segment of segments) {
    elapsedAtStart.push(durationMs)
    durationMs += segment.end - segment.start
  }
  const segmentEnds = segments.map(segment => segment.end)
  const compressedAt = (time: number): number => {
    const index = lowerBound(segmentEnds, time)
    if (index >= segments.length) return 1
    const segment = segments[index]!
    const elapsed = elapsedAtStart[index]!
    if (time <= segment.start) return elapsed / durationMs
    return (elapsed + Math.min(time, segment.end) - segment.start) / durationMs
  }
  const elapsedEnds = segments.map((segment, index) =>
    elapsedAtStart[index]! + segment.end - segment.start)
  const timeAt = (fraction: number, edge: 'start' | 'end' = 'start'): number => {
    const normalized = Math.max(0, Math.min(1, fraction))
    if (normalized <= 0) return segments[0]!.start
    if (normalized >= 1) return segments.at(-1)!.end
    const elapsed = normalized * durationMs
    const index = edge === 'end'
      ? lowerBound(elapsedEnds, elapsed)
      : upperBound(elapsedEnds, elapsed)
    const segment = segments[Math.min(index, segments.length - 1)]!
    return segment.start + elapsed - elapsedAtStart[Math.min(index, segments.length - 1)]!
  }
  for (const record of sequenceSorted) {
    byId.set(record.id, {
      start: compressedAt(record.startTime),
      end: compressedAt(record.endTime ?? record.startTime),
    })
  }
  return {
    byId,
    durationMs,
    mode: 'duration',
    recordCount: sequenceSorted.length,
    timeAt,
  }
}

export function timelineAxisLabel(
  geometry: TimelineGeometry,
  fraction: number,
  edge: 'start' | 'end' = 'start',
): string {
  if (geometry.mode === 'duration') return formatTime(geometry.timeAt(fraction, edge))
  const position = Math.round(geometry.timeAt(fraction)) + 1
  return `#${Math.max(1, position)}`
}
