import {
  Check,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Lightbulb,
  LocateFixed,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  OptimizationExecutionAction,
  OptimizationMeasure,
  OptimizationSuggestion,
} from '../trajectory-optimization'
import type { TrajectoryAnalysis } from '../trajectory-analysis'

const MEASURE_LABELS: Record<OptimizationMeasure, string> = {
  code: '代码',
  rule: '规则 / Skill',
  hook: 'Hook',
  plugin: '插件 / MCP',
  environment: '环境配置',
  workflow: '执行流程',
  verification: '观测与验证',
}

function priorityLabel(value: OptimizationSuggestion['priority']): string {
  if (value === 'high') return '优先处理'
  if (value === 'medium') return '建议改进'
  return '可选增强'
}

function confidenceLabel(value: OptimizationSuggestion['confidence']): string {
  if (value === 'high') return '高置信'
  if (value === 'medium') return '中置信'
  return '低置信'
}

function executionActionText(action: OptimizationExecutionAction): string {
  return [
    action.title,
    `目标：${action.target}`,
    `操作：${action.instruction}`,
    ...(action.content === undefined ? [] : ['', action.content]),
    '',
    `验证：${action.verification}`,
  ].join('\n')
}

export function OptimizationPanel({
  analysis,
  onOpenRecord,
}: {
  analysis: TrajectoryAnalysis
  onOpenRecord: (recordId: string) => void
}) {
  const suggestions = analysis.optimizations ?? []
  const [showAll, setShowAll] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [copiedAction, setCopiedAction] = useState<string>()
  useEffect(() => {
    setShowAll(false)
    setExpanded(new Set())
    setCopiedAction(undefined)
  }, [analysis])
  const visible = showAll ? suggestions : suggestions.slice(0, 3)

  const copyAction = async (
    itemId: string,
    index: number,
    action: OptimizationExecutionAction,
  ) => {
    const key = `${itemId}:${index}`
    try {
      await navigator.clipboard.writeText(executionActionText(action))
      setCopiedAction(key)
      window.setTimeout(() => setCopiedAction(current =>
        current === key ? undefined : current), 1_500)
    } catch {
      setCopiedAction(undefined)
    }
  }

  return (
    <section className="summary-panel optimization-panel">
      <header className="summary-panel-heading">
        <div>
          <Lightbulb size={17} />
          <span>
            <strong>优化建议</strong>
            <small>基于当前轨迹，只展示有证据的可执行改进</small>
          </span>
        </div>
      </header>
      {suggestions.length === 0
        ? (
            <div className="optimization-empty">
              <Check size={16} />
              <span>
                <strong>暂未发现证据充分的优化项</strong>
                <small>缺少记录不会被当作问题，也不会为了填充面板生成建议。</small>
              </span>
            </div>
          )
        : (
            <div className="optimization-list">
              {visible.map(item => {
                const open = expanded.has(item.id)
                return (
                  <article className={`optimization-item priority-${item.priority}`} key={item.id}>
                    <button
                      type="button"
                      className="optimization-summary"
                      aria-expanded={open}
                      onClick={() => setExpanded(current => {
                        const next = new Set(current)
                        if (next.has(item.id)) next.delete(item.id)
                        else next.add(item.id)
                        return next
                      })}
                    >
                      <span className="optimization-rank">{priorityLabel(item.priority)}</span>
                      <span className="optimization-copy">
                        <strong>{item.title}</strong>
                        <small>{item.observation}</small>
                        <span className="optimization-tags">
                          {item.measures.map(measure => (
                            <i key={measure}>{MEASURE_LABELS[measure]}</i>
                          ))}
                          <i>{confidenceLabel(item.confidence)}</i>
                        </span>
                      </span>
                      {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                    </button>
                    {open && (
                      <div className="optimization-detail">
                        <dl>
                          <div><dt>可能原因</dt><dd>{item.cause}</dd></div>
                          <div><dt>推荐措施</dt><dd>{item.action}</dd></div>
                          <div><dt>实施位置</dt><dd>{item.target}</dd></div>
                          <div><dt>预期改善</dt><dd>{item.expectedBenefit}</dd></div>
                          <div><dt>验证方式</dt><dd>{item.verification}</dd></div>
                          <div><dt>判断限制</dt><dd>{item.limitation}</dd></div>
                        </dl>
                        <section className="optimization-execution">
                          <header>
                            <strong>可执行动作</strong>
                            <small>复制后按项目实际情况审阅并采用，不会自动执行</small>
                          </header>
                          {item.executionActions.map((action, index) => {
                            const actionKey = `${item.id}:${index}`
                            return (
                              <article key={actionKey}>
                                <div>
                                  <span>动作 {index + 1} · {action.kind}</span>
                                  <strong>{action.title}</strong>
                                  <small>目标：{action.target}</small>
                                </div>
                                <p>{action.instruction}</p>
                                {action.content !== undefined && (
                                  <pre>{action.content}</pre>
                                )}
                                <footer>
                                  <small>验证：{action.verification}</small>
                                  <button
                                    type="button"
                                    onClick={() => void copyAction(
                                      item.id,
                                      index,
                                      action,
                                    )}
                                  >
                                    {copiedAction === actionKey
                                      ? <Check size={12} />
                                      : <Clipboard size={12} />}
                                    {copiedAction === actionKey ? '已复制' : '复制动作'}
                                  </button>
                                </footer>
                              </article>
                            )
                          })}
                        </section>
                        <div className="optimization-actions">
                          {item.evidence.slice(0, 3).map((evidence, index) => (
                            <button
                              type="button"
                              key={evidence.recordId}
                              onClick={() => onOpenRecord(evidence.recordId)}
                            >
                              <LocateFixed size={12} />
                              {item.evidence.length === 1
                                ? '查看证据'
                                : `证据 ${index + 1} · ${evidence.turn}-${evidence.step}`}
                            </button>
                          ))}
                          {item.evidence.length > 3 && (
                            <small>另有 {item.evidence.length - 3} 条关联证据</small>
                          )}
                        </div>
                      </div>
                    )}
                  </article>
                )
              })}
              {suggestions.length > 3 && (
                <button
                  type="button"
                  className="optimization-show-all"
                  onClick={() => setShowAll(current => !current)}
                >
                  {showAll ? '收起建议' : `查看全部 ${suggestions.length} 条建议`}
                </button>
              )}
            </div>
          )}
    </section>
  )
}
