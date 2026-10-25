import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  LoaderCircle,
  Plus,
  Save,
  Search,
  Trash2,
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
  AnnotationCaseListItem,
  AnnotationCaseWorkspace,
  AnnotationDatasetSummary,
  AnnotationRecordDetail,
  AnnotationRecordSummary,
  AnnotationReviewer,
  AnnotationSaveResult,
  AnnotationWorkspaceOverview,
} from '../annotation-types'
import {
  ANNOTATION_ATTRIBUTIONS,
  ANNOTATION_CHAIN_STATES,
  ANNOTATION_CRITERIA,
  ANNOTATION_REQUIREMENT_STATES,
  ANNOTATION_VERDICTS,
  annotationCaseComplete,
} from '../annotation-types'
import type {
  EvaluationAttribution,
  EvaluationVerdict,
  HumanCaseAnnotation,
  HumanRequirementAnnotation,
  RequirementState,
} from '../evaluation-types'
import { json, KIND_LABELS } from '../trajectory-view-model'

function clone<T>(value: T): T {
  return structuredClone(value)
}

function sourceLabel(source: AnnotationCaseListItem['source']): string {
  return source === 'dsh' ? 'DSH' : source === 'codex' ? 'Codex' : 'ZCode'
}

function splitLabel(split: AnnotationCaseListItem['split']): string {
  return split === 'calibration'
    ? '校准'
    : split === 'regression' ? '回归' : '独立验收'
}

function reviewerLabel(reviewer: AnnotationReviewer): string {
  return reviewer === 'reviewer-a' ? 'Reviewer A' : 'Reviewer B'
}

function responseError(response: Response, fallback: string): Promise<Error> {
  return response.json()
    .then((value: { error?: string }) => new Error(value.error ?? fallback))
    .catch(() => new Error(fallback))
}

function recordMatches(record: AnnotationRecordSummary, query: string): boolean {
  if (query === '') return true
  const selected = query.toLowerCase()
  return [
    record.id,
    record.title,
    record.summary,
    record.kind,
    record.status,
    String(record.turn),
    String(record.step),
  ].join(' ').toLowerCase().includes(selected)
}

type RecordFilter = 'key' | 'user' | 'assistant' | 'tool' | 'error' | 'all'
type AnnotationMobilePane = 'cases' | 'evidence' | 'form'

const VALIDATION_RECORD = /(?:test|pytest|vitest|jest|lint|typecheck|build|compile|verify|check|测试|验证|构建|编译)/i

function recordInFilter(
  record: AnnotationRecordSummary,
  filter: RecordFilter,
  lastRecordIds: ReadonlySet<string>,
): boolean {
  if (filter === 'all') return true
  if (filter === 'user') return record.kind === 'user' || record.kind === 'steering'
  if (filter === 'assistant') return record.kind === 'assistant'
  if (filter === 'tool') return record.kind === 'tool' || record.kind === 'subtool'
  if (filter === 'error') {
    return record.status === 'error'
      || record.status === 'interrupted'
      || record.hasError
  }
  return record.kind === 'user'
    || record.kind === 'steering'
    || record.status === 'error'
    || record.status === 'interrupted'
    || record.hasError
    || VALIDATION_RECORD.test(`${record.title} ${record.summary}`)
    || lastRecordIds.has(record.id)
}

function toggleEvidence(
  ids: string[],
  recordId: string,
): string[] {
  return ids.includes(recordId)
    ? ids.filter(id => id !== recordId)
    : [...ids, recordId]
}

