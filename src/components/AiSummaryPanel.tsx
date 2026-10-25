import {
  Check,
  CircleAlert,
  FileSearch,
  LoaderCircle,
  LockKeyhole,
  Settings2,
  Sparkles,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AI_ENHANCEMENT_MODULE_LABELS,
  AI_ENHANCEMENT_MODULES,
  type AiEnhancementModule,
  type AiSummaryGenerationEvent,
  type AiSummaryGenerationProgress,
  type AiSummaryOptions,
  type OpenAiCompatibleConfig,
  type SummaryModelSelection,
  type SummaryPreview,
  type SummarySettings,
  type ValidatedAiSummary,
} from '../ai-summary-types'
import { useSessionRequestScope } from '../hooks/useSessionRequestScope'
import type { TrajectoryAnalysis } from '../trajectory-analysis'
import type { SourceId } from '../types'
import { formatDuration, formatNumber } from '../trajectory-view-model'

function compatibleCompletionUrl(baseUrl: string): string | undefined {
  try {
    const normalized = new URL(baseUrl).href.replace(/\/+$/, '')
    if (normalized.endsWith('/chat/completions')) return normalized
    return /\/v\d+(?:\.\d+)?$/i.test(normalized)
      ? `${normalized}/chat/completions`
      : `${normalized}/v1/chat/completions`
  } catch {
    return undefined
  }
}

function bigModelModelWarning(
  baseUrl: string,
  model: string,
): string | undefined {
  try {
    if (new URL(baseUrl).hostname !== 'open.bigmodel.cn') return undefined
  } catch {
    return undefined
  }
  if (/^glm-[a-z0-9.-]+$/i.test(model)) return undefined
  return '当前模型 ID 不符合标准 GLM 模型代码格式；请确认它来自当前 Key 对应产品的调用页面。'
}

interface AiSummaryPanelProps {
  analysis: TrajectoryAnalysis
  source: SourceId
  sourceSessionId: string
  onSummaryChange?: (
    summary: ValidatedAiSummary | undefined,
    moduleStatus: AiSummaryOptions['moduleStatus'] | undefined,
  ) => void
}

function summaryUrl(
  source: SourceId,
  sourceSessionId: string,
  suffix = '',
): string {
  return `/api/sessions/${source}/${encodeURIComponent(sourceSessionId)}/ai-summary${suffix}`
}

function selectionKey(selection: SummaryModelSelection): string {
  return `${selection.adapterId}\u0000${selection.model}`
}

function previewUrl(
  source: SourceId,
  sourceSessionId: string,
  modules: readonly AiEnhancementModule[],
): string {
  const query = new URLSearchParams()
  modules.forEach(module => query.append('module', module))
  return `${summaryUrl(source, sourceSessionId, '/preview')}?${query.toString()}`
}

async function readGenerationStream(
  response: Response,
  onEvent: (event: AiSummaryGenerationEvent) => void,
): Promise<void> {
  if (response.body === null) throw new Error('AI 增强没有返回进度流')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  while (true) {
    const { done, value } = await reader.read()
    pending += decoder.decode(value, { stream: !done })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() !== '') {
        onEvent(JSON.parse(line) as AiSummaryGenerationEvent)
      }
    }
    if (done) break
  }
  if (pending.trim() !== '') {
    onEvent(JSON.parse(pending) as AiSummaryGenerationEvent)
  }
}

