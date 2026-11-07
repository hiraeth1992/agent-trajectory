import type { EvidenceReviewRequest } from '../analysis-review'
import type { TrajectoryRecord } from '../types'

export function EvidenceLinks({
  title,
  recordIds,
  records,
  onOpenRecord,
  onReview,
}: {
  title: string
  recordIds: readonly string[]
  records?: readonly TrajectoryRecord[]
  onOpenRecord: (id: string) => void
  onReview?: (request: EvidenceReviewRequest, selectedId?: string) => void
}) {
  const ids = [...new Set(recordIds)]
  if (ids.length === 0) return <span className="summary-evidence-link">无可定位证据</span>
  const byId = new Map(records?.map(record => [record.id, record]))
  const open = (id: string) => onReview === undefined
    ? onOpenRecord(id)
    : onReview({ title, recordIds: ids }, id)
  if (ids.length === 1) {
    if (records !== undefined && !byId.has(ids[0]!)) {
      return <span className="summary-evidence-link">{title} · 当前版本未提供证据</span>
    }
    return <button type="button" className="summary-evidence-link" onClick={() => open(ids[0]!)}>{title} · 1 条证据</button>
  }
  return (
    <details className="evidence-links">
      <summary>{title} · {ids.length} 条证据</summary>
      <ol>
        {ids.map(id => {
          const record = byId.get(id)
          return <li key={id}>{record === undefined && records !== undefined
            ? <span>{id} · 当前版本未提供</span>
            : <button type="button" onClick={() => open(id)}>
            {record === undefined ? id : `第 ${record.turn} 轮 · 步骤 ${record.step} · ${record.title}`}
          </button>}</li>
        })}
      </ol>
    </details>
  )
}
