import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SourceId, SourceStatus } from '../types'
import { SourceIcon } from './SourceIcon'

type SourceFilter = SourceId | 'all'

export function SourcePicker({
  sources,
  value,
  total,
  onChange,
}: {
  sources: SourceStatus[]
  value: SourceFilter
  total: number
  onChange: (value: SourceFilter) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const available = sources.filter(source => source.availability !== 'blocked')
  const selected = available.find(source => source.source === value)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const choose = (next: SourceFilter) => {
    onChange(next)
    setOpen(false)
  }

  return (
    <div className="source-picker" ref={root}>
      <button
        type="button"
        className="source-picker-trigger"
        aria-label="筛选来源"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <span>{selected?.label ?? '全部来源'}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="source-picker-menu" role="listbox" aria-label="来源列表">
          <button
            type="button"
            role="option"
            aria-selected={value === 'all'}
            onClick={() => choose('all')}
          >
            <SourceIcon size={17} />
            <span><strong>全部来源</strong><small>{total} 个会话</small></span>
            {value === 'all' && <Check size={13} />}
          </button>
          {available.map(source => (
            <button
              type="button"
              role="option"
              aria-selected={value === source.source}
              key={source.source}
              onClick={() => choose(source.source)}
            >
              <SourceIcon
                source={source.source}
                iconToken={source.iconToken}
                size={17}
              />
              <span>
                <strong>{source.label}</strong>
                <small>
                  {source.sessionCountState === 'pending'
                    ? '正在发现会话…'
                    : `${source.sessionCount} 个会话`}
                </small>
              </span>
              {value === source.source && <Check size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
