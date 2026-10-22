import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TrajectoryRecord, TrajectoryTurnSummary } from '../types'
import { formatDuration, KIND_LABELS } from '../trajectory-view-model'

type LedgerItem =
  | { type: 'turn'; key: string; turn: number; count: number }
  | { type: 'record'; key: string; record: TrajectoryRecord }

interface VirtualLedgerProps {
  records: readonly TrajectoryRecord[]
  turns: readonly TrajectoryTurnSummary[]
  selectedId?: string
  collapsedTurns: ReadonlySet<number>
  onToggleTurn: (turn: number) => void
  onSelect: (id: string) => void
}

export function VirtualLedger({
  records,
  turns,
  selectedId,
  collapsedTurns,
  onToggleTurn,
  onSelect,
}: VirtualLedgerProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const turnSummaries = useMemo(
    () => new Map(turns.map(turn => [turn.number, turn])),
    [turns],
  )
  const grouped = useMemo(() => {
    const groups = new Map<number, TrajectoryRecord[]>()
    for (const record of records) {
      const group = groups.get(record.turn) ?? []
      group.push(record)
      groups.set(record.turn, group)
    }
    const items: LedgerItem[] = []
    for (const [turn, group] of groups) {
      items.push({ type: 'turn', key: `turn:${turn}`, turn, count: group.length })
      if (!collapsedTurns.has(turn)) {
        items.push(...group.map(record => ({ type: 'record' as const, key: record.id, record })))
      }
    }
    return items
  }, [collapsedTurns, records])

  const positions = useMemo(() => {
    let top = 0
    return grouped.map((item) => {
      const height = item.type === 'turn' ? 31 : 56
      const result = { item, top, height }
      top += height
      return result
    })
  }, [grouped])
  const totalHeight = positions.at(-1) === undefined
    ? 0
    : positions.at(-1)!.top + positions.at(-1)!.height
  const visible = positions.filter(position =>
    position.top + position.height >= viewport.top - 240
    && position.top <= viewport.top + viewport.height + 240)

  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const observer = new ResizeObserver(() => {
      setViewport(current => ({ ...current, height: element.clientHeight }))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (selectedId === undefined) return
    const target = positions.find(position =>
      position.item.type === 'record' && position.item.record.id === selectedId)
    const element = scrollRef.current
    if (target === undefined || element === null) return
    if (target.top < element.scrollTop
      || target.top + target.height > element.scrollTop + element.clientHeight) {
      element.scrollTo({
        top: Math.max(0, target.top - element.clientHeight / 3),
        behavior: 'smooth',
      })
    }
  }, [positions, selectedId])

  return (
    <div
      className="ledger-scroll"
      ref={scrollRef}
      onScroll={event => setViewport({
        top: event.currentTarget.scrollTop,
        height: event.currentTarget.clientHeight,
      })}
    >
      <div className="ledger-spacer" style={{ height: `${totalHeight}px` }}>
        {visible.map(({ item, top, height }) => item.type === 'turn'
          ? (
              <button
                className="turn-row"
                type="button"
                key={item.key}
                style={{ transform: `translateY(${top}px)`, height }}
                onClick={() => onToggleTurn(item.turn)}
              >
                {collapsedTurns.has(item.turn)
                  ? <ChevronRight size={15} />
                  : <ChevronDown size={15} />}
                <span>{item.turn === 0 ? '会话' : `${item.turn} 轮`}</span>
                <small>{(() => {
                  const summary = turnSummaries.get(item.turn)
                  if (summary === undefined) return `${item.count} 条记录`
                  const duration = summary.endTime === null
                    ? null
                    : summary.endTime - summary.startTime
                  const usage = summary.usage?.inputTokens === undefined
                    && summary.usage?.outputTokens === undefined
                    ? ''
                    : ` · ${summary.usage?.inputTokens ?? '—'}→${summary.usage?.outputTokens ?? '—'} tok`
                  const ttft = summary.metrics?.ttftMs === undefined
                    ? ''
                    : ` · TTFT ${formatDuration(summary.metrics.ttftMs)}`
                  return `${formatDuration(duration)}${usage}${ttft}`
                })()}</small>
              </button>
            )
          : (
              <button
                type="button"
                className={`ledger-row${selectedId === item.record.id ? ' selected' : ''}`}
                key={item.key}
                style={{
                  transform: `translateY(${top}px)`,
                  height,
                  '--record-depth': item.record.depth,
                } as React.CSSProperties}
                onClick={() => onSelect(item.record.id)}
              >
                <span className="step-cell">{item.record.step || ''}</span>
                <span className={`kind-badge kind-${item.record.kind}`}>
                  {KIND_LABELS[item.record.kind]}
                </span>
                <span className="record-main">
                  <strong>{item.record.title}</strong>
                  <span>{item.record.summary}</span>
                </span>
                <span
                  className={`status-dot status-${item.record.status}`}
                  title={item.record.status}
                />
                <span className="duration-cell">
                  {formatDuration(item.record.endTime === null
                    ? null
                    : item.record.endTime - item.record.startTime)}
                </span>
                <span className="seq-cell">#{item.record.seq}</span>
              </button>
            ))}
      </div>
    </div>
  )
}
