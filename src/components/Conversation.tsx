import { ChevronDown, ChevronRight, LocateFixed } from 'lucide-react'
import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { TrajectoryRecord } from '../types'
import { formatDuration, formatTime, KIND_LABELS } from '../trajectory-view-model'

interface ConversationProps {
  records: readonly TrajectoryRecord[]
  onInspect: (id: string) => void
  onLocate: (id: string) => void
}

function textBlocks(value: unknown, type: 'text' | 'reasoning' = 'text'): string[] {
  if (typeof value === 'string') return type === 'text' ? [value] : []
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    const block = entry as Record<string, unknown>
    return block.type === type && typeof block.text === 'string'
      ? [block.text]
      : []
  })
}

function messageText(record: TrajectoryRecord): string {
  const value = record.kind === 'assistant' ? record.output : record.input
  return textBlocks(value).join('\n\n').trim() || record.summary
}

function isRuntimeEnvironment(record: TrajectoryRecord): boolean {
  return record.kind === 'user'
    && messageText(record).trimStart().startsWith('<environment_context>')
}

function isMessage(record: TrajectoryRecord): boolean {
  if (record.kind === 'user') return !isRuntimeEnvironment(record)
  if (record.kind === 'steering') return true
  if (record.kind !== 'assistant') return false
  if (textBlocks(record.output).some(text => text.trim() !== '')) return true
  return record.output !== null
    && typeof record.output === 'object'
    && !Array.isArray(record.output)
    && (record.output as Record<string, unknown>).truncated === true
}

interface ConversationTurn {
  turn: number
  messages: TrajectoryRecord[]
  activity: TrajectoryRecord[]
}

function turnLabel(turn: number): string {
  return turn === 0 ? '会话级' : `第 ${turn} 轮`
}

export function Conversation({ records, onInspect, onLocate }: ConversationProps) {
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set())
  const turns = useMemo(() => {
    const grouped = new Map<number, ConversationTurn>()
    const sorted = [...records].sort((a, b) =>
      a.seq - b.seq || a.startTime - b.startTime || a.id.localeCompare(b.id))
    for (const record of sorted) {
      const turn = grouped.get(record.turn) ?? {
        turn: record.turn,
        messages: [],
        activity: [],
      }
      if (isMessage(record)) turn.messages.push(record)
      else turn.activity.push(record)
      grouped.set(record.turn, turn)
    }
    return [...grouped.values()].filter(turn =>
      turn.messages.length > 0 || turn.activity.length > 0)
  }, [records])

  const toggleTurn = (turn: number) => {
    setExpandedTurns((current) => {
      const next = new Set(current)
      if (next.has(turn)) next.delete(turn)
      else next.add(turn)
      return next
    })
  }

  return (
    <section className="conversation" aria-label="会话内容">
      {turns.length === 0
        ? <div className="conversation-empty">当前会话没有可展示的主消息</div>
        : turns.map((turn) => {
            const expanded = expandedTurns.has(turn.turn)
            const label = turnLabel(turn.turn)
            return (
              <div className="conversation-turn" key={turn.turn}>
                {turn.messages.map(record => (
                  <article
                    className={`conversation-message message-${record.kind === 'assistant' ? 'assistant' : 'user'}`}
                    key={record.id}
                  >
                    <header>
                      <strong>{record.kind === 'assistant' ? '助手' : record.kind === 'steering' ? '中途引导' : '用户'}</strong>
                      <time dateTime={new Date(record.startTime).toISOString()}>
                        {formatTime(record.startTime)}
                      </time>
                      <button
                        className="conversation-locate"
                        type="button"
                        aria-label={`在轨迹中定位：${record.summary}`}
                        title="在轨迹中定位"
                        onClick={() => onLocate(record.id)}
                      >
                        <LocateFixed size={14} />
                      </button>
                    </header>
                    <div className="conversation-content">
                      <ReactMarkdown>{messageText(record)}</ReactMarkdown>
                    </div>
                  </article>
                ))}
                {turn.activity.length > 0 && (
                  <div className="conversation-activity">
                    <button
                      className="conversation-activity-toggle"
                      type="button"
                      aria-expanded={expanded}
                      aria-label={`${expanded ? '收起' : '展开'}${label}执行详情（${turn.activity.length} 条）`}
                      onClick={() => toggleTurn(turn.turn)}
                    >
                      {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      <span>{label}执行详情</span>
                      <small>{turn.activity.length} 条</small>
                    </button>
                    {expanded && (
                      <div className="conversation-activity-list">
                        {turn.activity.map(record => (
                          <button
                            className={`conversation-activity-row kind-${record.kind}`}
                            type="button"
                            key={record.id}
                            aria-label={`检查 ${record.title}：${record.summary}`}
                            onClick={() => onInspect(record.id)}
                          >
                            <span className="activity-kind">
                              {record.title === '推理' ? '推理' : KIND_LABELS[record.kind]}
                            </span>
                            <span className="activity-summary">
                              <strong>{record.title}</strong>
                              <span>{record.summary}</span>
                            </span>
                            <span className={`status-dot status-${record.status}`} />
                            <time>
                              {formatDuration(record.endTime === null
                                ? null
                                : record.endTime - record.startTime)}
                            </time>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
    </section>
  )
}
