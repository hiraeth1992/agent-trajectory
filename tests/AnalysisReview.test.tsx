// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FactsQualityDetails } from '../src/components/AnalysisReview'
import { TrajectorySummary } from '../src/components/TrajectorySummary'
import { EvidenceLinks } from '../src/components/EvidenceLinks'
import { EvidenceReview } from '../src/components/EvidenceReview'
import { Inspector } from '../src/components/Inspector'
import type { TrajectoryAnalysis } from '../src/trajectory-analysis'
import type { TrajectoryRecord } from '../src/types'
import type { FactsQualityReport } from '../src/evaluation-types'
import { capabilities } from '../server/sources/types'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ adapters: [], cacheStatus: 'missing' }), { status: 200 })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const records: TrajectoryRecord[] = ['failed', 'large', 'input'].map((id, index) => ({
  id, source: 'zcode', sourceEventIds: [id], fidelity: 'exact', seq: index, turn: 1, step: index + 1,
  kind: id === 'input' ? 'user' : 'tool', title: id, summary: id,
  startTime: index, endTime: index + 1, status: id === 'failed' ? 'error' : 'complete', depth: 0,
  input: 'input', output: 'output', searchText: id,
}))
const steps = records.slice(0, 2).map((record, index) => ({
  id: `step:${record.id}`, recordId: record.id, recordIds: [record.id], turn: 1, step: record.step,
  kind: record.kind, action: record.title, detail: record.title, reason: 'recorded', reasonLevel: 'fact' as const,
  execution: record.title, result: record.status, status: record.status,
  durationMs: index === 0 ? 10 : 20, usage: index === 0 ? undefined : { totalTokens: 200 },
}))
const analysis: TrajectoryAnalysis = {
  objective: 'Review', objectiveLabel: '会话目标',
  outcome: { label: 'unknown', summary: 'unknown', tone: 'neutral', confidence: 'low', evidenceRecordIds: [] },
  stats: { durationMs: 30, turns: 1, steps: 2, errors: 1, retries: 0, recovered: 0 },
  steps, costSteps: steps, evaluations: [{ id: 'outcome', title: '结果证据', grade: 'unknown', label: 'unknown',
    summary: 'unknown', confidence: 'low', evidenceRecordIds: [] }], corrections: [],
}
const quality: FactsQualityReport = {
  schemaVersion: 4, coveragePolicyVersion: 1, source: 'zcode', sourceCapabilities: capabilities('tools'),
  target: { source: 'zcode', sourceSessionId: 'test', mode: 'live', fingerprint: 'test' }, contextScope: 'session',
  ready: false, blockedCriterionIds: ['outcome'],
  stats: { records: 3, turns: 1, runningRecords: 0, truncatedRecords: 1, toolRecords: 2,
    toolRecordsMissingInput: 0, toolRecordsMissingOutput: 1, brokenParentSpans: 0, unknownEventTypes: 0,
    coverageTotal: 4, coverageConsumed: 3, coverageGap: 1 },
  issues: [{ id: 'missing-output', category: 'completeness', severity: 'blocking', summary: '来源没有保留输出',
    evidenceRecordIds: ['failed'], affectedCriterionIds: ['outcome'] }],
}

