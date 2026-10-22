import { Copy, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { SourceCapabilities, TrajectoryRecord } from '../types'
import {
  formatDuration,
  formatNumber,
  formatTime,
  json,
  KIND_LABELS,
} from '../trajectory-view-model'

export type InspectorTab = 'details' | 'raw'

function ContentBlocks({ value }: { value: unknown }) {
  if (!Array.isArray(value)) return <pre className="json-block">{json(value)}</pre>
  return (
    <div className="content-blocks">
      {value.map((entry, index) => {
        const block = entry !== null && typeof entry === 'object'
          ? entry as Record<string, unknown>
          : {}
        const type = typeof block.type === 'string' ? block.type : 'unknown'
        if ((type === 'text' || type === 'reasoning') && typeof block.text === 'string') {
          return (
            <section className={`content-block block-${type}`} key={index}>
              <div className="block-label">{type === 'reasoning' ? '思考' : '文本'}</div>
              <ReactMarkdown>{block.text}</ReactMarkdown>
            </section>
          )
        }
        return (
          <section className="content-block" key={index}>
            <div className="block-label">{type}</div>
            <pre className="json-block">{json(entry)}</pre>
          </section>
        )
      })}
    </div>
  )
}

interface InspectorProps {
  record: TrajectoryRecord
  capabilities: SourceCapabilities
  sourceLabel: string
  tab: InspectorTab
  raw: unknown[] | undefined
  rawLoading: boolean
  rawError: string | undefined
  onTabChange: (tab: InspectorTab) => void
  onClose: () => void
}

export function Inspector({
  record,
  capabilities,
  sourceLabel,
  tab,
  raw,
  rawLoading,
  rawError,
  onTabChange,
  onClose,
}: InspectorProps) {
  const duration = record.endTime === null ? null : record.endTime - record.startTime
  const copyRaw = () => {
    if (raw !== undefined) void navigator.clipboard.writeText(json(raw))
  }
  return (
    <aside className="inspector" aria-label="记录检查器">
      <header className="inspector-header">
        <div>
          <span className={`kind-badge kind-${record.kind}`}>{KIND_LABELS[record.kind]}</span>
          <h2>{record.title}</h2>
        </div>
        <button className="icon-button" type="button" onClick={onClose} title="关闭检查器">
          <X size={18} />
        </button>
      </header>
      <div className="inspector-tabs" role="tablist">
        <button
          type="button"
          className={tab === 'details' ? 'active' : ''}
          onClick={() => onTabChange('details')}
        >
          详情
        </button>
        <button
          type="button"
          className={tab === 'raw' ? 'active' : ''}
          onClick={() => onTabChange('raw')}
        >
          原始事件
        </button>
        <button
          className="copy-button"
          type="button"
          disabled={raw === undefined}
          onClick={copyRaw}
          title="复制原始事件"
        >
          <Copy size={15} />
        </button>
      </div>
      {tab === 'raw'
        ? rawLoading
          ? <div className="raw-inspector">正在读取原始事件…</div>
          : rawError !== undefined
            ? <div className="raw-inspector">{rawError}</div>
            : <pre className="raw-inspector">{json(raw)}</pre>
        : (
            <div className="inspector-body">
              <section className="facts-grid">
                <div><span>状态</span><strong>{record.status}</strong></div>
                <div><span>耗时</span><strong>{capabilities.timing ? formatDuration(duration) : '—'}</strong></div>
                <div><span>轮次 / 步骤</span><strong>{record.turn || '—'} / {record.step || '—'}</strong></div>
                <div><span>序号</span><strong>#{record.seq}{record.endSeq === undefined ? '' : `–${record.endSeq}`}</strong></div>
                <div><span>开始</span><strong>{capabilities.timing ? formatTime(record.startTime) : '—'}</strong></div>
                <div><span>调用 ID</span><strong title={record.callId}>{record.callId ?? '—'}</strong></div>
                <div><span>来源</span><strong>{sourceLabel}</strong></div>
                <div><span>保真度</span><strong>{record.fidelity}</strong></div>
                {record.surface !== undefined && (
                  <div><span>Surface</span><strong>{record.surface}</strong></div>
                )}
                {capabilities.trace && record.traceId !== undefined && (
                  <div><span>Trace ID</span><strong title={record.traceId}>{record.traceId}</strong></div>
                )}
                {capabilities.trace && record.spanId !== undefined && (
                  <div><span>Span ID</span><strong title={record.spanId}>{record.spanId}</strong></div>
                )}
                {capabilities.trace && record.parentSpanId !== undefined && (
                  <div>
                    <span>父 Span</span>
                    <strong title={record.parentSpanId}>{record.parentSpanId}</strong>
                  </div>
                )}
              </section>
              {capabilities.policy && record.policy !== undefined && (
                <section>
                  <h3>工具策略</h3>
                  <div className="policy-grid">
                    <div>
                      <span>影响范围</span>
                      <strong>{record.policy.sideEffectScope ?? '未记录'}</strong>
                    </div>
                    <div>
                      <span>只读</span>
                      <strong>{record.policy.readOnly === undefined
                        ? '未记录'
                        : record.policy.readOnly ? '是' : '否'}</strong>
                    </div>
                    <div>
                      <span>破坏性</span>
                      <strong>{record.policy.destructive === undefined
                        ? '未记录'
                        : record.policy.destructive ? '是' : '否'}</strong>
                    </div>
                    <div>
                      <span>审批状态</span>
                      <strong>{record.policy.approvalStatus ?? '未记录'}</strong>
                    </div>
                  </div>
                </section>
              )}
              {capabilities.timing && record.metrics !== undefined && (
                <section>
                  <h3>模型计时</h3>
                  <div className="metric-strip">
                    <div><span>TTFT</span><strong>{formatDuration(record.metrics.ttftMs ?? null)}</strong></div>
                    <div><span>解码</span><strong>{formatDuration(record.metrics.decodeMs ?? null)}</strong></div>
                    <div><span>吞吐</span><strong>{record.metrics.throughput === undefined ? '—' : `${record.metrics.throughput.toFixed(1)} tok/s`}</strong></div>
                  </div>
                </section>
              )}
              {capabilities.usage && record.usage !== undefined && (
                <section>
                  <h3>Token 用量</h3>
                  <div className="metric-strip">
                    <div><span>输入</span><strong>{formatNumber(record.usage.inputTokens)}</strong></div>
                    <div><span>输出</span><strong>{formatNumber(record.usage.outputTokens)}</strong></div>
                    <div><span>缓存读取</span><strong>{formatNumber(record.usage.cacheReadTokens)}</strong></div>
                  </div>
                </section>
              )}
              {record.retry !== undefined && (
                <section className="error-panel">
                  <h3>重试 {record.retry.count} 次</h3>
                  <p>{record.retry.message ?? '请求已恢复'}</p>
                  <code>{record.retry.code ?? ''}</code>
                </section>
              )}
              {record.error !== undefined && (
                <section className="error-panel">
                  <h3>{record.error.name ?? '错误'}</h3>
                  <p>{record.error.reason}</p>
                  <code>{record.error.code}</code>
                </section>
              )}
              {record.input !== undefined && (
                <section>
                  <h3>输入</h3>
                  {record.kind === 'user' || record.kind === 'context' || record.kind === 'system'
                    ? <ContentBlocks value={record.input} />
                    : <pre className="json-block">{json(record.input)}</pre>}
                </section>
              )}
              {record.output !== undefined && (
                <section>
                  <h3>输出</h3>
                  <ContentBlocks value={record.output} />
                </section>
              )}
              <section>
                <h3>来源事件</h3>
                <pre className="json-block">{json(record.sourceEventIds)}</pre>
              </section>
            </div>
          )}
    </aside>
  )
}
