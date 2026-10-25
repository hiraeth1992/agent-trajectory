import type {
  EvaluationResult,
  EvaluationVerdict,
} from '../../src/evaluation-types'

export type DiagnosisEvidenceView = 'overview' | 'findings' | 'records' | 'record'

export interface DiagnosisEvidenceAccess {
  view: DiagnosisEvidenceView
  snapshotId: string
}

export interface TrajectoryDiagnosisProcessInput {
  snapshotId: string
  evidenceAccesses: DiagnosisEvidenceAccess[]
  liveSourceReads?: string[]
  report: string
}

export interface ProcessCheckDefinition {
  id: string
  criticality: 'required' | 'recommended'
  applicable_if: string
  pass_if: string
}

export interface ProcessCheckSpec {
  id: 'trajectory-diagnosis-contract'
  version: '1'
  evaluatorId: 'trajectory-diagnosis-process'
  evaluatorVersion: '1'
  scope: {
    skill: 'trajectory-diagnosis'
    context: 'frozen-snapshot'
  }
  checks: ProcessCheckDefinition[]
}

const REQUIRED_HEADINGS = [
  '### 【最终目标】',
  '### 【模型思维&行动】',
  '### 【结果】',
  '### 【问题&建议】',
]

function result(
  check: ProcessCheckDefinition,
  verdict: EvaluationVerdict,
  summary: string,
  evidenceBoundary: string,
): EvaluationResult {
  return {
    evaluatorId: 'trajectory-diagnosis-process',
    evaluatorVersion: '1',
    criterionId: check.id,
    verdict,
    confidence: 'high',
    evidenceRecordIds: [],
    counterEvidenceRecordIds: [],
    evidenceBoundary,
    attribution: verdict === 'evaluator_error' ? 'evaluator' : 'agent',
    blockedBy: [],
    denominatorEligible: verdict === 'pass'
      || verdict === 'fail'
      || verdict === 'warning',
    label: verdict === 'pass'
      ? '符合过程规范'
      : verdict === 'warning'
        ? '过程可改进'
        : verdict === 'not_applicable'
          ? '本次不适用'
          : '不符合过程规范',
    summary,
  }
}

function headingResult(
  check: ProcessCheckDefinition,
  report: string,
): EvaluationResult {
  const actual = [...report.matchAll(/^### .+$/gm)].map(match => match[0])
  const pass = actual.length === REQUIRED_HEADINGS.length
    && actual.every((heading, index) => heading === REQUIRED_HEADINGS[index])
  return result(
    check,
    pass ? 'pass' : 'fail',
    pass
      ? '报告严格遵循四段结构。'
      : `报告顶级标题应严格为 ${REQUIRED_HEADINGS.join('、')}。`,
    actual.length === 0 ? '报告没有三级顶级标题。' : `实际标题：${actual.join('、')}`,
  )
}

function recommendationResult(
  check: ProcessCheckDefinition,
  report: string,
): EvaluationResult {
  const section = report.split('### 【问题&建议】')[1]?.trim() ?? ''
  const material = /(?:问题|建议)[:：]/u.test(section)
  if (!material || /无实质问题|没有实质问题|未发现实质问题/u.test(section)) {
    return result(
      check,
      'not_applicable',
      '报告未提出实质修改建议。',
      '仅在存在实质建议时检查建议结构。',
    )
  }
  const required = [
    /(?:证据|record[_ -]?id|turn|step)/iu,
    /修改对象/u,
    /(?:具体改法|直接加入)/u,
    /预期改善/u,
    /验证/u,
  ]
  const missing = required.filter(pattern => !pattern.test(section)).length
  return result(
    check,
    missing === 0 ? 'pass' : 'warning',
    missing === 0
      ? '建议包含证据、单一修改对象、具体改法、预期改善和验证。'
      : `建议结构缺少 ${missing} 类必需信息。`,
    '检查“问题&建议”段的可执行字段，不判断建议内容的业务正确性。',
  )
}

export function evaluateTrajectoryDiagnosisProcess(
  spec: ProcessCheckSpec,
  input: TrajectoryDiagnosisProcessInput,
): EvaluationResult[] {
  const byId = new Map(spec.checks.map(check => [check.id, check]))
  const check = (id: string): ProcessCheckDefinition => {
    const selected = byId.get(id)
    if (selected === undefined) throw new Error(`missing process check: ${id}`)
    return selected
  }
  const firstDetailed = input.evidenceAccesses.findIndex(access =>
    access.view === 'records' || access.view === 'record')
  const overviewIndex = input.evidenceAccesses.findIndex(access =>
    access.view === 'overview')
  const findingsIndex = input.evidenceAccesses.findIndex(access =>
    access.view === 'findings')
  const allFrozen = input.evidenceAccesses.every(access =>
    access.snapshotId === input.snapshotId)
  const startsWithOverviewAndFindings = overviewIndex >= 0
    && findingsIndex >= 0
    && (firstDetailed < 0
      || overviewIndex < firstDetailed && findingsIndex < firstDetailed)
  const detailedAfterContext = firstDetailed < 0 || startsWithOverviewAndFindings
  const noLiveReads = (input.liveSourceReads?.length ?? 0) === 0

  return [
    result(
      check('frozen-target-only'),
      allFrozen ? 'pass' : 'fail',
      allFrozen
        ? '所有证据读取均使用指定冻结 snapshot。'
        : '至少一次证据读取使用了不同 snapshot。',
      `${input.evidenceAccesses.length} 次证据读取。`,
    ),
    result(
      check('overview-findings-first'),
      startsWithOverviewAndFindings ? 'pass' : 'fail',
      startsWithOverviewAndFindings
        ? '先读取 overview 和 findings，再读取明细。'
        : '读取明细前未完成 overview 与 findings。',
      `overview=${overviewIndex}, findings=${findingsIndex}, firstDetailed=${firstDetailed}`,
    ),
    result(
      check('evidence-read-on-demand'),
      detailedAfterContext ? 'pass' : 'warning',
      detailedAfterContext
        ? '明细读取发生在全局事实读取之后。'
        : '明细读取早于 overview/findings，可能扩大无关证据范围。',
      '此检查只验证读取顺序，不判断每次读取是否业务必要。',
    ),
    result(
      check('no-live-source-read'),
      noLiveReads ? 'pass' : 'fail',
      noLiveReads
        ? '没有观察到 live source 或外部系统读取。'
        : `观察到 ${input.liveSourceReads!.length} 次非冻结来源读取。`,
      noLiveReads ? 'liveSourceReads 为空。' : input.liveSourceReads!.join('；'),
    ),
    headingResult(check('four-section-report'), input.report),
    recommendationResult(check('actionable-recommendations'), input.report),
  ]
}