describe('analysis review UI', () => {
  it('presents data quality as a compact process item and reveals details on demand', () => {
    render(<FactsQualityDetails analysis={analysis} quality={quality} />)
    const panel = screen.getByRole('region', { name: '数据质量' })
    expect(panel.className).toContain('evaluation-item')
    expect(panel.className).toContain('grade-warning')
    expect(within(panel).getByText('数据质量 · 评测依据')).toBeTruthy()
    expect(within(panel).getByText('数据限制影响结果证据，现有证据不足以判断。')).toBeTruthy()
    const details = within(panel).getByText('查看数据质量详情').closest('details')!
    expect(details.open).toBe(false)
    expect(details.querySelector('#analysis-basis')).not.toBeNull()
    fireEvent.click(within(panel).getByText('查看数据质量详情'))
    expect(details.open).toBe(true)
    expect(within(panel).getByText(/语义覆盖 3\/4 个事件/)).toBeTruthy()
    fireEvent.click(within(panel).getByText('查看数据质量详情'))
    expect(details.open).toBe(false)
  })

  it.each([
    ['good', '未发现数据限制', 'good'],
    ['warning', '证据覆盖有限', 'warning'],
    ['bad', '证据覆盖有限', 'warning'],
    ['unknown', '可观测性尚未确认', 'unknown'],
  ] as const)('includes %s observability in the overall data quality state', (grade, label, expectedGrade) => {
    render(<FactsQualityDetails analysis={{ ...analysis, evaluations: [...analysis.evaluations,
      { id: 'observability', title: '可观测性', label: '覆盖统计', summary: '证据类别',
        confidence: 'high', grade, evidenceRecordIds: [] }] }}
      quality={{ ...quality, ready: true, blockedCriterionIds: [], issues: [] }} />)
    const panel = screen.getByRole('region', { name: '数据质量' })
    expect(within(panel).getByText(label)).toBeTruthy()
    expect(panel.className).toContain(`grade-${expectedGrade}`)
  })

  it('marks an absent report as unknown even when observable evidence is available', () => {
    render(<FactsQualityDetails analysis={analysis} />)
    const panel = screen.getByRole('region', { name: '数据质量' })
    expect(panel.className).toContain('grade-unknown')
    expect(within(panel).getByText('未提供质量报告')).toBeTruthy()
    expect(within(panel).queryByText('未发现数据限制')).toBeNull()
  })

  it('keeps advisory source issues visible in the summary without blocking agent conclusions', () => {
    render(<FactsQualityDetails analysis={analysis} quality={{ ...quality, ready: true,
      blockedCriterionIds: [], issues: [{ ...quality.issues[0]!, severity: 'warning' }] }} />)
    const panel = screen.getByRole('region', { name: '数据质量' })
    expect(within(panel).getByText('存在数据限制')).toBeTruthy()
    expect(within(panel).getByText('1 项判断提示，结论需结合来源限制解读。')).toBeTruthy()
    expect(within(panel).queryByText('部分结论受限')).toBeNull()
  })

  it('includes degraded source status even when the report has no issues', () => {
    render(<FactsQualityDetails analysis={analysis} quality={{ ...quality, ready: true,
      blockedCriterionIds: [], issues: [] }} sourceStatus={{ source: 'zcode', availability: 'degraded',
      label: 'ZCode', colorToken: 'amber', iconToken: 'terminal', sessionCount: 1,
      capabilities: capabilities('tools'), detail: '一个文件解析失败' }} />)
    const panel = screen.getByRole('region', { name: '数据质量' })
    expect(within(panel).getByText('来源读取受限')).toBeTruthy()
    expect(panel.className).toContain('grade-warning')
  })

  it('counts candidates against all logical steps and keeps the filtered count explicit', () => {
    const ordinary = { ...steps[0]!, id: 'ordinary', recordId: 'ordinary', recordIds: ['ordinary'],
      durationMs: null, usage: undefined, status: 'complete' as const }
    render(<TrajectorySummary source="zcode" sourceSessionId="test" onOpenRecord={vi.fn()}
      analysis={{ ...analysis, steps: [...steps, ordinary] }} records={records}
      factsQuality={quality} onReview={vi.fn()} />)
    expect(screen.getByText('共 3 步 · 问题与资源候选 2 步 · 当前显示 3 步')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '执行失败 · 1' }))
    expect(screen.getByText('共 3 步 · 问题与资源候选 2 步 · 当前显示 1 步')).toBeTruthy()
  })

  it('separates intentional audit-only events from parsing gaps', () => {
    render(<FactsQualityDetails analysis={analysis}
      quality={{ ...quality, stats: { ...quality.stats, coverageTotal: 820, coverageConsumed: 806,
        coverageGap: 14, coverageRawOnly: 10 } }} onReview={vi.fn()} />)
    expect(screen.getByText(/仅原始审计 10.*解析缺口 4/)).toBeTruthy()
    expect(screen.queryByText(/未解释 14/)).toBeNull()
  })

  it('silences advisory audit-only events while keeping their coverage statistics', () => {
    const report: FactsQualityReport = { ...quality, ready: true, blockedCriterionIds: [],
      stats: { ...quality.stats, coverageTotal: 10, coverageConsumed: 0, coverageGap: 10, coverageRawOnly: 10 },
      issues: [{ id: 'config', category: 'coverage', severity: 'warning', coverageDisposition: 'raw-only',
        summary: '线程配置仅保留原始审计', evidenceRecordIds: [], affectedCriterionIds: ['outcome'] }] }
    const before = structuredClone(report)
    render(<FactsQualityDetails analysis={analysis} quality={report} onReview={vi.fn()} />)
    const panel = screen.getByRole('region', { name: '数据质量' })
    expect(within(panel).queryByText('线程配置仅保留原始审计')).toBeNull()
    expect(within(panel).queryByText('判断提示')).toBeNull()
    expect(within(panel).getByText(/仅原始审计 10.*解析缺口 0/)).toBeTruthy()
    expect(within(panel).getByText('未发现需要提示的数据限制；结论仅覆盖已记录的行为。')).toBeTruthy()
    expect(report).toEqual(before)
  })

  it('summarizes unknown event impact and collapses technical details by default', () => {
    const report: FactsQualityReport = { ...quality, issues: ['call', 'output'].map(type => ({
      id: type, category: 'coverage', severity: 'blocking', coverageDisposition: 'unsupported',
      summary: `${type}: no semantic projector`, evidenceRecordIds: [], affectedCriterionIds: ['outcome'],
    })) }
    render(<FactsQualityDetails analysis={analysis} quality={report} onReview={vi.fn()} />)
    const panel = screen.getByRole('region', { name: '数据质量' })
    expect(within(panel).getByText('暂无法判断：结果证据')).toBeTruthy()
    expect(within(panel).getByText('部分事件尚未支持，影响范围待确认。')).toBeTruthy()
    const technical = within(panel).getByText('call: no semantic projector').closest('details')!
    expect(technical).not.toBeNull()
    expect(technical.open).toBe(false)
    fireEvent.click(within(panel).getByText('查看 2 项限制详情'))
    expect(technical.open).toBe(true)
  })

  it('never silences required raw-only facts or unclassified legacy issues', () => {
    render(<FactsQualityDetails analysis={analysis} quality={{ ...quality, issues: [
      { id: 'required-result', category: 'coverage', severity: 'blocking', coverageDisposition: 'raw-only',
        summary: '必要执行结果未转换', evidenceRecordIds: [], affectedCriterionIds: ['outcome'] },
      { id: 'legacy', category: 'coverage', severity: 'warning', summary: '旧报告尚未提供事件分类',
        evidenceRecordIds: [], affectedCriterionIds: ['outcome'] },
    ] }} onReview={vi.fn()} />)
    const panel = screen.getByRole('region', { name: '数据质量' })
    expect(within(panel).getByText('部分结论受限')).toBeTruthy()
    expect(within(panel).getByText('暂无法判断：结果证据')).toBeTruthy()
    expect(within(panel).getByText('查看 1 项限制详情')).toBeTruthy()
    expect(within(panel).getByText('查看 1 项判断提示')).toBeTruthy()
    expect(within(panel).getByText('必要执行结果未转换').closest('details')).not.toBeNull()
    expect(within(panel).getByText('旧报告尚未提供事件分类').closest('details')).not.toBeNull()
  })

  it('keeps missing results and truncated content visible as concrete judgment limits', () => {
    render(<FactsQualityDetails analysis={analysis} quality={{ ...quality, issues: [
      { ...quality.issues[0]!, category: 'pairing' },
      { id: 'truncated', category: 'truncation', severity: 'blocking', summary: '输入已截断',
        evidenceRecordIds: ['failed'], affectedCriterionIds: ['outcome'] },
    ] }} onReview={vi.fn()} />)
    expect(screen.getByText('部分工具结果缺失；部分输入或输出已截断。')).toBeTruthy()
    expect(screen.getByText('暂无法判断：结果证据')).toBeTruthy()
  })

  it('combines resource and failure filters and preserves the honest empty state', () => {
    const onReview = vi.fn()
    render(<TrajectorySummary source="zcode" sourceSessionId="test" onOpenRecord={vi.fn()}
      analysis={analysis} records={records} factsQuality={quality} onReview={onReview} />)
    const panel = screen.getByRole('region', { name: '步骤详情' })
    fireEvent.click(within(panel).getByRole('button', { name: '执行失败 · 1' }))
    expect(within(panel).getByRole('button', { name: '审阅 1 条证据：failed' })).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: 'Token 靠前 · 1' }))
    expect(within(panel).getByText('没有同时满足这些条件的步骤')).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: '执行失败 · 1' }))
    fireEvent.click(within(panel).getByRole('button', { name: '审阅 1 条证据：large' }))
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ recordIds: ['large'], tokens: 200 }), 'large')
  })

  it('explains exactly which criterion a source limitation affects and opens its evidence', () => {
    const onReview = vi.fn()
    render(<FactsQualityDetails analysis={analysis} quality={quality} onReview={onReview}
      sourceStatus={{ source: 'zcode', availability: 'degraded', label: 'ZCode', colorToken: 'amber',
        iconToken: 'terminal', sessionCount: 1, capabilities: capabilities('tools'), detail: '一个文件解析失败' }} />)
    const panel = screen.getByRole('region', { name: '数据质量' })
    expect(within(panel).getByText('部分结论受限')).toBeTruthy()
    expect(within(panel).getByText('影响：结果证据')).toBeTruthy()
    expect(within(panel).getByText(/来源状态，不是 Agent 执行失败/)).toBeTruthy()
    fireEvent.click(within(panel).getByText('查看数据质量详情'))
    fireEvent.click(within(panel).getByText('查看 1 项限制详情'))
    fireEvent.click(within(panel).getByRole('button', { name: '查看 1 条相关记录' }))
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ recordIds: ['failed'], level: 'fact' }))
  })

  it('opens any evidence of a conclusion and passes the complete deduplicated set', () => {
    const onReview = vi.fn()
    render(<EvidenceLinks title="结果证据" recordIds={['failed', 'large', 'failed']} records={records}
      onOpenRecord={vi.fn()} onReview={onReview} />)
    fireEvent.click(screen.getByText('结果证据 · 2 条证据'))
    fireEvent.click(screen.getByRole('button', { name: '第 1 轮 · 步骤 2 · large' }))
    expect(onReview).toHaveBeenCalledWith({ title: '结果证据', recordIds: ['failed', 'large'] }, 'large')
  })

  it('keeps missing evidence visible and offers context without presenting it as causation', () => {
    const onSelect = vi.fn()
    render(<EvidenceReview request={{ title: '恢复链', recordIds: ['failed', 'missing'] }}
      records={records} selectedId="failed" onSelect={onSelect} />)
    expect(screen.getByText('missing · 当前版本未提供')).toBeTruthy()
    fireEvent.click(screen.getByText('相邻记录、调用关系与本轮输入 · 2 条'))
    expect(screen.getByText(/不能据此认定因果或完整模型输入/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /步骤 3 · input/ }))
    expect(onSelect).toHaveBeenCalledWith('input')
  })

  it('does not claim a retry succeeded when the source provides no result', () => {
    render(<Inspector record={{ ...records[0]!, retry: { count: 1 } }} capabilities={capabilities('tools')}
      sourceLabel="ZCode" tab="details" raw={undefined} rawLoading={false} rawError={undefined}
      onTabChange={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('来源未记录重试结果，请核对后续记录。')).toBeTruthy()
    expect(screen.queryByText('请求已恢复')).toBeNull()
  })

  it('shows recorded total tokens and marks preview and missing output boundaries', () => {
    const { rerender } = render(<Inspector
      record={{ ...records[1]!, usage: { totalTokens: 300 }, input: { truncated: true, preview: 'part' } }}
      capabilities={capabilities('tools', 'usage')} sourceLabel="ZCode" tab="details"
      raw={undefined} rawLoading={false} rawError={undefined} onTabChange={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('总量').nextElementSibling?.textContent).toBe('300')
    expect(screen.getByText('输入', { selector: '.metric-strip span' }).nextElementSibling?.textContent).toBe('—')
    expect(screen.getByText(/包含截断预览/)).toBeTruthy()
    rerender(<Inspector record={{ ...records[1]!, output: undefined }} capabilities={capabilities('tools')}
      sourceLabel="ZCode" tab="details" raw={undefined} rawLoading={false} rawError={undefined}
      onTabChange={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('来源未记录工具输出，完成状态不能替代结果验证。')).toBeTruthy()
  })
})
