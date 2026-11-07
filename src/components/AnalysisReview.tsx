import { Eye } from 'lucide-react'
import type { FactsQualityIssue, FactsQualityReport } from '../evaluation-types'
import type { TrajectoryAnalysis } from '../trajectory-analysis'
import type { SourceStatus } from '../types'
import {
  REVIEW_FILTERS,
  type EvidenceReviewRequest,
  type ReviewFilter,
  type ReviewStep,
} from '../analysis-review'

const QUALITY_REASONS: Record<FactsQualityIssue['category'], string> = {
  capability: '来源可观测信息有限',
  completeness: '部分输入或必要字段缺失',
  coverage: '部分事件未形成可分析记录',
  liveness: '来源或执行状态可能更新',
  pairing: '部分工具结果缺失',
  protocol: '来源读取或协议支持受限',
  trace: '部分调用关系缺失',
  truncation: '部分输入或输出已截断',
}

function QualityIssueGroup({ issues, severity, evaluations, onReview }: {
  issues: FactsQualityIssue[]
  severity: FactsQualityIssue['severity']
  evaluations: ReadonlyMap<string, string>
  onReview?: (request: EvidenceReviewRequest) => void
}) {
  if (issues.length === 0) return null
  const affected = [...new Set(issues.flatMap(issue => issue.affectedCriterionIds))]
    .map(id => evaluations.get(id) ?? id).join('、') || '来源事实'
  const reasons = [...new Set(issues.map(issue =>
    issue.coverageDisposition === 'unsupported' || issue.id === 'unknown-event-types'
      ? '部分事件尚未支持，影响范围待确认'
      : QUALITY_REASONS[issue.category]))]
  return (
    <article className={`quality-issue severity-${severity}`}>
      <strong>{severity === 'blocking' ? '结论受限' : '判断提示'}</strong>
      <p>{severity === 'blocking' ? '暂无法判断' : '判断需注意'}：{affected}</p>
      <p>{reasons.join('；')}。</p>
      <details className="quality-details">
        <summary>查看 {issues.length} 项{severity === 'blocking' ? '限制详情' : '判断提示'}</summary>
        <div className="quality-details-list">
          {issues.map(issue => <div key={issue.id} className="quality-detail">
            <p>{issue.summary}</p>
            <small>影响：{issue.affectedCriterionIds.map(id => evaluations.get(id) ?? id).join('、') || '来源事实'}</small>
            {onReview !== undefined && issue.evidenceRecordIds.length > 0 && <button type="button" onClick={() => onReview({
              title: '数据质量', description: issue.summary, level: 'fact', recordIds: issue.evidenceRecordIds,
            })}>查看 {issue.evidenceRecordIds.length} 条相关记录</button>}
          </div>)}
        </div>
      </details>
    </article>
  )
}

