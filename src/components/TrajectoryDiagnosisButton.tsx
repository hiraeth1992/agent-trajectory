import {
  CheckCircle2,
  LoaderCircle,
  ScanSearch,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TrajectoryDiagnosisPromptResult } from '../diagnosis-types'
import type { SourceId } from '../types'

interface TrajectoryDiagnosisButtonProps {
  source: SourceId
  sourceSessionId: string
}

export function TrajectoryDiagnosisButton({
  source,
  sourceSessionId,
}: TrajectoryDiagnosisButtonProps) {
  const [preparing, setPreparing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    setPreparing(false)
    setCopied(false)
    setError(undefined)
  }, [source, sourceSessionId])

  const copyPrompt = async () => {
    if (preparing) return
    setPreparing(true)
    setError(undefined)
    try {
      const response = await fetch('/api/diagnosis/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: { source, sessionId: sourceSessionId },
        }),
      })
      const body = await response.json().catch(() => ({})) as
        Partial<TrajectoryDiagnosisPromptResult> & { error?: string }
      if (!response.ok) {
        throw new Error(body.error ?? `诊断 Prompt 生成失败 (${response.status})`)
      }
      if (body.status !== 'prepared' || typeof body.prompt !== 'string') {
        throw new Error('诊断 Prompt 响应无效')
      }
      await navigator.clipboard.writeText(body.prompt)
      setCopied(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setPreparing(false)
    }
  }

  return (
    <div className="outcome-diagnosis-control">
      <button
        type="button"
        className="outcome-diagnosis"
        disabled={preparing}
        onClick={() => void copyPrompt()}
        aria-label="本地 Agent 诊断"
        title={error}
      >
        {preparing
          ? <LoaderCircle className="ai-loading" size={14} />
          : <ScanSearch size={14} />}
        <span>本地 Agent 诊断</span>
      </button>
      {error !== undefined && (
        <small className="outcome-diagnosis-error" role="alert">
          {error}
        </small>
      )}
      {copied && (
        <div className="diagnosis-copy-dialog-backdrop">
          <section
            className="diagnosis-copy-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="diagnosis-copy-dialog-title"
          >
            <button
              type="button"
              className="diagnosis-copy-dialog-close"
              aria-label="关闭提示"
              onClick={() => setCopied(false)}
            >
              <X size={16} />
            </button>
            <CheckCircle2 size={30} />
            <strong id="diagnosis-copy-dialog-title">已复制 Prompt</strong>
            <p>打开新会话开启诊断</p>
            <button
              type="button"
              className="diagnosis-copy-dialog-confirm"
              onClick={() => setCopied(false)}
            >
              知道了
            </button>
          </section>
        </div>
      )}
    </div>
  )
}