function RequirementEditor({
  requirements,
  evidenceTarget,
  onChange,
  onEvidenceTarget,
  onRemove,
}: {
  requirements: HumanRequirementAnnotation[]
  evidenceTarget: string | undefined
  onChange: (index: number, value: HumanRequirementAnnotation) => void
  onEvidenceTarget: (value: string) => void
  onRemove: (index: number) => void
}) {
  return (
    <div className="annotation-requirements">
      {requirements.map((requirement, index) => (
        <article
          className={evidenceTarget === `requirement:${index}`
            ? 'annotation-form-card evidence-active'
            : 'annotation-form-card'}
          key={`${requirement.id}:${index}`}
        >
          <header>
            <strong>要求 {index + 1}</strong>
            <button
              type="button"
              className="icon-button"
              title="删除要求"
              onClick={() => onRemove(index)}
            >
              <Trash2 size={15} />
            </button>
          </header>
          <label>
            <span>要求概括</span>
            <textarea
              value={requirement.text}
              onChange={event => onChange(index, {
                ...requirement,
                text: event.target.value,
              })}
            />
          </label>
          <div className="annotation-inline-fields">
            <label>
              <span>是否必须完成</span>
              <select
                value={requirement.required ? 'true' : 'false'}
                onChange={event => onChange(index, {
                  ...requirement,
                  required: event.target.value === 'true',
                })}
              >
                <option value="true">是</option>
                <option value="false">否</option>
              </select>
            </label>
            <label>
              <span>完成状态</span>
              <select
                value={requirement.state ?? ''}
                onChange={event => onChange(index, {
                  ...requirement,
                  state: (event.target.value || undefined) as RequirementState | undefined,
                })}
              >
                <option value="">请选择</option>
                {ANNOTATION_REQUIREMENT_STATES.map(option => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="button"
            className="annotation-evidence-button"
            onClick={() => onEvidenceTarget(`requirement:${index}`)}
          >
            选择证据 · {requirement.evidenceRecordIds.length} 条
          </button>
          {requirement.evidenceRecordIds.length > 0 && (
            <div className="annotation-evidence-chips">
              {requirement.evidenceRecordIds.map(id => <code key={id}>{id}</code>)}
            </div>
          )}
          <label>
            <span>中文说明</span>
            <textarea
              value={requirement.notes}
              onChange={event => onChange(index, {
                ...requirement,
                notes: event.target.value,
              })}
            />
          </label>
        </article>
      ))}
    </div>
  )
}

export function AnnotationWorkspace({
  dataset,
  reviewer,
  onExit,
}: {
  dataset: AnnotationDatasetSummary
  reviewer: AnnotationReviewer
  onExit: () => void
}) {
  const directoryId = dataset.directoryId
  const [overview, setOverview] = useState<AnnotationWorkspaceOverview>()
  const [caseId, setCaseId] = useState('')
  const [workspace, setWorkspace] = useState<AnnotationCaseWorkspace>()
  const [draft, setDraft] = useState<HumanCaseAnnotation>()
  const [recordDetail, setRecordDetail] = useState<AnnotationRecordDetail>()
  const [query, setQuery] = useState('')
  const [recordFilter, setRecordFilter] = useState<RecordFilter>('key')
  const [evidenceTarget, setEvidenceTarget] = useState<string>('criterion:outcome')
  const [caseLoading, setCaseLoading] = useState(false)
  const [recordLoading, setRecordLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()
  const [mobilePane, setMobilePane] = useState<AnnotationMobilePane>('cases')
  const dirty = useRef(false)

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty.current) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  useEffect(() => {
    if (directoryId === '') {
      setOverview(undefined)
      return
    }
    const controller = new AbortController()
    setError(undefined)
    void fetch(
      `/api/annotations/datasets/${encodeURIComponent(directoryId)}/${reviewer}`,
      { signal: controller.signal },
    ).then(async (response) => {
      if (!response.ok) throw await responseError(response, '标注进度加载失败')
      const result = await response.json() as AnnotationWorkspaceOverview
      setOverview(result)
      setCaseId(current =>
        current !== '' && result.cases.some(item => item.id === current)
          ? current
          : result.cases.find(item => !item.complete)?.id
            ?? result.cases[0]?.id
            ?? '')
    }).catch((caught) => {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    })
    return () => controller.abort()
  }, [directoryId, reviewer])

  useEffect(() => {
    if (directoryId === '' || caseId === '') {
      setWorkspace(undefined)
      setDraft(undefined)
      return
    }
    const controller = new AbortController()
    setCaseLoading(true)
    setError(undefined)
    setRecordDetail(undefined)
    void fetch(
      `/api/annotations/datasets/${encodeURIComponent(directoryId)}/${reviewer}/cases/${
        encodeURIComponent(caseId)
      }`,
      { signal: controller.signal },
    ).then(async (response) => {
      if (!response.ok) throw await responseError(response, '标注案例加载失败')
      const result = await response.json() as AnnotationCaseWorkspace
      setWorkspace(result)
      setDraft(clone(result.annotation))
      setSaved(false)
      dirty.current = false
    }).catch((caught) => {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    }).finally(() => {
      if (!controller.signal.aborted) setCaseLoading(false)
    })
    return () => controller.abort()
  }, [caseId, directoryId, reviewer])

  const mutateDraft = useCallback((mutate: (value: HumanCaseAnnotation) => void) => {
    setDraft(current => {
      if (current === undefined) return current
      const next = clone(current)
      mutate(next)
      dirty.current = true
      setSaved(false)
      return next
    })
  }, [])

  const selectedCaseIndex = overview?.cases.findIndex(item => item.id === caseId) ?? -1
  const lastRecordIds = useMemo(() => {
    const byTurn = new Map<number, AnnotationRecordSummary>()
    for (const record of workspace?.records ?? []) byTurn.set(record.turn, record)
    return new Set([...byTurn.values()].map(record => record.id))
  }, [workspace])
  const filteredRecords = useMemo(
    () => (workspace?.records ?? []).filter(record =>
      recordMatches(record, query)
      && recordInFilter(record, recordFilter, lastRecordIds)),
    [lastRecordIds, query, recordFilter, workspace],
  )

  const openRecord = useCallback(async (record: AnnotationRecordSummary) => {
    if (directoryId === '' || workspace === undefined) return
    setRecordLoading(true)
    setError(undefined)
    try {
      const response = await fetch(
        `/api/annotations/datasets/${encodeURIComponent(directoryId)}/${reviewer}/cases/${
          encodeURIComponent(workspace.candidate.id)
        }/records/${encodeURIComponent(record.id)}`,
      )
      if (!response.ok) throw await responseError(response, '证据详情加载失败')
      setRecordDetail(await response.json() as AnnotationRecordDetail)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setRecordLoading(false)
    }
  }, [directoryId, reviewer, workspace])

  const targetEvidence = useCallback((recordId: string) => {
    if (evidenceTarget.startsWith('criterion:')) {
      const criterionId = evidenceTarget.slice('criterion:'.length)
      mutateDraft((next) => {
        const criterion = next.criteria.find(item => item.criterionId === criterionId)
        if (criterion !== undefined) {
          criterion.evidenceRecordIds = toggleEvidence(
            criterion.evidenceRecordIds,
            recordId,
          )
        }
      })
      return
    }
    if (evidenceTarget.startsWith('requirement:')) {
      const index = Number(evidenceTarget.slice('requirement:'.length))
      mutateDraft((next) => {
        const requirement = next.requirements[index]
        if (requirement !== undefined) {
          requirement.evidenceRecordIds = toggleEvidence(
            requirement.evidenceRecordIds,
            recordId,
          )
        }
      })
      return
    }
    mutateDraft((next) => {
      next.chain.evidenceRecordIds = toggleEvidence(
        next.chain.evidenceRecordIds,
        recordId,
      )
    })
  }, [evidenceTarget, mutateDraft])

  const save = useCallback(async () => {
    if (draft === undefined || workspace === undefined || directoryId === '') return
    setSaving(true)
    setError(undefined)
    try {
      const response = await fetch(
        `/api/annotations/datasets/${encodeURIComponent(directoryId)}/${reviewer}/cases/${
          encodeURIComponent(workspace.candidate.id)
        }`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            datasetHash: workspace.datasetHash,
            revision: workspace.revision,
            annotation: draft,
          }),
        },
      )
      if (!response.ok) throw await responseError(response, '标注保存失败')
      const result = await response.json() as AnnotationSaveResult
      setWorkspace(current => current === undefined
        ? current
        : { ...current, revision: result.revision, annotation: clone(draft) })
      setOverview(current => current === undefined
        ? current
        : {
            ...current,
            revision: result.revision,
            progress: result.progress,
            cases: current.cases.map(item =>
              item.id === result.case.id ? result.case : item),
          })
      dirty.current = false
      setSaved(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }, [directoryId, draft, reviewer, workspace])

  const selectCase = (next: string) => {
    if (dirty.current && !window.confirm('当前案例有未保存修改，确定切换吗？')) return
    setCaseId(next)
    setMobilePane('evidence')
  }

  const confirmDiscard = (message: string): boolean =>
    !dirty.current || window.confirm(message)

  const addRequirement = (suggestion?: AnnotationCaseWorkspace['requirementSuggestions'][number]) => {
    mutateDraft((next) => {
      const index = next.requirements.length
      next.requirements.push({
        id: suggestion?.id ?? `requirement-${String(index + 1).padStart(3, '0')}`,
        text: suggestion?.text ?? '',
        required: true,
        evidenceRecordIds: suggestion === undefined ? [] : [suggestion.recordId],
        notes: '',
      })
      setEvidenceTarget(`requirement:${index}`)
    })
  }

  return (
    <main className="annotation-workspace">
      <header className="annotation-header">
        <div>
          <span className="annotation-breadcrumb">评测中心 / 人工双标 / {reviewerLabel(reviewer)}</span>
          <strong>{dataset.datasetId}@{dataset.datasetVersion}</strong>
          <span>不会展示 Evaluator 预测或另一位 Reviewer 的结果</span>
        </div>
        <div className="annotation-header-controls">
          <div className="annotation-reviewer-lock">
            <span>当前独立身份</span>
            <strong>{reviewerLabel(reviewer)}</strong>
          </div>
          <button
            type="button"
            className="annotation-exit"
            onClick={() => {
              if (confirmDiscard('当前案例有未保存修改，确定返回评测中心吗？')) onExit()
            }}
          >
            返回评测中心
          </button>
        </div>
      </header>

      {error !== undefined && (
        <div className="annotation-error">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button type="button" onClick={() => setError(undefined)}><X size={14} /></button>
        </div>
      )}

      <nav className="annotation-mobile-nav" aria-label="标注步骤" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mobilePane === 'cases'}
          className={mobilePane === 'cases' ? 'active' : ''}
          onClick={() => setMobilePane('cases')}
        >
          1. 案例
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mobilePane === 'evidence'}
          className={mobilePane === 'evidence' ? 'active' : ''}
          onClick={() => setMobilePane('evidence')}
        >
          2. 证据
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mobilePane === 'form'}
          className={mobilePane === 'form' ? 'active' : ''}
          onClick={() => setMobilePane('form')}
        >
          3. 标注
        </button>
      </nav>

      <section className="annotation-layout">
        <aside className={`annotation-case-list${mobilePane === 'cases' ? ' mobile-active' : ''}`}>
          <header>
            <div>
              <strong>{reviewerLabel(reviewer)}</strong>
              <span>
                已完成 {overview?.progress.complete ?? 0} / {overview?.progress.total ?? 0}
              </span>
            </div>
            <progress
              value={overview?.progress.complete ?? 0}
              max={overview?.progress.total ?? 1}
            />
          </header>
          <div className="annotation-case-scroll">
            {overview?.cases.map((item, index) => (
              <button
                type="button"
                className={item.id === caseId ? 'active' : ''}
                onClick={() => selectCase(item.id)}
                key={item.id}
              >
                {item.complete
                  ? <Check className="case-complete" size={15} />
                  : <Circle size={15} />}
                <span>
                  <strong>{index + 1}. {sourceLabel(item.source)}</strong>
                  <small>
                    {splitLabel(item.split)} · {item.criteriaComplete}/{item.criteriaTotal} 项
                  </small>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className={`annotation-evidence-pane${mobilePane === 'evidence' ? ' mobile-active' : ''}`}>
          <header>
            <div>
              <strong>{workspace?.candidate.id ?? '正在加载案例'}</strong>
              {workspace !== undefined && (
                <span>
                  {sourceLabel(workspace.candidate.source)} · {splitLabel(workspace.candidate.split)}
                </span>
              )}
            </div>
            <label className="annotation-search">
              <Search size={15} />
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="搜索记录、错误或工具"
              />
            </label>
            <label className="annotation-record-filter">
              <span>记录范围</span>
              <select
                aria-label="记录筛选"
                value={recordFilter}
                onChange={event => setRecordFilter(event.target.value as RecordFilter)}
              >
                <option value="key">关键记录</option>
                <option value="user">用户要求</option>
                <option value="assistant">助手</option>
                <option value="tool">工具</option>
                <option value="error">异常</option>
                <option value="all">全部记录</option>
              </select>
            </label>
          </header>
          {caseLoading
            ? (
                <div className="annotation-pane-loading">
                  <LoaderCircle className="annotation-spin" size={20} />
                  正在加载冻结轨迹…
                </div>
              )
            : (
                <div className="annotation-records">
                  <div className="annotation-record-count">
                    显示 {filteredRecords.length} / {workspace?.records.length ?? 0} 条
                    {recordFilter === 'key' && <span> · 可切换“全部记录”查看完整轨迹</span>}
                  </div>
                  {filteredRecords.map(record => {
                    const selected = draft === undefined
                      ? false
                      : evidenceTarget.startsWith('criterion:')
                        ? draft.criteria.find(item =>
                            item.criterionId === evidenceTarget.slice('criterion:'.length))
                          ?.evidenceRecordIds.includes(record.id) === true
                        : evidenceTarget.startsWith('requirement:')
                          ? draft.requirements[
                              Number(evidenceTarget.slice('requirement:'.length))
                            ]?.evidenceRecordIds.includes(record.id) === true
                          : draft.chain.evidenceRecordIds.includes(record.id)
                    return (
                      <article className={`annotation-record status-${record.status}`} key={record.id}>
                        <button
                          type="button"
                          className={selected ? 'evidence-selected' : ''}
                          onClick={() => targetEvidence(record.id)}
                          title="加入或移除当前评测项的证据"
                        >
                          {selected ? <Check size={14} /> : <Plus size={14} />}
                        </button>
                        <button type="button" className="annotation-record-main" onClick={() => void openRecord(record)}>
                          <span>
                            <code>{record.id}</code>
                            <small>轮 {record.turn || '—'} / 步 {record.step || '—'}</small>
                          </span>
                          <strong>{KIND_LABELS[record.kind]} · {record.title}</strong>
                          <p>{record.summary}</p>
                        </button>
                      </article>
                    )
                  })}
                </div>
              )}
        </section>

        <section className={`annotation-form-pane${mobilePane === 'form' ? ' mobile-active' : ''}`}>
          <header>
            <div>
              <strong>中文标注表单</strong>
              <span>{draft !== undefined && annotationCaseComplete(draft)
                ? '本案例字段已完整'
                : '请完成所有必填项并引用证据'}</span>
            </div>
            <button
              type="button"
              className="annotation-save"
              disabled={saving || draft === undefined}
              onClick={() => void save()}
            >
              {saving
                ? <LoaderCircle className="annotation-spin" size={15} />
                : <Save size={15} />}
              {saved ? '已保存' : saving ? '保存中' : '保存'}
            </button>
          </header>
          {draft !== undefined && workspace !== undefined && (
            <div className="annotation-form-scroll">
              <section className="annotation-form-section">
                <h2>一、五项评测</h2>
                <p>先选结果和归因，再点击“选择证据”，然后在左侧点击相关记录。</p>
                {ANNOTATION_CRITERIA.map(info => {
                  const criterion = draft.criteria.find(item => item.criterionId === info.id)!
                  return (
                    <article
                      className={evidenceTarget === `criterion:${info.id}`
                        ? 'annotation-form-card evidence-active'
                        : 'annotation-form-card'}
                      key={info.id}
                    >
                      <header>
                        <div>
                          <strong>{info.label}</strong>
                          <span>{info.description}</span>
                        </div>
                      </header>
                      <div className="annotation-inline-fields">
                        <label>
                          <span>判定结果</span>
                          <select
                            value={criterion.verdict ?? ''}
                            onChange={event => mutateDraft((next) => {
                              const item = next.criteria.find(value => value.criterionId === info.id)!
                              item.verdict = (event.target.value || undefined) as EvaluationVerdict | undefined
                            })}
                          >
                            <option value="">请选择</option>
                            {ANNOTATION_VERDICTS.map(option => (
                              <option value={option.value} key={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>问题归因</span>
                          <select
                            value={criterion.attribution ?? ''}
                            onChange={event => mutateDraft((next) => {
                              const item = next.criteria.find(value => value.criterionId === info.id)!
                              item.attribution = (event.target.value || undefined) as EvaluationAttribution | undefined
                            })}
                          >
                            <option value="">请选择</option>
                            {ANNOTATION_ATTRIBUTIONS.map(option => (
                              <option value={option.value} key={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <button
                        type="button"
                        className="annotation-evidence-button"
                        onClick={() => setEvidenceTarget(`criterion:${info.id}`)}
                      >
                        选择证据 · {criterion.evidenceRecordIds.length} 条
                      </button>
                      {criterion.evidenceRecordIds.length > 0 && (
                        <div className="annotation-evidence-chips">
                          {criterion.evidenceRecordIds.map(id => <code key={id}>{id}</code>)}
                        </div>
                      )}
                      <label>
                        <span>中文说明</span>
                        <textarea
                          value={criterion.notes}
                          onChange={event => mutateDraft((next) => {
                            const item = next.criteria.find(value => value.criterionId === info.id)!
                            item.notes = event.target.value
                          })}
                          placeholder="写明你依据什么证据作出判断"
                        />
                      </label>
                    </article>
                  )
                })}
              </section>

              <section className="annotation-form-section">
                <h2>二、逐项用户要求</h2>
                <p>整体成功不能证明每个要求都完成。可从下方候选要求一键加入。</p>
                <div className="annotation-suggestions">
                  {workspace.requirementSuggestions.map(suggestion => (
                    <button
                      type="button"
                      disabled={draft.requirements.some(item => item.id === suggestion.id)}
                      onClick={() => addRequirement(suggestion)}
                      key={suggestion.id}
                    >
                      <Plus size={13} />
                      轮 {suggestion.turn} · {suggestion.text}
                    </button>
                  ))}
                  <button type="button" onClick={() => addRequirement()}>
                    <Plus size={13} /> 添加自定义要求
                  </button>
                </div>
                <RequirementEditor
                  requirements={draft.requirements}
                  evidenceTarget={evidenceTarget}
                  onEvidenceTarget={setEvidenceTarget}
                  onChange={(index, value) => mutateDraft((next) => {
                    next.requirements[index] = value
                  })}
                  onRemove={index => mutateDraft((next) => {
                    next.requirements.splice(index, 1)
                    setEvidenceTarget('criterion:outcome')
                  })}
                />
              </section>

              <section className="annotation-form-section">
                <h2>三、多轮承接</h2>
                <p>
                  用户轮次：{workspace.userTurns.length === 0
                    ? '未记录'
                    : workspace.userTurns.join('、')}
                </p>
                <article
                  className={evidenceTarget === 'chain'
                    ? 'annotation-form-card evidence-active'
                    : 'annotation-form-card'}
                >
                  <label>
                    <span>承接状态</span>
                    <select
                      value={draft.chain.continuity ?? ''}
                      onChange={event => mutateDraft((next) => {
                        next.chain.continuity = (
                          event.target.value || undefined
                        ) as HumanCaseAnnotation['chain']['continuity']
                        if (next.chain.continuity !== 'missing'
                          && next.chain.continuity !== 'incorrect') {
                          delete next.chain.failedTransition
                        }
                      })}
                    >
                      <option value="">请选择</option>
                      {ANNOTATION_CHAIN_STATES.map(option => (
                        <option value={option.value} key={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  {(draft.chain.continuity === 'missing'
                    || draft.chain.continuity === 'incorrect') && (
                    <div className="annotation-inline-fields">
                      <label>
                        <span>从第几轮</span>
                        <input
                          type="number"
                          min="1"
                          value={draft.chain.failedTransition?.fromTurn ?? ''}
                          onChange={event => mutateDraft((next) => {
                            next.chain.failedTransition = {
                              fromTurn: Number(event.target.value),
                              toTurn: next.chain.failedTransition?.toTurn ?? 1,
                            }
                          })}
                        />
                      </label>
                      <label>
                        <span>到第几轮</span>
                        <input
                          type="number"
                          min="1"
                          value={draft.chain.failedTransition?.toTurn ?? ''}
                          onChange={event => mutateDraft((next) => {
                            next.chain.failedTransition = {
                              fromTurn: next.chain.failedTransition?.fromTurn ?? 1,
                              toTurn: Number(event.target.value),
                            }
                          })}
                        />
                      </label>
                    </div>
                  )}
                  <button
                    type="button"
                    className="annotation-evidence-button"
                    onClick={() => setEvidenceTarget('chain')}
                  >
                    选择证据 · {draft.chain.evidenceRecordIds.length} 条
                  </button>
                  {draft.chain.evidenceRecordIds.length > 0 && (
                    <div className="annotation-evidence-chips">
                      {draft.chain.evidenceRecordIds.map(id => <code key={id}>{id}</code>)}
                    </div>
                  )}
                  <label>
                    <span>中文说明</span>
                    <textarea
                      value={draft.chain.notes}
                      onChange={event => mutateDraft((next) => {
                        next.chain.notes = event.target.value
                      })}
                    />
                  </label>
                </article>
              </section>

              <section className="annotation-form-section">
                <h2>四、案例补充说明</h2>
                <textarea
                  value={draft.notes}
                  onChange={event => mutateDraft((next) => {
                    next.notes = event.target.value
                  })}
                  placeholder="可选：记录整体判断边界或仍需复核的问题"
                />
              </section>
            </div>
          )}
        </section>
      </section>

      <footer className="annotation-footer">
        <button
          type="button"
          disabled={selectedCaseIndex <= 0}
          onClick={() => overview !== undefined
            && selectCase(overview.cases[selectedCaseIndex - 1]!.id)}
        >
          <ChevronLeft size={15} /> 上一个
        </button>
        <span>
          {selectedCaseIndex < 0 ? '—' : selectedCaseIndex + 1} / {overview?.cases.length ?? 0}
        </span>
        <button
          type="button"
          disabled={overview === undefined || selectedCaseIndex >= overview.cases.length - 1}
          onClick={() => overview !== undefined
            && selectCase(overview.cases[selectedCaseIndex + 1]!.id)}
        >
          下一个 <ChevronRight size={15} />
        </button>
      </footer>

      {recordDetail !== undefined && (
        <aside className="annotation-record-detail" aria-label="证据记录详情">
          <header>
            <div>
              <code>{recordDetail.id}</code>
              <strong>{KIND_LABELS[recordDetail.kind]} · {recordDetail.title}</strong>
            </div>
            <button type="button" className="icon-button" onClick={() => setRecordDetail(undefined)}>
              <X size={17} />
            </button>
          </header>
          <div>
            <dl>
              <div><dt>轮次 / 步骤</dt><dd>{recordDetail.turn} / {recordDetail.step}</dd></div>
              <div><dt>状态</dt><dd>{recordDetail.status}</dd></div>
            </dl>
            <p>{recordDetail.summary}</p>
            {recordDetail.error !== undefined && (
              <section className="annotation-detail-error">
                <strong>错误</strong>
                <pre>{json(recordDetail.error)}</pre>
              </section>
            )}
            {recordDetail.input !== undefined && (
              <section>
                <strong>输入</strong>
                <pre>{json(recordDetail.input)}</pre>
              </section>
            )}
            {recordDetail.output !== undefined && (
              <section>
                <strong>输出</strong>
                <pre>{json(recordDetail.output)}</pre>
              </section>
            )}
          </div>
        </aside>
      )}
      {recordLoading && (
        <div className="annotation-record-loading">
          <LoaderCircle className="annotation-spin" size={18} /> 正在读取证据详情…
        </div>
      )}
    </main>
  )
}