export function FactsQualityDetails({ analysis, quality, sourceStatus, onReview }: {
  analysis: TrajectoryAnalysis
  quality?: FactsQualityReport
  sourceStatus?: SourceStatus
  onReview?: (request: EvidenceReviewRequest) => void
}) {
  const observability = analysis.evaluations.find(item => item.id === 'observability')
  const evaluations = new Map(analysis.evaluations.map(item => [item.id, item.title]))
  // Keep the full report for auditing. Only explicitly advisory raw-only events
  // are silent; required facts and unclassified older reports remain visible.
  const issues = quality?.issues.filter(issue => !(issue.category === 'coverage'
    && issue.severity === 'warning' && issue.coverageDisposition === 'raw-only')) ?? []
  const blocking = issues.filter(issue => issue.severity === 'blocking')
  const warnings = issues.filter(issue => issue.severity === 'warning')
  const sourceLimited = sourceStatus !== undefined && sourceStatus.availability !== 'available'
  const blocked = quality !== undefined && !quality.ready
  const grade = quality === undefined ? 'unknown'
    : blocked || warnings.length > 0 || sourceLimited ? 'warning'
      : observability?.grade === 'good' ? 'good'
        : observability === undefined || observability.grade === 'unknown' ? 'unknown' : 'warning'
  const label = quality === undefined ? '未提供质量报告'
    : blocked ? '部分结论受限'
      : sourceLimited ? '来源读取受限'
        : warnings.length > 0 ? '存在数据限制'
          : grade === 'good' ? '未发现数据限制'
            : grade === 'unknown' ? '可观测性尚未确认' : '证据覆盖有限'
  const affected = quality?.blockedCriterionIds.map(id => evaluations.get(id) ?? id).join('、')
  const summary = quality === undefined ? '当前数据完整度尚未核实，结论需以来源记录为准。'
    : blocked ? `数据限制影响${affected || '部分过程结论'}，现有证据不足以判断。`
      : sourceLimited ? '来源读取受限，结论需结合来源状态解读。'
        : warnings.length > 0 ? `${warnings.length} 项判断提示，结论需结合来源限制解读。`
          : '结论仅覆盖已记录的行为，证据覆盖与来源完整度见详情。'
  return (
    <section className={`evaluation-item facts-quality-panel grade-${grade}`} aria-label="数据质量">
      <div className="evaluation-icon"><Eye size={16} /></div>
      <div>
        <span>数据质量 · 评测依据</span>
        <strong>{label}</strong>
        <p>{summary}</p>
        <details className="quality-details quality-evaluation-details">
          <summary>查看数据质量详情</summary>
          <div id="analysis-basis" tabIndex={-1} className="quality-evaluation-content">
            {observability !== undefined && quality?.blockedCriterionIds.includes('observability') !== true
              && <p className="review-note">可观测性：{observability.label} · {observability.summary}</p>}
            {sourceLimited && <p className="review-note">
              来源读取提示：{sourceStatus.detail ?? sourceStatus.reason ?? '来源暂不可用'}。这是来源状态，不是 Agent 执行失败。
            </p>}
            {quality === undefined
              ? <p className="review-note">当前响应未提供完整事实的质量报告，请以来源记录为准。</p>
              : <>
                  <p className="review-note">
                    语义覆盖 {quality.stats.coverageConsumed}/{quality.stats.coverageTotal} 个事件
                    {quality.stats.coverageRawOnly === undefined
                      ? <> · 未进入语义事实 {quality.stats.coverageGap}</>
                      : <> · 仅原始审计 {quality.stats.coverageRawOnly}
                          {' · '}解析缺口 {quality.stats.coverageGap - quality.stats.coverageRawOnly}</>}
                    {' · '}运行中 {quality.stats.runningRecords}
                    {' · '}来源内容截断 {quality.stats.truncatedRecords}
                    {' · '}{quality.target.mode === 'live' ? '可变来源，最终状态可能更新' : '当前读取版本'}
                  </p>
                  {issues.length === 0
                    ? <p className="review-note">未发现需要提示的数据限制；结论仅覆盖已记录的行为。</p>
                    : <div className="quality-issues">
                        <QualityIssueGroup issues={blocking}
                          severity="blocking" evaluations={evaluations} onReview={onReview} />
                        <QualityIssueGroup issues={warnings}
                          severity="warning" evaluations={evaluations} onReview={onReview} />
                      </div>}
                </>}
          </div>
        </details>
      </div>
    </section>
  )
}

export function ReviewFilters({ steps, total, visible, filters, onChange }: {
  steps: readonly ReviewStep[]
  total: number
  visible: number
  filters: ReadonlySet<ReviewFilter>
  onChange: (filters: Set<ReviewFilter>) => void
}) {
  return <div className="step-review-controls">
    <div className="review-filters" role="group" aria-label="联合筛选步骤">
      <button type="button" aria-pressed={filters.size === 0}
        onClick={() => onChange(new Set())}>全部步骤 · {total}</button>
      {REVIEW_FILTERS.map(([value, label]) => (
        <button type="button" key={value} aria-pressed={filters.has(value)} onClick={() => {
          const next = new Set(filters)
          if (next.has(value)) next.delete(value)
          else next.add(value)
          onChange(next)
        }}>{label} · {steps.filter(step => step.tags.includes(value)).length}</button>
      ))}
    </div>
    <p className="review-note" role="status">共 {total} 步 · 问题与资源候选 {steps.filter(step => step.tags.length > 0).length} 步 · 当前显示 {visible} 步</p>
    <p className="review-note">多项筛选同时满足。耗时与 Token 各取有数据的前 5 步，排名不代表浪费。中断单独展示；后续执行成功不代表原问题验证通过。</p>
  </div>
}
