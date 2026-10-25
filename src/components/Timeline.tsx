import {
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useMemo,
  useRef,
} from 'react'
import type { TrajectoryRecord } from '../types'
import {
  buildTimelineGeometry,
  clampRange,
  formatDuration,
  formatTime,
  KIND_LABELS,
  laneFor,
  timelineAxisLabel,
  type TimelineRange,
} from '../trajectory-view-model'

interface TimelineProps {
  records: readonly TrajectoryRecord[]
  actualDuration: boolean
  range: TimelineRange
  selectedId?: string
  onRangeChange: (range: TimelineRange) => void
  onSelect: (id: string) => void
}

export function Timeline({
  records,
  actualDuration,
  range,
  selectedId,
  onRangeChange,
  onSelect,
}: TimelineProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const gesture = useRef<{
    button: number
    startX: number
    anchor: number
    initial: [number, number]
    moved: boolean
  } | null>(null)
  const domain = range ?? [0, 1]
  const geometry = useMemo(
    () => buildTimelineGeometry(records, actualDuration),
    [actualDuration, records],
  )

  const fractionAt = (clientX: number): number => {
    const rect = viewportRef.current?.getBoundingClientRect()
    if (rect === undefined || rect.width === 0) return domain[0]
    const local = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return domain[0] + local * (domain[1] - domain[0])
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 2) return
    event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = {
      button: event.button,
      startX: event.clientX,
      anchor: fractionAt(event.clientX),
      initial: [domain[0], domain[1]],
      moved: false,
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = gesture.current
    const rect = viewportRef.current?.getBoundingClientRect()
    if (active === null || rect === undefined || rect.width === 0) return
    if (Math.abs(event.clientX - active.startX) > 3) active.moved = true
    if (active.button === 0) {
      const current = fractionAt(event.clientX)
      if (Math.abs(current - active.anchor) >= 0.002) {
        onRangeChange(clampRange(Math.min(active.anchor, current), Math.max(active.anchor, current)))
      }
      return
    }
    const delta = (event.clientX - active.startX) / rect.width
      * (active.initial[1] - active.initial[0])
    onRangeChange(clampRange(active.initial[0] - delta, active.initial[1] - delta))
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = gesture.current
    gesture.current = null
    if ((active?.button === 2 || active?.button === 0) && !active.moved) onRangeChange(null)
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    const center = fractionAt(event.clientX)
    const currentSpan = domain[1] - domain[0]
    const nextSpan = Math.max(0.01, Math.min(1, currentSpan * Math.exp(event.deltaY * 0.0015)))
    const ratio = (center - domain[0]) / currentSpan
    onRangeChange(clampRange(center - nextSpan * ratio, center + nextSpan * (1 - ratio)))
  }

  const laneRecords = useMemo(() => ({
    input: records.filter(record => laneFor(record.kind) === 'input'),
    model: records.filter(record => laneFor(record.kind) === 'model'),
    tools: records.filter(record => laneFor(record.kind) === 'tools'),
  }), [records])

  const position = (fraction: number): number => {
    return (fraction - domain[0]) / (domain[1] - domain[0]) * 100
  }

  const width = (record: TrajectoryRecord): number => {
    const span = geometry.byId.get(record.id)
    if (span === undefined) return 0
    return Math.max(0.35, position(span.end) - position(span.start))
  }

  const turnMarkers = useMemo(() => {
    const result = new Set<number>()
    for (const record of records) {
      if (record.turn > 0) result.add(record.turn)
    }
    return [...result]
  }, [records])

  return (
    <section className="overview" aria-label="轨迹概览">
      <div className="overview-heading">
        <div>
          <strong>概览</strong>
          <span>
            {geometry.mode === 'duration'
              ? formatDuration((domain[1] - domain[0]) * geometry.durationMs)
              : `${Math.max(1, Math.round((domain[1] - domain[0]) * records.length))} 条`}
          </span>
        </div>
        <span className="overview-hint">拖选聚焦 · 滚轮缩放 · 右键拖动平移</span>
      </div>
      <div className="timeline-grid">
        <div className="lane-labels" aria-hidden="true">
          <span>输入</span>
          <span>模型</span>
          <span>工具</span>
        </div>
        <div
          className="timeline-viewport"
          ref={viewportRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onContextMenu={event => event.preventDefault()}
        >
          {turnMarkers.map((turn) => {
            const first = records.find(record => record.turn === turn)
            const left = position(first === undefined ? 0 : geometry.byId.get(first.id)?.start ?? 0)
            if (left < 0 || left > 100) return null
            return (
              <div className="turn-marker" key={turn} style={{ left: `${left}%` }}>
                <span>{turn}</span>
              </div>
            )
          })}
          {(['input', 'model', 'tools'] as const).map((lane, laneIndex) => (
            <div className={`timeline-lane lane-${lane}`} key={lane} style={{ top: `${laneIndex * 28}px` }}>
              {laneRecords[lane].map((record) => {
                const left = position(geometry.byId.get(record.id)?.start ?? 0)
                const barWidth = width(record)
                if (left > 100 || left + barWidth < 0) return null
                const ttftRatio = record.kind === 'assistant'
                  && record.endTime !== null
                  && record.metrics?.ttftMs !== undefined
                  ? Math.min(100, record.metrics.ttftMs / Math.max(1, record.endTime - record.startTime) * 100)
                  : undefined
                return (
                  <button
                    type="button"
                    key={record.id}
                    className={`timeline-record kind-${record.kind}${selectedId === record.id ? ' selected' : ''}${barWidth === 0 ? ' point' : ''}`}
                    style={{
                      left: `${left}%`,
                      width: barWidth === 0 ? undefined : `${barWidth}%`,
                      ...(ttftRatio === undefined
                        ? {}
                        : { background: `linear-gradient(90deg, var(--assistant-ttft) ${ttftRatio}%, var(--assistant-decode) ${ttftRatio}%)` }),
                    }}
                    title={`${KIND_LABELS[record.kind]} · ${record.title}\n${formatTime(record.startTime)} · ${formatDuration(record.endTime === null ? null : record.endTime - record.startTime)}`}
                    onPointerDown={event => event.stopPropagation()}
                    onClick={() => onSelect(record.id)}
                    aria-label={`选择 ${record.title}`}
                  />
                )
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="timeline-axis">
        <span>{timelineAxisLabel(geometry, domain[0])}</span>
        <span>{timelineAxisLabel(geometry, domain[1], 'end')}</span>
      </div>
    </section>
  )
}
