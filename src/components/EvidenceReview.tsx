import type { EvidenceReviewRequest } from '../analysis-review'
import type { TrajectoryRecord } from '../types'

export function EvidenceReview({ request, records, selectedId, onSelect }: {
  request: EvidenceReviewRequest
  records: readonly TrajectoryRecord[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  const byId = new Map(records.map(record => [record.id, record]))
  const current = records.findIndex(record => record.id === selectedId)
  const adjacent = [records[current - 1], records[current + 1]]
  const selected = byId.get(selectedId)
  const relations = selected === undefined ? [] : records.filter(record =>
    record.id !== selectedId && (
      selected.parentCallId !== undefined && selected.parentCallId === record.callId
      || selected.callId !== undefined && selected.callId === record.parentCallId
      || selected.parentSpanId !== undefined && selected.parentSpanId === record.spanId
      || selected.spanId !== undefined && selected.spanId === record.parentSpanId
    ))
  const context = selected === undefined ? [] : records.filter(record =>
    record.id !== selectedId && record.turn === selected.turn
      && (record.kind === 'user' || record.kind === 'system' || record.kind === 'context'))
  const related = [...new Map([...adjacent, ...relations, ...context]
    .flatMap(record => record === undefined || request.recordIds.includes(record.id) ? [] : [[record.id, record] as const])).values()]
  const link = (id: string) => {
    const record = byId.get(id)
    return record === undefined
      ? <span>{id} · 当前版本未提供</span>
      : <button type="button" aria-current={selectedId === id ? 'step' : undefined} onClick={() => onSelect(id)}>
          第 {record.turn} 轮 · 步骤 {record.step} · {record.title}
          <small>{record.status === 'error' ? '失败' : record.status === 'interrupted' ? '中断'
            : record.status === 'running' ? '运行中' : '完成'} · {record.fidelity === 'exact' ? '来源记录' : '派生记录'}</small>
        </button>
  }
  return (
    <section className="evidence-review" aria-label="证据审阅">
      <h3>{request.title}</h3>
      {request.description !== undefined && <p>{request.description}</p>}
      {request.level !== undefined && <p>{request.level === 'fact' ? '依据：轨迹记录'
        : request.level === 'inferred' ? '依据：分析推断，需核对记录' : '判断原因未记录'}</p>}
      <ol>{[...new Set(request.recordIds)].map(id => <li key={id}>{link(id)}</li>)}</ol>
      {related.length > 0 && <details>
        <summary>相邻记录、调用关系与本轮输入 · {related.length} 条</summary>
        <p>这些记录用于核对上下文，不能据此认定因果或完整模型输入。</p>
        <ol>{related.map(record => <li key={record.id}>{link(record.id)}</li>)}</ol>
      </details>}
    </section>
  )
}
