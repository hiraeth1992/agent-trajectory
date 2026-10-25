import {
  AlertTriangle,
  ArrowRight,
  Check,
  Database,
  FileCheck2,
  GitCompareArrows,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  AnnotationDatasetSummary,
  AnnotationActor,
  AnnotationReviewer,
  AnnotationWorkspaceOverview,
  EvaluationRunDetails,
  EvaluationRunResult,
  EvaluationWorkflowStatus,
  PrepareEvaluationDatasetResult,
} from '../annotation-types'
import type { EvaluationSplit } from '../evaluation-types'
import { AppHeader } from './AppHeader'
import { AnnotationWorkspace } from './AnnotationWorkspace'
import { StateView } from './StateView'
import type { AppWorkspace } from './WorkspaceNav'

function responseError(response: Response, fallback: string): Promise<Error> {
  return response.json()
    .then((value: { error?: string }) => new Error(value.error ?? fallback))
    .catch(() => new Error(fallback))
}

function percent(complete: number, total: number): number {
  return total === 0 ? 0 : Math.round(complete / total * 100)
}

function reviewerLabel(reviewer: AnnotationReviewer): string {
  return reviewer === 'reviewer-a' ? 'Reviewer A' : 'Reviewer B'
}

interface ReviewerStatus {
  reviewer: AnnotationReviewer
  loading: boolean
  error?: string
  overview?: AnnotationWorkspaceOverview
}

function ReviewerCard({
  status,
  onEnter,
}: {
  status: ReviewerStatus
  onEnter: (reviewer: AnnotationReviewer) => void
}) {
  const progress = status.overview?.progress ?? { complete: 0, total: 0 }
  return (
    <article className="evaluation-reviewer-card">
      <header>
        <div>
          <Users size={18} />
          <strong>{reviewerLabel(status.reviewer)}</strong>
        </div>
        {progress.total > 0 && (
          <span>{progress.complete} / {progress.total}</span>
        )}
      </header>
      {status.loading
        ? (
            <div className="evaluation-reviewer-loading">
              <LoaderCircle className="annotation-spin" size={16} />
              正在读取独立标注进度…
            </div>
          )
        : status.error !== undefined
          ? <p className="evaluation-reviewer-error">{status.error}</p>
          : (
              <>
                <progress value={progress.complete} max={progress.total || 1} />
                <p>
                  {progress.complete === progress.total && progress.total > 0
                    ? '独立标注已完成，可以进入一致性检查。'
                    : `已完成 ${percent(progress.complete, progress.total)}%，继续填写剩余案例。`}
                </p>
              </>
            )}
      <button
        type="button"
        disabled={status.loading || status.error !== undefined}
        onClick={() => onEnter(status.reviewer)}
      >
        {progress.complete > 0 ? '继续标注' : '开始标注'}
        <ArrowRight size={15} />
      </button>
    </article>
  )
}