export function AiSummaryPanel({
  analysis,
  source,
  sourceSessionId,
  onSummaryChange,
}: AiSummaryPanelProps) {
  const [options, setOptions] = useState<AiSummaryOptions>()
  const [selection, setSelection] = useState<SummaryModelSelection>()
  const [modules, setModules] = useState<AiEnhancementModule[]>([])
  const [summary, setSummary] = useState<ValidatedAiSummary>()
  const [preview, setPreview] = useState<SummaryPreview>()
  const [previewOpen, setPreviewOpen] = useState(false)
  const [modulesOpen, setModulesOpen] = useState(false)
  const [moduleDraft, setModuleDraft] = useState<AiEnhancementModule[]>([])
  const [savingModules, setSavingModules] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generationProgress, setGenerationProgress] =
    useState<AiSummaryGenerationProgress>()
  const [generationStartedAt, setGenerationStartedAt] = useState<number>()
  const [generationElapsedMs, setGenerationElapsedMs] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<SummarySettings>()
  const [error, setError] = useState<string>()
  const [loadingOptions, setLoadingOptions] = useState(true)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [compatibleDraft, setCompatibleDraft] = useState<OpenAiCompatibleConfig>({
    id: 'custom-summary',
    type: 'openai-compatible',
    label: '自定义总结模型',
    baseUrl: 'http://127.0.0.1:11434',
    model: '',
  })
  const [apiKey, setApiKey] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<{
    adapterId: string
    adapterType: 'codex-app-server' | 'openai-compatible'
    model: string
    label: string
  }>()
  const optionsRequest = useRef(0)
  const previewRequest = useRef(0)
  const initializedSession = useRef<string>()
  const sessionKey = `${source}\u0000${sourceSessionId}`
  const generationRequests = useSessionRequestScope(sessionKey)
  const analysisRevision = useMemo(
    () => JSON.stringify({
      objective: analysis.objective,
      outcome: analysis.outcome,
      stats: analysis.stats,
      steps: analysis.steps.map(step => [
        step.id, step.status, step.durationMs, step.usage, step.result,
      ]),
      corrections: analysis.corrections.map(correction => [
        correction.id, correction.status, correction.result,
      ]),
      evaluations: analysis.evaluations,
      optimizations: analysis.optimizations,
    }),
    [analysis],
  )

  const loadOptions = useCallback(async () => {
    const request = ++optionsRequest.current
    setLoadingOptions(true)
    try {
      const response = await fetch(summaryUrl(source, sourceSessionId))
      if (!response.ok) throw new Error(`增强选项加载失败 (${response.status})`)
      const result = await response.json() as AiSummaryOptions
      if (request !== optionsRequest.current) return
      setOptions(result)
      setSelection(result.selected)
      setSummary(result.cached)
      const sessionKey = `${source}\u0000${sourceSessionId}`
      if (initializedSession.current !== sessionKey) {
        initializedSession.current = sessionKey
        setModules((result.selectedModules?.length ?? 0) > 0
          ? result.selectedModules
          : [...AI_ENHANCEMENT_MODULES])
      }
      setError(undefined)
    } catch (caught) {
      if (request !== optionsRequest.current) return
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (request === optionsRequest.current) setLoadingOptions(false)
    }
  }, [analysisRevision, source, sourceSessionId])

  useEffect(() => {
    void loadOptions()
  }, [loadOptions])

  useEffect(() => {
    initializedSession.current = undefined
    setModules([])
    setSummary(undefined)
    setPreview(undefined)
    setPreviewOpen(false)
    setModulesOpen(false)
    setModuleDraft([])
    setSettingsOpen(false)
    setGenerating(false)
    setGenerationProgress(undefined)
    setGenerationStartedAt(undefined)
    setGenerationElapsedMs(0)
  }, [source, sourceSessionId])

  useEffect(() => {
    if (!generating || generationStartedAt === undefined) return
    const update = () => setGenerationElapsedMs(Date.now() - generationStartedAt)
    update()
    const timer = window.setInterval(update, 1_000)
    return () => window.clearInterval(timer)
  }, [generating, generationStartedAt])

  useEffect(() => {
    onSummaryChange?.(summary, options?.moduleStatus)
  }, [onSummaryChange, options?.moduleStatus, summary])

  const refreshPreview = useCallback(async (
    selectedModules: AiEnhancementModule[],
  ) => {
    if (selectedModules.length === 0) {
      setPreview(undefined)
      return
    }
    const request = ++previewRequest.current
    setLoadingPreview(true)
    try {
      const response = await fetch(previewUrl(
        source,
        sourceSessionId,
        selectedModules,
      ))
      if (!response.ok) throw new Error(`发送内容计算失败 (${response.status})`)
      const result = await response.json() as SummaryPreview
      if (request !== previewRequest.current) return
      setPreview(result)
      setError(undefined)
    } catch (caught) {
      if (request !== previewRequest.current) return
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (request === previewRequest.current) setLoadingPreview(false)
    }
  }, [source, sourceSessionId])

  useEffect(() => {
    void refreshPreview(modules)
  }, [analysisRevision, modules, refreshPreview])

  const models = useMemo(
    () => options?.adapters.flatMap(adapter =>
      adapter.models.map(model => ({
        ...model,
        adapterLabel: adapter.label,
        adapterAvailable: adapter.available,
        adapterReason: adapter.reason,
        displayLabel: model.adapterType === 'openai-compatible'
          ? settings?.openAiCompatible.find(config =>
              config.id === model.adapterId && config.model === model.id)?.label
            ?? model.provider
            ?? adapter.label
          : model.label,
      }))) ?? [],
    [options, settings],
  )
  const selectValue = selection === undefined ? '' : selectionKey(selection)
  const selectedModel = models.find(model =>
    model.adapterId === selection?.adapterId && model.id === selection?.model)

  const openModuleDialog = () => {
    setModuleDraft(modules)
    setModulesOpen(true)
  }

  const toggleDraftModule = (module: AiEnhancementModule) => {
    if (moduleDraft.length === 1 && moduleDraft.includes(module)) return
    setModuleDraft(current => AI_ENHANCEMENT_MODULES.filter(candidate =>
      candidate === module
        ? !current.includes(candidate)
        : current.includes(candidate)))
  }

  const readSettings = async (): Promise<SummarySettings> => {
    if (settings !== undefined) return settings
    const response = await fetch('/api/summary/settings')
    if (!response.ok) throw new Error(`增强设置加载失败 (${response.status})`)
    const result = await response.json() as SummarySettings
    setSettings(result)
    const currentConfig = result.openAiCompatible.find(config =>
      config.id === selection?.adapterId && config.model === selection.model)
    if (currentConfig !== undefined) setCompatibleDraft(currentConfig)
    return result
  }

  const saveModuleScope = async () => {
    if (moduleDraft.length === 0 || savingModules) return
    setSavingModules(true)
    try {
      const current = settings ?? await readSettings()
      const next: SummarySettings = {
        ...current,
        lastModules: moduleDraft,
      }
      const response = await fetch('/api/summary/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `重算范围保存失败 (${response.status})`)
      }
      setSettings(await response.json() as SummarySettings)
      setModules(moduleDraft)
      setModulesOpen(false)
      setError(undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSavingModules(false)
    }
  }

  const generate = async () => {
    if (modules.length === 0 || generating) return
    if (selection === undefined) {
      setError('请先选择增强模型')
      return
    }
    if (selectedModel?.adapterAvailable === false) {
      try {
        await readSettings()
        setSettingsOpen(true)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
        return
      }
      setError(`${selectedModel.displayLabel} ${
        selectedModel.adapterReason ?? '当前不可用'
      }，请在下方补充配置。`)
      return
    }
    const request = generationRequests.begin()
    setGenerating(true)
    setGenerationProgress({
      stage: 'preparing',
      message: '正在准备脱敏事实包',
    })
    setGenerationStartedAt(Date.now())
    setGenerationElapsedMs(0)
    setError(undefined)
    try {
      const response = await fetch(summaryUrl(
        source,
        sourceSessionId,
        '/generate-stream',
      ), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...selection, modules, remember: true }),
        signal: request.controller.signal,
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `AI 增强生成失败 (${response.status})`)
      }
      let result: ValidatedAiSummary | undefined
      await readGenerationStream(response, (event) => {
        if (!generationRequests.isCurrent(request)) return
        if (event.type === 'progress') {
          setGenerationProgress({
            stage: event.stage,
            message: event.message,
          })
        } else if (event.type === 'result') {
          result = event.summary
        } else {
          throw new Error(event.error)
        }
      })
      if (!generationRequests.isCurrent(request) || result === undefined) return
      setSummary(result)
      await loadOptions()
    } catch (caught) {
      if (!generationRequests.isCurrent(request)
        || request.controller.signal.aborted) return
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (generationRequests.finish(request)) {
        setGenerating(false)
        setGenerationProgress(undefined)
        setGenerationStartedAt(undefined)
      }
    }
  }

  const cancelGeneration = () => {
    generationRequests.cancel()
    setGenerating(false)
    setGenerationProgress(undefined)
    setGenerationStartedAt(undefined)
  }

  const openSettings = async () => {
    await readSettings()
    setSettingsOpen(current => !current)
  }

  const rememberSelection = async (nextSelection: SummaryModelSelection) => {
    setSelection(nextSelection)
    try {
      const current = settings ?? await (async () => {
        const response = await fetch('/api/summary/settings')
        if (!response.ok) throw new Error(`增强设置加载失败 (${response.status})`)
        return response.json() as Promise<SummarySettings>
      })()
      const next: SummarySettings = {
        ...current,
        defaultSelection: nextSelection,
        mappings: [
          ...current.mappings.filter(mapping => mapping.source !== source),
          { source, selection: nextSelection },
        ],
      }
      const response = await fetch('/api/summary/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (!response.ok) throw new Error(`增强模型选择保存失败 (${response.status})`)
      setSettings(await response.json() as SummarySettings)
      setError(undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const saveCompatible = async () => {
    if (compatibleDraft.model.trim() === '') {
      setError('请输入模型 ID')
      return
    }
    const current: SummarySettings = settings ?? {
      mappings: [],
      openAiCompatible: [],
      lastModules: [...AI_ENHANCEMENT_MODULES],
    }
    const next: SummarySettings = {
      ...current,
      defaultSelection: {
        adapterId: compatibleDraft.id,
        model: compatibleDraft.model.trim(),
      },
      openAiCompatible: [
        ...current.openAiCompatible.filter(item => item.id !== compatibleDraft.id),
        compatibleDraft,
      ],
    }
    const response = await fetch('/api/summary/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    })
    if (!response.ok) throw new Error(`模型设置保存失败 (${response.status})`)
    if (apiKey.trim() !== '') {
      const credential = await fetch(
        `/api/summary/adapters/${encodeURIComponent(compatibleDraft.id)}/credential`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey }),
        },
      )
      if (!credential.ok) throw new Error(`模型凭证保存失败 (${credential.status})`)
    }
    setApiKey('')
    setSettings(await response.json() as SummarySettings)
    setSettingsOpen(false)
    await loadOptions()
  }

  const removeModel = async () => {
    if (pendingDelete === undefined || deleting) return
    setDeleting(true)
    setError(undefined)
    try {
      const response = await fetch('/api/summary/models', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pendingDelete),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `模型删除失败 (${response.status})`)
      }
      const nextSettings = await response.json() as SummarySettings
      if (selection?.adapterId === pendingDelete.adapterId
        && selection.model === pendingDelete.model) setSelection(undefined)
      setSettings(nextSettings)
      setPendingDelete(undefined)
      await loadOptions()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setDeleting(false)
    }
  }

  const restoreModel = async (
    model: NonNullable<SummarySettings['hiddenModels']>[number],
  ) => {
    const response = await fetch('/api/summary/models/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapterId: model.adapterId, model: model.model }),
    })
    if (!response.ok) throw new Error(`模型恢复失败 (${response.status})`)
    setSettings(await response.json() as SummarySettings)
    setError(undefined)
    await loadOptions()
  }

  if (loadingOptions && options === undefined) {
    return (
      <section className="ai-summary-prototype ai-summary-idle" aria-label="AI 增强">
        <LoaderCircle className="ai-loading" size={18} />
        <span><strong>正在检查可用增强模型…</strong><small>本地事实分析不受影响。</small></span>
      </section>
    )
  }

  const selectedLabels = modules.map(module =>
    AI_ENHANCEMENT_MODULE_LABELS[module]).join('、')
  const staleCount = modules.filter(module =>
    options?.moduleStatus?.[module] === 'stale').length
  const currentCount = modules.filter(module =>
    options?.moduleStatus?.[module] === 'current').length

  return (
    <section className="ai-summary-prototype ai-enhancement-panel" aria-label="AI 增强">
      <div className="ai-enhancement-toolbar">
        <button
          type="button"
          className="ai-summary-mark ai-run-trigger"
          aria-label={`重算 ${modules.length} 个模块`}
          title={`重算 ${modules.length} 个模块`}
          disabled={modules.length === 0 || generating}
          onClick={() => void generate()}
        >
          {generating
            ? <LoaderCircle className="ai-loading" size={17} />
            : <Sparkles size={17} />}
        </button>
        <span className="ai-enhancement-copy">
          <span className="summary-eyebrow">可选 AI 增强</span>
          <strong>生成自然中文增强</strong>
          <small>
            {summary === undefined
              ? '按所选范围重算'
              : `${currentCount} 项最新${
                  staleCount > 0 ? ` · ${staleCount} 项待更新` : ''
                }`}
          </small>
        </span>
        <button
          className="ai-scope-toggle"
          type="button"
          aria-expanded={modulesOpen}
          aria-label={`重算范围 · ${modules.length} 项 · ${selectedLabels}`}
          onClick={openModuleDialog}
        >
          <Check size={16} />
          <span>
            <strong>重算范围 · {modules.length} 项</strong>
            <small>{selectedLabels}</small>
          </span>
          <span>配置</span>
        </button>
        <button
          className="ai-data-toggle"
          type="button"
          aria-expanded={previewOpen}
          disabled={modules.length === 0}
          onClick={() => setPreviewOpen(current => !current)}
        >
          <FileSearch size={16} />
          <span>
            <strong>将发送的信息</strong>
            <small>
              {loadingPreview ? '正在按所选范围重算…' : `${
                preview?.factStepCount ?? 0
              } 个相关步骤 · 约 ${
                formatNumber(preview?.estimatedInputTokens)
              } 输入 Token`}
            </small>
            <small>{selectedLabels || '请选择至少一个模块'}</small>
          </span>
          <span className="ai-data-toggle-action">{previewOpen ? '收起' : '展开'}</span>
        </button>
        <div className="ai-model-compact">
          <select
            aria-label="选择增强模型"
            value={selectValue}
            onChange={(event) => {
              const [adapterId, model] = event.target.value.split('\u0000')
              if (adapterId !== undefined && model !== undefined) {
                void rememberSelection({ adapterId, model })
              }
            }}
          >
            <option value="">选择模型</option>
            {models.map(model => (
              <option
                value={selectionKey({ adapterId: model.adapterId, model: model.id })}
                key={`${model.adapterId}:${model.id}`}
              >
                {model.displayLabel}
              </option>
            ))}
          </select>
          <button
            className={`icon-button${settingsOpen ? ' active' : ''}`}
            type="button"
            onClick={() => void openSettings()}
            aria-label="配置增强模型"
          >
            <Settings2 size={15} />
          </button>
        </div>
      </div>

      {generating && generationProgress !== undefined && (
        <div className="ai-generation-progress" role="status" aria-live="polite">
          <span className="ai-generating-icon">
            <LoaderCircle size={17} />
          </span>
          <span>
            <strong>{generationProgress.message}</strong>
            <small>
              正在生成「{selectedLabels}」 · {
                formatDuration(generationElapsedMs)
              }
            </small>
          </span>
          <div className="ai-progress" aria-hidden="true"><i /></div>
          <button
            type="button"
            className="text-button"
            onClick={cancelGeneration}
            aria-label="取消 AI 增强"
          >
            取消
          </button>
        </div>
      )}

      {modulesOpen && createPortal(
        <div
          className="ai-scope-dialog-backdrop"
          role="presentation"
          onMouseDown={event => {
            if (event.currentTarget === event.target) setModulesOpen(false)
          }}
        >
          <div
            className="ai-scope-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="选择重算范围"
          >
            <header>
              <span>
                <strong>选择重算范围</strong>
                <small>本次选择将自动用于所有会话和后续页面</small>
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭重算范围"
                onClick={() => setModulesOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="ai-scope-shortcuts">
              <button
                type="button"
                onClick={() => setModuleDraft([...AI_ENHANCEMENT_MODULES])}
              >
                全选
              </button>
              <button
                type="button"
                onClick={() => {
                  const pending = AI_ENHANCEMENT_MODULES.filter(module =>
                    options?.moduleStatus?.[module] !== 'current')
                  setModuleDraft(pending.length > 0
                    ? pending
                    : [...AI_ENHANCEMENT_MODULES])
                }}
              >
                仅选择待更新项
              </button>
            </div>
            <div className="ai-enhancement-modules" role="group" aria-label="选择重算模块">
              {AI_ENHANCEMENT_MODULES.map(module => {
                const checked = moduleDraft.includes(module)
                const status = options?.moduleStatus?.[module] ?? 'missing'
                return (
                  <button
                    type="button"
                    className={`${checked ? 'selected' : ''} status-${status}`}
                    aria-pressed={checked}
                    aria-disabled={checked && moduleDraft.length === 1}
                    aria-label={AI_ENHANCEMENT_MODULE_LABELS[module]}
                    key={module}
                    onClick={() => toggleDraftModule(module)}
                  >
                    <span>{checked && <Check size={12} />}</span>
                    <strong>{AI_ENHANCEMENT_MODULE_LABELS[module]}</strong>
                    <small>
                      {status === 'current' ? '已增强'
                        : status === 'stale' ? '内容已过期' : '使用本地分析'}
                    </small>
                  </button>
                )
              })}
            </div>
            <footer>
              <small>至少选择一项</small>
              <span>
                <button
                  type="button"
                  disabled={savingModules}
                  onClick={() => setModulesOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={savingModules || moduleDraft.length === 0}
                  aria-label="确认重算范围"
                  onClick={() => void saveModuleScope()}
                >
                  {savingModules ? '正在保存…' : '确认'}
                </button>
              </span>
            </footer>
          </div>
        </div>,
        document.body,
      )}

      {previewOpen && preview !== undefined && (
        <pre className="ai-summary-preview">{JSON.stringify(preview.facts, null, 2)}</pre>
      )}

      {settingsOpen && (
        <div className="ai-model-settings-shell">
          <div className="ai-model-settings">
            <label>名称<input aria-label="模型名称" value={compatibleDraft.label} onChange={event => setCompatibleDraft(current => ({ ...current, label: event.target.value }))} /></label>
            <label>Base URL<input aria-label="模型 Base URL" value={compatibleDraft.baseUrl} onChange={event => setCompatibleDraft(current => ({ ...current, baseUrl: event.target.value }))} /></label>
            <label>模型 ID<input aria-label="模型 ID" value={compatibleDraft.model} onChange={event => setCompatibleDraft(current => ({ ...current, model: event.target.value }))} /></label>
            <label>
              结构化输出
              <select
                aria-label="结构化输出模式"
                value={compatibleDraft.structuredOutputMode ?? 'auto'}
                onChange={event => setCompatibleDraft(current => ({
                  ...current,
                  structuredOutputMode: event.target.value as
                    OpenAiCompatibleConfig['structuredOutputMode'],
                }))}
              >
                <option value="auto">自动</option>
                <option value="json-schema">JSON Schema</option>
                <option value="json-object">JSON Object</option>
              </select>
            </label>
            <label>API Key（可选）<input aria-label="API Key（可选）" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="off" /></label>
            <button className="text-button" type="button" onClick={() => void saveCompatible()}>保存模型</button>
          </div>
          <div className="ai-model-endpoint-preview">
            <span>最终请求地址</span>
            <code>{compatibleCompletionUrl(compatibleDraft.baseUrl) ?? 'Base URL 无效'}</code>
            <small>
              {compatibleDraft.structuredOutputMode === 'json-object'
                || (compatibleDraft.structuredOutputMode !== 'json-schema'
                  && compatibleDraft.baseUrl.includes('open.bigmodel.cn'))
                ? '将使用 JSON Object，并在本地执行严格结果校验。'
                : '将使用服务端 JSON Schema 约束。'}
            </small>
            {bigModelModelWarning(
              compatibleDraft.baseUrl,
              compatibleDraft.model,
            ) !== undefined && (
              <small className="warning">
                {bigModelModelWarning(
                  compatibleDraft.baseUrl,
                  compatibleDraft.model,
                )}
              </small>
            )}
          </div>
          <div className="ai-model-management">
            <div>
              <strong>已配置模型</strong>
              <small>隐藏 Codex 模型不会修改 Codex 自身配置。</small>
            </div>
            <div className="ai-model-management-list">
              {models.length === 0 && <span>暂无可用模型</span>}
              {models.map(model => (
                <article key={`${model.adapterId}:${model.id}`}>
                  <span><strong>{model.displayLabel}</strong><small>{model.adapterType === 'codex-app-server' ? 'Codex 内置' : '独立配置'}</small></span>
                  <button
                    type="button"
                    aria-label={`删除模型 ${model.displayLabel}`}
                    onClick={() => setPendingDelete({
                      adapterId: model.adapterId,
                      adapterType: model.adapterType,
                      model: model.id,
                      label: model.displayLabel,
                    })}
                  >
                    <Trash2 size={13} />删除
                  </button>
                </article>
              ))}
            </div>
            {(settings?.hiddenModels?.length ?? 0) > 0 && (
              <div className="ai-hidden-models">
                <strong>已隐藏模型</strong>
                {settings!.hiddenModels!.map(model => (
                  <button
                    type="button"
                    key={`${model.adapterId}:${model.model}`}
                    onClick={() => void restoreModel(model)}
                  >
                    <Undo2 size={12} />恢复 {model.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {pendingDelete !== undefined && (
            <div className="ai-model-delete-confirm" role="alertdialog" aria-label="确认删除增强模型">
              <span>
                <strong>删除“{pendingDelete.label}”？</strong>
                <small>{pendingDelete.adapterType === 'codex-app-server'
                  ? '该模型只会从本应用隐藏，可随时恢复。'
                  : '独立模型配置、凭证和选择记忆将被移除。'}</small>
              </span>
              <button type="button" disabled={deleting} onClick={() => setPendingDelete(undefined)}>取消</button>
              <button
                type="button"
                className="danger"
                disabled={deleting}
                onClick={() => void removeModel()}
              >
                {deleting ? '正在删除…' : '确认删除'}
              </button>
            </div>
          )}
        </div>
      )}

      {summary !== undefined && (
        <footer className="ai-summary-result-footer">
          <span><LockKeyhole size={12} />AI 只增强语义，本地事实与证据关系不变</span>
          <span>
            最近执行：{summary.lastRun.modules.map(module =>
              AI_ENHANCEMENT_MODULE_LABELS[module]).join('、')} · {summary.lastRun.model}
            {' · '}
            {formatNumber(summary.usage?.inputTokens)} 输入 / {
              formatNumber(summary.usage?.outputTokens)
            } 输出 Token · {formatDuration(summary.durationMs)}
          </span>
        </footer>
      )}
      {staleCount > 0 && (
        <div className="ai-stale-notice">
          <CircleAlert size={13} />
          会话已更新，过期模块会继续显示本地分析，直到重新执行对应范围。
        </div>
      )}
      {error !== undefined && <div className="ai-summary-error">{error}</div>}
    </section>
  )
}
