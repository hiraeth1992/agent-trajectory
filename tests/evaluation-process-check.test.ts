import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  evaluateTrajectoryDiagnosisProcess,
  type ProcessCheckSpec,
} from '../server/evaluation/process-check'
import { aggregateEvaluationResults } from '../src/trajectory-evaluation'

const spec = JSON.parse(readFileSync(
  new URL('../skills/trajectory-diagnosis/process-check.json', import.meta.url),
  'utf8',
)) as ProcessCheckSpec

const report = `### 【最终目标】

完成冻结轨迹诊断。

### 【模型思维&行动】

先读全局事实，再读取必要记录。

### 【结果】

结论有冻结证据支持。

### 【问题&建议】

问题：验证缺失，证据 record_id=tool-1。
建议：
- 修改对象：项目根目录 AGENTS.md。
- 直接加入：完成修改后运行测试。
- 预期改善：减少未验证完成。
- 验证：测试通过且退出码为 0。
`

describe('trajectory-diagnosis process check', () => {
  it('passes a frozen, ordered, four-section evidence loop', () => {
    const results = evaluateTrajectoryDiagnosisProcess(spec, {
      snapshotId: 'snapshot-1',
      evidenceAccesses: [
        { view: 'overview', snapshotId: 'snapshot-1' },
        { view: 'findings', snapshotId: 'snapshot-1' },
        { view: 'records', snapshotId: 'snapshot-1' },
        { view: 'record', snapshotId: 'snapshot-1' },
      ],
      report,
    })

    expect(results).toHaveLength(6)
    expect(results.every(result => result.verdict === 'pass')).toBe(true)
    expect(aggregateEvaluationResults(results)).toMatchObject({
      total: 6,
      pass: 6,
      denominatorEligible: 6,
    })
  })

  it('separates hard process failures, warnings, and non-applicable recommendations', () => {
    const results = evaluateTrajectoryDiagnosisProcess(spec, {
      snapshotId: 'snapshot-1',
      evidenceAccesses: [
        { view: 'record', snapshotId: 'other-snapshot' },
        { view: 'overview', snapshotId: 'snapshot-1' },
      ],
      liveSourceReads: ['GET /api/sessions/dsh/live-session'],
      report: `### 【最终目标】

诊断。

### 【结果】

没有实质问题。
`,
    })
    const byId = new Map(results.map(result => [result.criterionId, result]))

    expect(byId.get('frozen-target-only')?.verdict).toBe('fail')
    expect(byId.get('overview-findings-first')?.verdict).toBe('fail')
    expect(byId.get('evidence-read-on-demand')?.verdict).toBe('warning')
    expect(byId.get('no-live-source-read')?.verdict).toBe('fail')
    expect(byId.get('four-section-report')?.verdict).toBe('fail')
    expect(byId.get('actionable-recommendations')?.verdict).toBe('not_applicable')
    expect(byId.get('actionable-recommendations')?.denominatorEligible).toBe(false)
  })

  it('keeps the checked spec synchronized with the diagnosis skill contract', () => {
    expect(spec).toMatchObject({
      id: 'trajectory-diagnosis-contract',
      version: '1',
      evaluatorId: 'trajectory-diagnosis-process',
      evaluatorVersion: '1',
      scope: {
        skill: 'trajectory-diagnosis',
        context: 'frozen-snapshot',
      },
    })
    expect(spec.checks.map(check => check.id)).toEqual([
      'frozen-target-only',
      'overview-findings-first',
      'evidence-read-on-demand',
      'no-live-source-read',
      'four-section-report',
      'actionable-recommendations',
    ])
    expect(spec.checks.every(check =>
      check.applicable_if !== '' && check.pass_if !== '')).toBe(true)
  })
})