export function EvaluationCenter({
  onWorkspaceChange,
}: {
  onWorkspaceChange: (value: AppWorkspace) => void
}) {
  const [datasets, setDatasets] = useState<AnnotationDatasetSummary[]>([])
  const [directoryId, setDirectoryId] = useState(
    () => localStorage.getItem('trajectory.evaluationDataset') ?? '',
  )
  const [reviewer, setReviewer] = useState<AnnotationActor>()
  const [statuses, setStatuses] = useState<Record<AnnotationReviewer, ReviewerStatus>>({
    'reviewer-a': { reviewer: 'reviewer-a', loading: false },
    'reviewer-b': { reviewer: 'reviewer-b', loading: false },
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [workflow, setWorkflow] = useState<EvaluationWorkflowStatus>()
  const [runSplit, setRunSplit] = useState<EvaluationSplit>('calibration')
  const [baselineRunId, setBaselineRunId] = useState('')
  const [runLoading, setRunLoading] = useState(false)
  const [runResult, setRunResult] = useState<EvaluationRunResult>()
  const [runDetails, setRunDetails] = useState<EvaluationRunDetails>()
  const [runDetailsLoading, setRunDetailsLoading] = useState(false)
  const runDetailsRequest = useRef<AbortController>()
  const [workflowRevision, setWorkflowRevision] = useState(0)
  const [prepareOpen, setPrepareOpen] = useState(false)
  const [prepareDirectoryId, setPrepareDirectoryId] = useState('real-v1')
  const [prepareDatasetId, setPrepareDatasetId] = useState(
    'agent-trajectory-private-real',
  )
  const [prepareVersion, setPrepareVersion] = useState('1')
  const [prepareCount, setPrepareCount] = useState(30)
  const [prepareAllowPartial, setPrepareAllowPartial] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [prepareError, setPrepareError] = useState<string>()

  const loadDatasets = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const response = await fetch('/api/annotations/datasets')
      if (!response.ok) {
        const reason = await responseError(response, '评测数据集加载失败')
        throw new Error(response.status === 404
          ? '当前本地服务仍是旧版本，尚未提供评测中心接口。请重启 Agent Trajectory 后重试。'
          : reason.message)
      }
      const result = await response.json() as AnnotationDatasetSummary[]
      setDatasets(result)
      setDirectoryId((current) => {
        const next = current !== '' && result.some(item => item.directoryId === current)
          ? current
          : result[0]?.directoryId ?? ''
        if (next !== '') localStorage.setItem('trajectory.evaluationDataset', next)
        return next
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDatasets()
  }, [loadDatasets])

  useEffect(() => {
    if (directoryId === ''
      || !datasets.some(item => item.directoryId === directoryId)) return
    const controllers = new Map<AnnotationReviewer, AbortController>()
    for (const selected of ['reviewer-a', 'reviewer-b'] as const) {
      const controller = new AbortController()
      controllers.set(selected, controller)
      setStatuses(current => ({
        ...current,
        [selected]: { reviewer: selected, loading: true },
      }))
      void fetch(
        `/api/annotations/datasets/${encodeURIComponent(directoryId)}/${selected}`,
        { signal: controller.signal },
      ).then(async (response) => {
        if (!response.ok) throw await responseError(response, '标注进度加载失败')
        const overview = await response.json() as AnnotationWorkspaceOverview
        setStatuses(current => ({
          ...current,
          [selected]: { reviewer: selected, loading: false, overview },
        }))
      }).catch((caught) => {
        if (!controller.signal.aborted) {
          setStatuses(current => ({
            ...current,
            [selected]: {
              reviewer: selected,
              loading: false,
              error: caught instanceof Error ? caught.message : String(caught),
            },
          }))
        }
      })
    }
    const workflowController = new AbortController()
    void fetch(
      `/api/annotations/datasets/${encodeURIComponent(directoryId)}/workflow`,
      { signal: workflowController.signal },
    ).then(async (response) => {
      if (!response.ok) throw await responseError(response, '评测流程状态加载失败')
      setWorkflow(await response.json() as EvaluationWorkflowStatus)
    }).catch((caught) => {
      if (!workflowController.signal.aborted) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    })
    return () => {
      controllers.forEach(controller => controller.abort())
      workflowController.abort()
    }
  }, [datasets, directoryId, workflowRevision])

  useEffect(() => {
    runDetailsRequest.current?.abort()
    runDetailsRequest.current = undefined
    setBaselineRunId('')
    setRunResult(undefined)
    setRunDetails(undefined)
    setRunDetailsLoading(false)
  }, [directoryId])

  useEffect(() => () => {
    runDetailsRequest.current?.abort()
  }, [])

  const dataset = useMemo(
    () => datasets.find(item => item.directoryId === directoryId),
    [datasets, directoryId],
  )
  const reviewComplete = workflow?.reviewersComplete === true
  const adjudicationComplete = workflow?.adjudication.complete === true
  const runComplete = (workflow?.runs.length ?? 0) > 0
  const compatibleBaselineRuns = useMemo(
    () => workflow?.runs.filter(run => run.split === runSplit) ?? [],
    [runSplit, workflow?.runs],
  )
  useEffect(() => {
    if (baselineRunId !== ''
      && !compatibleBaselineRuns.some(run => run.runId === baselineRunId)) {
      setBaselineRunId('')
    }
  }, [baselineRunId, compatibleBaselineRuns])
  const openRunDetails = async (runId: string) => {
    if (directoryId === '') return
    runDetailsRequest.current?.abort()
    const controller = new AbortController()
    runDetailsRequest.current = controller
    setRunDetailsLoading(true)
    setError(undefined)
    try {
      const response = await fetch(
        `/api/annotations/datasets/${encodeURIComponent(
          directoryId,
        )}/workflow/runs/${encodeURIComponent(runId)}`,
        { signal: controller.signal },
      )
      if (!response.ok) throw await responseError(response, 'EvaluationRun 详情加载失败')
      if (runDetailsRequest.current !== controller) return
      setRunDetails(await response.json() as EvaluationRunDetails)
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      if (runDetailsRequest.current === controller) {
        runDetailsRequest.current = undefined
        setRunDetailsLoading(false)
      }
    }
  }
  const startEvaluationRun = async () => {
    if (directoryId === '' || !adjudicationComplete || runLoading) return
    if (runSplit === 'independent'
      && !window.confirm('独立验收集只应在最终验收时运行。确认现在解封并运行吗？')) {
      return
    }
    setRunLoading(true)
    setError(undefined)
    try {
      const response = await fetch(
        `/api/annotations/datasets/${encodeURIComponent(directoryId)}/workflow/run`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            split: runSplit,
            ...(baselineRunId === '' ? {} : { baselineRunId }),
            ...(runSplit === 'independent' ? { confirmIndependent: true } : {}),
          }),
        },
      )
      if (!response.ok) throw await responseError(response, 'EvaluationRun 执行失败')
      const result = await response.json() as EvaluationRunResult
      setRunResult(result)
      setRunDetails({
        run: result.run,
        diffs: result.diff === undefined ? [] : [result.diff],
      })
      setWorkflowRevision(current => current + 1)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setRunLoading(false)
    }
  }
  const prepareDataset = async () => {
    if (preparing) return
    setPreparing(true)
    setPrepareError(undefined)
    try {
      const response = await fetch('/api/annotations/datasets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directoryId: prepareDirectoryId,
          datasetId: prepareDatasetId,
          datasetVersion: prepareVersion,
          count: prepareCount,
          allowPartial: prepareAllowPartial,
        }),
      })
      if (!response.ok) throw await responseError(response, '评测数据集准备失败')
      const result = await response.json() as PrepareEvaluationDatasetResult
      localStorage.setItem('trajectory.evaluationDataset', result.dataset.directoryId)
      setDirectoryId(result.dataset.directoryId)
      setPrepareOpen(false)
      await loadDatasets()
    } catch (caught) {
      setPrepareError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setPreparing(false)
    }
  }

  if (reviewer !== undefined && dataset !== undefined) {
    return (
      <AnnotationWorkspace
        dataset={dataset}
        reviewer={reviewer}
        onExit={() => {
          setReviewer(undefined)
          setWorkflowRevision(current => current + 1)
        }}
      />
    )
  }

  return (
    <main className={`evaluation-center${datasets.length > 1 ? ' with-header-context' : ''}`}>
      <AppHeader
        workspace="evaluation"
        onWorkspaceChange={onWorkspaceChange}
        context={datasets.length > 1
          ? (
              <label className="evaluation-dataset-picker">
                <span>数据集</span>
                <select
                  value={directoryId}
                  onChange={event => {
                    localStorage.setItem('trajectory.evaluationDataset', event.target.value)
                    setDirectoryId(event.target.value)
                  }}
                >
                  {datasets.map(item => (
                    <option value={item.directoryId} key={item.directoryId}>
                      {item.datasetId}@{item.datasetVersion}
                    </option>
                  ))}
                </select>
              </label>
            )
          : undefined}
        actions={(
          <button
            type="button"
            className="icon-button"
            onClick={() => void loadDatasets()}
            title="刷新评测中心"
          >
            <RefreshCw size={16} />
          </button>
        )}
      />

      {loading
        ? (
            <StateView
              className="evaluation-page-state"
              icon={<LoaderCircle className="annotation-spin" size={24} />}
              title="正在读取本地评测数据集"
              description="正在检查冻结样本、隐私审计和双标进度…"
            />
          )
        : error !== undefined
          ? (
              <StateView
                className="evaluation-page-state"
                tone="danger"
                icon={<AlertTriangle size={28} />}
                title="评测中心不可用"
                description={error}
                action={(
                  <button type="button" onClick={() => void loadDatasets()}>
                    重新检测
                  </button>
                )}
              />
            )
          : dataset === undefined
            ? (
                <StateView
                  className="evaluation-page-state"
                  icon={<Database size={30} />}
                  title="尚未准备评测数据集"
                  description="评测中心只使用经过冻结、匿名化和隐私审计的本地轨迹。"
                  action={(
                    <div className="evaluation-empty-actions">
                      <button
                        type="button"
                        className="primary"
                        onClick={() => {
                          setPrepareError(undefined)
                          setPrepareOpen(true)
                        }}
                      >
                        准备数据集
                      </button>
                      <button type="button" onClick={() => void loadDatasets()}>
                        重新检测
                      </button>
                    </div>
                  )}
                >
                  <p className="evaluation-empty-hint">
                    你将先确认数据集名称、样本数量和 partial 策略；系统不会自动开始扫描。
                  </p>
                </StateView>
              )
            : (
                <div className="evaluation-center-content">
                  <section className="evaluation-hero">
                    <div>
                      <span className="evaluation-kicker">本地真实轨迹校准</span>
                      <h1>{dataset.datasetId}</h1>
                      <p>
                        版本 {dataset.datasetVersion} · {dataset.cases} 个案例 ·
                        DSH {dataset.sources.dsh} · Codex {dataset.sources.codex} ·
                        ZCode {dataset.sources.zcode}
                      </p>
                    </div>
                    <span className="evaluation-audit-ok">
                      <ShieldCheck size={17} />
                      隐私审计已通过
                    </span>
                  </section>

                  {dataset.allowPartial && (
                    <section className="evaluation-partial-warning" role="status">
                      <AlertTriangle size={17} />
                      <p>
                        请求 {dataset.requestedCases} 条，实际冻结 {dataset.cases} 条，
                        跳过 {dataset.skippedCases} 条。当前数据集是显式 partial，
                        split 分布和评测置信度可能不同于完整采样。
                      </p>
                    </section>
                  )}

                  <section className="evaluation-flow" aria-label="评测流程">
                    <article className="complete">
                      <span><Check size={15} /></span>
                      <div>
                        <strong>1. 样本准备</strong>
                        <small>{dataset.cases} 条冻结候选</small>
                      </div>
                    </article>
                    <i />
                    <article className={reviewComplete ? 'complete' : 'active'}>
                      <span>2</span>
                      <div>
                        <strong>2. 独立双标</strong>
                        <small>{reviewComplete ? '双方标注已完成' : 'Reviewer A / B 分离'}</small>
                      </div>
                    </article>
                    <i />
                    <article className={adjudicationComplete
                      ? 'complete'
                      : reviewComplete ? 'active' : ''}>
                      <span>3</span>
                      <div>
                        <strong>3. 分歧裁决</strong>
                        <small>{adjudicationComplete
                          ? '完整裁决已通过校验'
                          : workflow?.agreement === undefined
                            ? '完成双标后生成'
                            : `${workflow.agreement.disagreements} 项分歧待裁决`}</small>
                      </div>
                    </article>
                    <i />
                    <article className={runComplete
                      ? 'complete'
                      : adjudicationComplete ? 'active' : ''}>
                      <span>4</span>
                      <div>
                        <strong>4. 基线评测</strong>
                        <small>{runComplete
                          ? `${workflow!.runs.length} 个 EvaluationRun`
                          : '校准 / 回归 / 独立集'}</small>
                      </div>
                    </article>
                  </section>

                  <section className="evaluation-overview-grid">
                    <article className="evaluation-split-card">
                      <header>
                        <FileCheck2 size={18} />
                        <strong>样本分层</strong>
                      </header>
                      <dl>
                        <div><dt>校准集</dt><dd>{dataset.splits.calibration}</dd></div>
                        <div><dt>回归集</dt><dd>{dataset.splits.regression}</dd></div>
                        <div><dt>独立验收</dt><dd>{dataset.splits.independent}</dd></div>
                      </dl>
                      <p>规则开发只使用校准集；独立集只在最终验收时运行。</p>
                    </article>
                    <article className="evaluation-next-card">
                      <header>
                        <GitCompareArrows size={18} />
                        <strong>当前阶段</strong>
                      </header>
                      <p>
                        两位 Reviewer 需要独立完成相同的 {dataset.cases} 条案例，
                        完成前不要互看结果。
                      </p>
                      <span>双方完成后才能生成一致性报告和 adjudication。</span>
                    </article>
                  </section>

                  <section className="evaluation-reviewers">
                    <header>
                      <div>
                        <Users size={19} />
                        <strong>人工双标</strong>
                      </div>
                      <span>只展示完成进度，不展示具体标签或对方内容</span>
                    </header>
                    <div>
                      <ReviewerCard status={statuses['reviewer-a']} onEnter={setReviewer} />
                      <ReviewerCard status={statuses['reviewer-b']} onEnter={setReviewer} />
                    </div>
                  </section>

                  {workflow?.agreement !== undefined && (
                    <section className="evaluation-workflow-results">
                      <header>
                        <GitCompareArrows size={19} />
                        <strong>一致性与裁决</strong>
                      </header>
                      <dl>
                        <div>
                          <dt>Criterion agreement</dt>
                          <dd>{workflow.agreement.criterionExactAgreement === undefined
                            ? 'N/A'
                            : `${Math.round(workflow.agreement.criterionExactAgreement * 100)}%`}</dd>
                        </div>
                        <div>
                          <dt>Criterion Kappa</dt>
                          <dd>{workflow.agreement.criterionKappa?.toFixed(3) ?? 'N/A'}</dd>
                        </div>
                        <div>
                          <dt>分歧</dt>
                          <dd>{workflow.agreement.disagreements}</dd>
                        </div>
                        <div>
                          <dt>裁决</dt>
                          <dd>{adjudicationComplete ? '完整' : '未完成'}</dd>
                        </div>
                      </dl>
                      {workflow.adjudication.exists && (
                        <button
                          type="button"
                          onClick={() => setReviewer('adjudicator')}
                        >
                          {workflow.adjudication.complete ? '复核裁决' : '进入分歧裁决'}
                          <ArrowRight size={15} />
                        </button>
                      )}
                    </section>
                  )}

                  {workflow !== undefined && workflow.runs.length > 0 && (
                    <section className="evaluation-run-list">
                      <header>
                        <FileCheck2 size={19} />
                        <strong>EvaluationRun</strong>
                        <span>只展示与当前 manifest hash 匹配的本地结果</span>
                      </header>
                      {workflow.runs.map(run => (
                        <article key={`${run.file}:${run.runId}`}>
                          <div>
                            <strong>{run.split ?? 'all'} · {run.evaluatorId}</strong>
                            <code>{run.runId}</code>
                          </div>
                          <span>
                            assertion {Math.round(run.assertionAgreement * 100)}% ·
                            evaluator error {run.evaluatorError}
                          </span>
                          <button
                            type="button"
                            disabled={runDetailsLoading}
                            onClick={() => void openRunDetails(run.runId)}
                          >
                            查看详情
                          </button>
                        </article>
                      ))}
                    </section>
                  )}

                  {adjudicationComplete && (
                    <section className="evaluation-run-list">
                      <header>
                        <FileCheck2 size={19} />
                        <strong>运行评测</strong>
                        <span>使用当前完整裁决和 manifest-bound full Gold</span>
                      </header>
                      <div className="evaluation-run-controls">
                        <label>
                          <span>Split</span>
                          <select
                            aria-label="评测 split"
                            value={runSplit}
                            onChange={(event) => {
                              setRunSplit(event.target.value as EvaluationSplit)
                              setBaselineRunId('')
                            }}
                          >
                            <option value="calibration">calibration</option>
                            <option value="regression">regression</option>
                            <option value="independent">independent</option>
                          </select>
                        </label>
                        <label>
                          <span>Baseline</span>
                          <select
                            aria-label="评测 baseline"
                            value={baselineRunId}
                            onChange={event => setBaselineRunId(event.target.value)}
                          >
                            <option value="">不比较</option>
                            {compatibleBaselineRuns.map(run => (
                              <option value={run.runId} key={run.runId}>
                                {run.split} · {run.runId}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          disabled={runLoading}
                          onClick={() => void startEvaluationRun()}
                        >
                          {runLoading ? '运行中…' : '运行 EvaluationRun'}
                        </button>
                      </div>
                      {runResult !== undefined && (
                        <article>
                          <div>
                            <strong>{runResult.run.split} · 完成</strong>
                            <code>{runResult.run.runId}</code>
                          </div>
                          <span>
                            assertion {Math.round(
                              runResult.run.assertionAgreement * 100,
                            )}% · gate {runResult.diff?.gateDecision ?? '未比较'}
                          </span>
                        </article>
                      )}
                    </section>
                  )}

                  {runDetails !== undefined && (
                    <section className="evaluation-run-details">
                      <header>
                        <div>
                          <strong>Run 详情 · {runDetails.run.split}</strong>
                          <code>{runDetails.run.runId}</code>
                        </div>
                        <span>
                          assertion {Math.round(runDetails.run.assertionAgreement * 100)}% ·
                          evaluator error {runDetails.run.evaluatorError}
                        </span>
                      </header>
                      {runDetails.diffs.map(diff => (
                        <article
                          className={`evaluation-diff-summary gate-${diff.gateDecision}`}
                          key={`${diff.baselineRunId}:${diff.candidateRunId}`}
                        >
                          <strong>
                            baseline {diff.baselineRunId} · gate {diff.gateDecision}
                          </strong>
                          <span>
                            改善 {diff.improved} · 退化 {diff.regressed} ·
                            混合 {diff.mixed} · 不确定 {diff.inconclusive}
                          </span>
                          {diff.gateReasons.length > 0 && (
                            <p>{diff.gateReasons.join('；')}</p>
                          )}
                          {diff.caseDirections.some(item =>
                            item.direction !== 'unchanged') && (
                            <ul>
                              {diff.caseDirections
                                .filter(item => item.direction !== 'unchanged')
                                .map(item => (
                                  <li key={item.caseId}>
                                    {item.caseId}：{item.direction}
                                  </li>
                                ))}
                            </ul>
                          )}
                          {diff.changedCriteria.length > 0 && (
                            <ul>
                              {diff.changedCriteria.map(change => (
                                <li key={`${change.caseId}:${change.criterionId}`}>
                                  {change.caseId} / {change.criterionId}：
                                  {change.baseline ?? '缺失'} → {change.candidate ?? '缺失'}
                                  （{change.direction}）
                                </li>
                              ))}
                            </ul>
                          )}
                        </article>
                      ))}
                      <div className="evaluation-case-details">
                        {runDetails.run.cases.map(result => (
                          <details
                            key={result.caseId}
                            open={result.error !== undefined || result.mismatches.length > 0}
                          >
                            <summary>
                              <strong>{result.caseId}</strong>
                              <span>
                                assertion {result.assertionsPassed}/{result.assertionsTotal}
                                {result.exact === undefined
                                  ? ''
                                  : ` · exact ${result.exact ? '是' : '否'}`}
                              </span>
                            </summary>
                            {result.error !== undefined && (
                              <p className="evaluation-case-error">{result.error}</p>
                            )}
                            <div className="evaluation-criterion-list">
                              {result.criteria.map(criterion => (
                                <article key={criterion.criterionId}>
                                  <strong>{criterion.criterionId}</strong>
                                  <span>
                                    {criterion.verdict} · {criterion.attribution}
                                  </span>
                                  <code>
                                    证据 {criterion.evidenceRecordIds.join(', ') || '无'}
                                  </code>
                                </article>
                              ))}
                            </div>
                            {result.mismatches.length > 0 && (
                              <ul className="evaluation-mismatch-list">
                                {result.mismatches.map((mismatch, index) => (
                                  <li key={`${mismatch.criterionId}:${index}`}>
                                    {mismatch.criterionId}：期望 {mismatch.expected}，
                                    实际 {mismatch.actual ?? '缺失'}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </details>
                        ))}
                      </div>
                    </section>
                  )}

                  {workflow !== undefined && workflow.casebook.total > 0 && (
                    <section className="evaluation-workflow-results">
                      <header>
                        <AlertTriangle size={19} />
                        <strong>Badcase Casebook</strong>
                      </header>
                      <dl>
                        <div><dt>待处理</dt><dd>{workflow.casebook.open}</dd></div>
                        <div><dt>已解决</dt><dd>{workflow.casebook.resolved}</dd></div>
                        <div><dt>已采纳</dt><dd>{workflow.casebook.accepted}</dd></div>
                        <div><dt>已复测</dt><dd>{workflow.casebook.retested}</dd></div>
                      </dl>
                    </section>
                  )}
                </div>
              )}
      {prepareOpen && (
        <div
          className="evaluation-prepare-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !preparing) {
              setPrepareOpen(false)
            }
          }}
        >
          <section
            className="evaluation-prepare-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="evaluation-prepare-title"
          >
            <header>
              <div>
                <strong id="evaluation-prepare-title">准备真实轨迹评测数据集</strong>
                <span>创建本机私有的冻结样本，不修改任何来源会话。</span>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭准备数据集弹窗"
                disabled={preparing}
                onClick={() => setPrepareOpen(false)}
              >
                <X size={16} />
              </button>
            </header>
            <div className="evaluation-prepare-form">
              <label>
                <span>目录标识</span>
                <input
                  aria-label="目录标识"
                  value={prepareDirectoryId}
                  disabled={preparing}
                  pattern="[A-Za-z0-9][A-Za-z0-9._-]{1,80}"
                  onChange={event => setPrepareDirectoryId(event.target.value)}
                />
                <small>保存在当前数据目录的 calibration/{prepareDirectoryId || '…'}。</small>
              </label>
              <label>
                <span>数据集 ID</span>
                <input
                  aria-label="数据集 ID"
                  value={prepareDatasetId}
                  disabled={preparing}
                  pattern="[a-z0-9][a-z0-9._-]{2,80}"
                  onChange={event => setPrepareDatasetId(event.target.value)}
                />
              </label>
              <div className="evaluation-prepare-inline">
                <label>
                  <span>版本</span>
                  <input
                    aria-label="版本"
                    value={prepareVersion}
                    disabled={preparing}
                    pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,40}"
                    onChange={event => setPrepareVersion(event.target.value)}
                  />
                </label>
                <label>
                  <span>样本数</span>
                  <input
                    aria-label="样本数"
                    type="number"
                    min={3}
                    max={120}
                    value={prepareCount}
                    disabled={preparing}
                    onChange={event => setPrepareCount(Number(event.target.value))}
                  />
                </label>
              </div>
              <label className="evaluation-prepare-checkbox">
                <input
                  aria-label="允许部分数据集"
                  type="checkbox"
                  checked={prepareAllowPartial}
                  disabled={preparing}
                  onChange={event => setPrepareAllowPartial(event.target.checked)}
                />
                <span>
                  候选不足时允许生成较小数据集
                  <small>
                    默认不勾选：必须严格达到样本数，否则失败且不生成可用数据集。
                  </small>
                </span>
              </label>
              <div className="evaluation-prepare-warning" role="note">
                <AlertTriangle size={17} />
                <p>
                  确认后会读取本机 DSH、Codex 和 ZCode 的可用会话，冻结并脱敏副本，
                  执行隐私审计，然后生成 Reviewer A/B 模板。原始会话保持只读；
                  冻结样本仍可能包含评测所必需的业务文本，只应保存在本机。
                </p>
              </div>
              {prepareError !== undefined && (
                <p className="evaluation-prepare-error" role="alert">{prepareError}</p>
              )}
            </div>
            <footer>
              <button
                type="button"
                disabled={preparing}
                onClick={() => setPrepareOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary"
                disabled={preparing
                  || prepareDirectoryId === ''
                  || prepareDatasetId === ''
                  || prepareVersion === ''
                  || !Number.isInteger(prepareCount)
                  || prepareCount < 3
                  || prepareCount > 120}
                onClick={() => void prepareDataset()}
              >
                {preparing
                  ? <><LoaderCircle className="annotation-spin" size={15} />准备中…</>
                  : '确认并开始准备'}
              </button>
            </footer>
          </section>
        </div>
      )}
    </main>
  )
}
