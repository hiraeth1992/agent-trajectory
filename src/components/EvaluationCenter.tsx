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
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type {
  AnnotationDatasetSummary,
  AnnotationReviewer,
  AnnotationWorkspaceOverview,
} from '../annotation-types'
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
  const [reviewer, setReviewer] = useState<AnnotationReviewer>()
  const [statuses, setStatuses] = useState<Record<AnnotationReviewer, ReviewerStatus>>({
    'reviewer-a': { reviewer: 'reviewer-a', loading: false },
    'reviewer-b': { reviewer: 'reviewer-b', loading: false },
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

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
    if (directoryId === '') return
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
    return () => controllers.forEach(controller => controller.abort())
  }, [directoryId])

  const dataset = useMemo(
    () => datasets.find(item => item.directoryId === directoryId),
    [datasets, directoryId],
  )

  if (reviewer !== undefined && dataset !== undefined) {
    return (
      <AnnotationWorkspace
        dataset={dataset}
        reviewer={reviewer}
        onExit={() => setReviewer(undefined)}
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
                    <button type="button" onClick={() => void loadDatasets()}>
                      重新检测
                    </button>
                  )}
                >
                  <pre>agent-trajectory calibrate prepare --dataset ~/.agent-trajectory/calibration/real-v1 --count 30</pre>
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

                  <section className="evaluation-flow" aria-label="评测流程">
                    <article className="complete">
                      <span><Check size={15} /></span>
                      <div><strong>1. 样本准备</strong><small>30 条冻结候选</small></div>
                    </article>
                    <i />
                    <article className="active">
                      <span>2</span>
                      <div><strong>2. 独立双标</strong><small>Reviewer A / B 分离</small></div>
                    </article>
                    <i />
                    <article>
                      <span>3</span>
                      <div><strong>3. 分歧裁决</strong><small>完成双标后生成</small></div>
                    </article>
                    <i />
                    <article>
                      <span>4</span>
                      <div><strong>4. 基线评测</strong><small>校准 / 回归 / 独立集</small></div>
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
                      <p>两位 Reviewer 需要独立完成相同的 30 条案例，完成前不要互看结果。</p>
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
                </div>
              )}
    </main>
  )
}
