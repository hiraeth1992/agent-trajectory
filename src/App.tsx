import {
  Activity,
  BarChart3,
  Clock3,
  Download,
  FileJson,
  Hash,
  Layers3,
  MessageSquare,
  PanelTop,
  RefreshCw,
  Search,
  SquareTerminal,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Conversation } from './components/Conversation'
import { Inspector, type InspectorTab } from './components/Inspector'
import { SourcePicker } from './components/SourcePicker'
import { Timeline } from './components/Timeline'
import { TrajectorySummary } from './components/TrajectorySummary'
import { VirtualLedger } from './components/VirtualLedger'
import type {
  SessionDetail,
  SessionDetailDelta,
  SessionDetailResponse,
  SessionSummary,
  SourceId,
  SourceStatus,
  TransportSessionDetail,
  TransportTrajectoryRecord,
} from './types'
import { recordSearchText } from './projector-utils'
import { analyzeTrajectory } from './trajectory-analysis'
import {
  buildTimelineGeometry,
  formatTime,
  json,
  type TimelineRange,
} from './trajectory-view-model'

type SourceFilter = SourceId | 'all'
type SessionView = 'conversation' | 'model-context' | 'trajectory' | 'summary'

interface SessionTarget {
  source: SourceId
  sessionId: string
}

function sourceId(value: string | null): SourceId | undefined {
  return value === 'codex' || value === 'dsh' || value === 'zcode'
    ? value
    : undefined
}

export function sessionTargetFromLocation(location: Pick<Location, 'search'>): SessionTarget | undefined {
  const search = new URLSearchParams(location.search)
  const source = sourceId(search.get('source'))
  const sessionId = search.get('session')?.trim()
  return source === undefined || sessionId === undefined || sessionId === ''
    ? undefined
    : { source, sessionId }
}

function hydrateRecord(record: TransportTrajectoryRecord): SessionDetail['projection']['records'][number] {
  return {
    ...record,
    searchText: recordSearchText(record),
  }
}

function hydrateDetail(detail: TransportSessionDetail): SessionDetail {
  return {
    ...detail,
    projection: {
      ...detail.projection,
      records: detail.projection.records.map(hydrateRecord),
    },
  }
}

function applyDetailDelta(current: SessionDetail, delta: SessionDetailDelta): SessionDetail | undefined {
  if (current.summary.id !== delta.summary.id) return undefined
  const removed = new Set(delta.removedIds)
  const byId = new Map(current.projection.records
    .filter(record => !removed.has(record.id))
    .map(record => [record.id, record]))
  for (const record of delta.upserts) byId.set(record.id, hydrateRecord(record))
  const records = delta.recordOrder.flatMap(id => {
    const record = byId.get(id)
    return record === undefined ? [] : [record]
  })
  if (records.length !== delta.recordOrder.length) return undefined
  return {
    summary: delta.summary,
    projection: {
      ...delta.projection,
      records,
    },
  }
}

export function App() {
  const initialTarget = useRef(sessionTargetFromLocation(window.location))
  const [sources, setSources] = useState<SourceStatus[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(
    initialTarget.current?.source ?? 'all',
  )
  const [sessionTarget, setSessionTarget] = useState<SessionTarget | undefined>(
    initialTarget.current,
  )
  const [waitingForSession, setWaitingForSession] = useState(false)
  const [view, setView] = useState<SessionView>('summary')
  const [sessionKey, setSessionKey] = useState('')
  const [detail, setDetail] = useState<SessionDetail>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [range, setRange] = useState<TimelineRange>(null)
  const [selectedId, setSelectedId] = useState<string>()
  const [collapsedTurns, setCollapsedTurns] = useState<Set<number>>(new Set())
  const [actualDuration, setActualDuration] = useState(() => localStorage.getItem('trajectory.actualDuration') !== 'false')
  const [collapseCalls, setCollapseCalls] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('details')
  const [rawByRecord, setRawByRecord] = useState<Record<string, unknown[]>>({})
  const [rawLoadingKey, setRawLoadingKey] = useState<string>()
  const [rawError, setRawError] = useState<string>()
  const detailRequest = useRef<{ key: string; controller: AbortController }>()
  const pendingDetailRefresh = useRef<{ key: string; source: SourceId; id: string }>()
  const loadDetailRef = useRef<(source: SourceId, id: string, quiet?: boolean) => Promise<void>>()
  const detailRef = useRef<SessionDetail>()
  const detailRevision = useRef<{ key: string; revision: string }>()
  const sessionsRef = useRef<SessionSummary[]>([])
  const selectedSessionByFilter = useRef<Partial<Record<SourceFilter, string>>>({})

  const loadSources = useCallback(async () => {
    const response = await fetch('/api/sources')
    if (!response.ok) throw new Error(`来源状态加载失败 (${response.status})`)
    setSources(await response.json() as SourceStatus[])
  }, [])

  const loadSessions = useCallback(async (signal: AbortSignal) => {
    const response = await fetch(`/api/sessions?source=${sourceFilter}`, { signal })
    if (!response.ok) throw new Error(`会话列表加载失败 (${response.status})`)
    const result = await response.json() as SessionSummary[]
    if (signal.aborted) return
    sessionsRef.current = result
    setSessions(result)
    const counts = new Map<SourceId, number>()
    for (const session of result) {
      counts.set(session.source, (counts.get(session.source) ?? 0) + 1)
    }
    setSources(current => current.map((status) => {
      if (sourceFilter !== 'all' && status.source !== sourceFilter) return status
      return {
        ...status,
        sessionCount: counts.get(status.source) ?? 0,
        sessionCountState: 'ready',
      }
    }))
    const targeted = sessionTarget === undefined
      ? undefined
      : result.find(session =>
          session.source === sessionTarget.source
          && session.sourceSessionId === sessionTarget.sessionId)
    setWaitingForSession(sessionTarget !== undefined && targeted === undefined)
    setSessionKey((current) => {
      const remembered = selectedSessionByFilter.current[sourceFilter]
      const next = targeted?.id
        ?? (sessionTarget !== undefined
          ? ''
          : remembered !== undefined && result.some(session => session.id === remembered)
            ? remembered
            : result.some(session => session.id === current)
              ? current
              : result[0]?.id ?? '')
      if (next !== '') selectedSessionByFilter.current[sourceFilter] = next
      return next
    })
    if (result.length === 0) {
      setDetail(undefined)
      setLoading(false)
    }
  }, [sessionTarget, sourceFilter])

  const loadDetail = useCallback(async (source: SourceId, id: string, quiet = false) => {
    const key = `${source}:${id}`
    const active = detailRequest.current
    if (active !== undefined) {
      if (active.key === key) {
        pendingDetailRefresh.current = { key, source, id }
        return
      }
      pendingDetailRefresh.current = undefined
      active.controller.abort()
    }
    const controller = new AbortController()
    detailRequest.current = { key, controller }
    const knownRevision = quiet && detailRevision.current?.key === key
      ? detailRevision.current.revision
      : undefined
    const baseUrl = `/api/sessions/${source}/${encodeURIComponent(id)}`
    if (!quiet) setLoading(true)
    try {
      let response = await fetch(
        knownRevision === undefined
          ? baseUrl
          : `${baseUrl}?revision=${encodeURIComponent(knownRevision)}`,
        { signal: controller.signal },
      )
      if (!response.ok) throw new Error(`会话加载失败 (${response.status})`)
      let result = await response.json() as SessionDetailResponse
      let next: SessionDetail | undefined
      let invalidatedRawIds: string[] = []
      let clearSessionRaw = false
      if (result.kind === 'snapshot') {
        next = hydrateDetail(result.detail)
        clearSessionRaw = knownRevision !== undefined
      } else if (knownRevision !== undefined && result.baseRevision === knownRevision) {
        const current = detailRef.current
        if (current !== undefined) {
          next = applyDetailDelta(current, result)
          if (next !== undefined) {
            invalidatedRawIds = [
              ...result.upserts.map(record => record.id),
              ...result.removedIds,
            ]
          }
        }
      }
      if (next === undefined) {
        response = await fetch(baseUrl, { signal: controller.signal })
        if (!response.ok) throw new Error(`会话加载失败 (${response.status})`)
        result = await response.json() as SessionDetailResponse
        if (result.kind !== 'snapshot') throw new Error('会话快照协议错误')
        next = hydrateDetail(result.detail)
        clearSessionRaw = knownRevision !== undefined
      }
      if (controller.signal.aborted) return
      if (clearSessionRaw || invalidatedRawIds.length > 0) {
        const prefix = `${source}:${id}:`
        const invalidated = new Set(invalidatedRawIds.map(recordId => `${prefix}${recordId}`))
        setRawByRecord((current) => Object.fromEntries(
          Object.entries(current).filter(([rawKey]) =>
            clearSessionRaw ? !rawKey.startsWith(prefix) : !invalidated.has(rawKey)),
        ))
      }
      detailRef.current = next
      detailRevision.current = { key, revision: result.revision }
      setView(current =>
        current === 'model-context' && next.projection.modelContextRecordIds === undefined
          ? 'conversation'
          : current)
      setDetail(next)
      setSessions((current) => {
        const updated = current.map(session =>
          session.id === next.summary.id ? next.summary : session)
        sessionsRef.current = updated
        return updated
      })
      setError(undefined)
      setSelectedId(current =>
        current !== undefined && next.projection.records.some(record => record.id === current)
          ? current
          : undefined)
    } catch (caught) {
      if (controller.signal.aborted) return
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (detailRequest.current?.controller === controller) {
        detailRequest.current = undefined
        if (!quiet) setLoading(false)
        const pending = pendingDetailRefresh.current
        pendingDetailRefresh.current = undefined
        if (!controller.signal.aborted && pending?.key === key) {
          queueMicrotask(() => {
            void loadDetailRef.current?.(pending.source, pending.id, true)
          })
        }
      }
    }
  }, [])

  loadDetailRef.current = loadDetail

  useEffect(() => () => detailRequest.current?.controller.abort(), [])

  useEffect(() => {
    void loadSources().catch(caught =>
      setError(caught instanceof Error ? caught.message : String(caught)))
  }, [loadSources])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void loadSessions(controller.signal).catch(caught => {
      if (controller.signal.aborted) return
      setError(caught instanceof Error ? caught.message : String(caught))
      setLoading(false)
    })
    return () => controller.abort()
  }, [loadSessions])

  useEffect(() => {
    if (!waitingForSession || sessionTarget === undefined) return
    const timer = window.setInterval(() => {
      const controller = new AbortController()
      void loadSessions(controller.signal).catch(caught => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      })
    }, 500)
    return () => window.clearInterval(timer)
  }, [loadSessions, sessionTarget, waitingForSession])

  useEffect(() => {
    let stream: EventSource
    try {
      stream = new EventSource('/api/integrations/activations')
    } catch {
      return
    }
    stream.addEventListener('activation', (event) => {
      let activation: SessionTarget | undefined
      try {
        const value = JSON.parse((event as MessageEvent<string>).data) as {
          source?: unknown
          sessionId?: unknown
        }
        const source = typeof value.source === 'string'
          ? sourceId(value.source)
          : undefined
        activation = source === undefined || typeof value.sessionId !== 'string'
          ? undefined
          : { source, sessionId: value.sessionId }
      } catch {
        return
      }
      if (activation === undefined) return
      setError(undefined)
      setLoading(true)
      detailRequest.current?.controller.abort()
      pendingDetailRefresh.current = undefined
      detailRevision.current = undefined
      detailRef.current = undefined
      setDetail(undefined)
      setSessionKey('')
      setSourceFilter(activation.source)
      setSessionTarget(activation)
      const url = new URL(window.location.href)
      url.searchParams.set('source', activation.source)
      url.searchParams.set('session', activation.sessionId)
      window.history.replaceState(null, '', url)
    })
    return () => stream.close()
  }, [])

  const currentSession = sessions.find(session => session.id === sessionKey)
  const currentSessionKey = currentSession?.id
  const currentSource = currentSession?.source
  const currentSourceSessionId = currentSession?.sourceSessionId
  const sourceMetadata = useMemo(
    () => new Map(sources.map(source => [source.source, source])),
    [sources],
  )
  const sourceLabel = (source: SourceId): string =>
    sourceMetadata.get(source)?.label ?? source
  const sourceColor = (source: SourceId): string =>
    sourceMetadata.get(source)?.colorToken ?? 'blue'
  const availableSessionCount = sources
    .filter(source => source.availability !== 'blocked')
    .reduce((total, source) => total + source.sessionCount, 0)

  useEffect(() => {
    setRange(null)
    setSelectedId(undefined)
    setCollapsedTurns(new Set())
    setRawByRecord({})
    setRawLoadingKey(undefined)
    setRawError(undefined)
    detailRevision.current = undefined
    detailRef.current = undefined
    if (currentSource !== undefined && currentSourceSessionId !== undefined) {
      void loadDetail(currentSource, currentSourceSessionId)
    }
  }, [currentSource, currentSourceSessionId, loadDetail])

  useEffect(() => {
    if (currentSource === undefined
      || currentSourceSessionId === undefined
      || currentSessionKey === undefined
      || currentSession?.capabilities.live !== true) return
    const stream = new EventSource(`/api/stream?source=${currentSource}&session=${encodeURIComponent(currentSourceSessionId)}`)
    stream.addEventListener('update', () => void loadDetail(currentSource, currentSourceSessionId, true))
    stream.addEventListener('error', () => {
      setError('实时刷新失败，正在等待自动重试')
    })
    stream.addEventListener('missing', () => {
      stream.close()
      detailRequest.current?.controller.abort()
      const remainingSessions = sessionsRef.current.filter(
        session => session.id !== currentSessionKey,
      )
      const fallbackSessionKey = remainingSessions[0]?.id ?? ''
      sessionsRef.current = remainingSessions
      setSessions(remainingSessions)
      setSessionKey(current =>
        current === currentSessionKey ? fallbackSessionKey : current)
      setDetail(current =>
        current?.summary.id === currentSessionKey ? undefined : current)
      detailRef.current = undefined
      detailRevision.current = undefined
      setSelectedId(undefined)
      setError('会话已被删除或不再可用')
      setLoading(false)
    })
    return () => stream.close()
  }, [
    currentSession?.capabilities.live,
    currentSessionKey,
    currentSource,
    currentSourceSessionId,
    loadDetail,
  ])

  const timelineRecords = useMemo(() => {
    if (detail === undefined) return []
    return collapseCalls
      ? detail.projection.records.filter(record => record.kind !== 'tool' && record.kind !== 'subtool')
      : detail.projection.records
  }, [collapseCalls, detail])

  const timelineGeometry = useMemo(
    () => buildTimelineGeometry(timelineRecords, actualDuration),
    [actualDuration, timelineRecords],
  )

  const filteredRecords = useMemo(() => {
    if (detail === undefined) return []
    const normalized = query.trim().toLowerCase()
    return timelineRecords.filter((record) => {
      if (normalized !== '' && !record.searchText.includes(normalized)) return false
      if (range === null) return true
      const span = timelineGeometry.byId.get(record.id)
      return span !== undefined && span.start <= range[1] && span.end >= range[0]
    })
  }, [detail, query, range, timelineGeometry, timelineRecords])

  const conversationRecords = useMemo(() => {
    if (detail === undefined) return []
    const normalized = query.trim().toLowerCase()
    const requestedIds = view === 'model-context'
      ? detail.projection.modelContextRecordIds
      : detail.projection.transcriptRecordIds
    const byId = new Map(detail.projection.records.map(record => [record.id, record]))
    const records = requestedIds === undefined
      ? detail.projection.records
      : requestedIds.flatMap((id) => {
          const record = byId.get(id)
          return record === undefined ? [] : [record]
        })
    return normalized === ''
      ? records
      : records.filter(record => record.searchText.includes(normalized))
  }, [detail, query, view])

  const selected = detail?.projection.records.find(record => record.id === selectedId)
  const analysis = useMemo(
    () => detail === undefined ? undefined : analyzeTrajectory(detail),
    [detail],
  )
  const selectedRawKey = selected === undefined
    || currentSource === undefined
    || currentSourceSessionId === undefined
    ? undefined
    : `${currentSource}:${currentSourceSessionId}:${selected.id}`

  useEffect(() => {
    if (inspectorTab !== 'raw'
      || selected === undefined
      || selectedRawKey === undefined
      || currentSource === undefined
      || currentSourceSessionId === undefined
      || rawByRecord[selectedRawKey] !== undefined) return
    const controller = new AbortController()
    setRawLoadingKey(selectedRawKey)
    setRawError(undefined)
    void fetch(
      `/api/sessions/${currentSource}/${encodeURIComponent(currentSourceSessionId)}/records/${encodeURIComponent(selected.id)}/raw`,
      { signal: controller.signal },
    ).then(async (response) => {
      if (!response.ok) throw new Error(`原始事件加载失败 (${response.status})`)
      const result = await response.json() as { raw: unknown[] }
      if (controller.signal.aborted) return
      setRawByRecord(current => ({ ...current, [selectedRawKey]: result.raw }))
      setRawLoadingKey(current => current === selectedRawKey ? undefined : current)
    }).catch((caught) => {
      if (!controller.signal.aborted) {
        setRawError(caught instanceof Error ? caught.message : String(caught))
        setRawLoadingKey(current => current === selectedRawKey ? undefined : current)
      }
    })
    return () => controller.abort()
  }, [
    currentSource,
    currentSourceSessionId,
    inspectorTab,
    rawByRecord,
    selected,
    selectedRawKey,
  ])

  const toggleTurn = (turn: number) => setCollapsedTurns((current) => {
    const next = new Set(current)
    if (next.has(turn)) next.delete(turn)
    else next.add(turn)
    return next
  })

  const collapseAll = () => {
    const turns = new Set(filteredRecords.map(record => record.turn))
    setCollapsedTurns(current => current.size === turns.size ? new Set() : turns)
  }

  const toggleDuration = () => {
    setActualDuration((current) => {
      localStorage.setItem('trajectory.actualDuration', String(!current))
      return !current
    })
    setRange(null)
  }

  const exportProjection = () => {
    if (detail === undefined) return
    const blob = new Blob([json(detail)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${detail.summary.source}-${detail.summary.sourceSessionId}.trajectory.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const auditExport = detail === undefined
    ? undefined
    : {
        href: `/api/sessions/${detail.summary.source}/${encodeURIComponent(detail.summary.sourceSessionId)}/export`,
        filename: `${detail.summary.source}-${
          detail.summary.sourceSessionId.replace(/[^A-Za-z0-9._-]+/g, '_')
        }.audit.json`,
      }
  const completedTurns = detail?.projection.turns
    .filter(turn => turn.status === 'complete').length ?? 0
  const eventTypeCounts = Object.entries(detail?.projection.eventTypeCounts ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
  const taskState = detail?.projection.taskState
  const activeTodos = taskState?.todos.filter(todo => todo.status === 'in_progress').length ?? 0
  const completedTodos = taskState?.todos.filter(todo => todo.status === 'completed').length ?? 0

  const currentCapabilities = detail?.summary.capabilities
  const useActualDuration = actualDuration && currentCapabilities?.timing !== false
  const blockedSources = sources.filter(source => source.availability === 'blocked')

  return (
    <main className={`app-shell view-${view}${selected === undefined ? '' : ' inspector-open'}`}>
      <header className="app-header">
        <div className="brand">
          <Activity size={21} />
          <span>Agent Trajectory</span>
        </div>
        <div className="session-picker">
          <SourcePicker
            sources={sources}
            value={sourceFilter}
            total={availableSessionCount}
            onChange={(next) => {
              if (sessionKey !== '') selectedSessionByFilter.current[sourceFilter] = sessionKey
              setSessionTarget(undefined)
              setWaitingForSession(false)
              setSourceFilter(next)
              const url = new URL(window.location.href)
              url.searchParams.delete('source')
              url.searchParams.delete('session')
              window.history.replaceState(null, '', url)
            }}
          />
          <select
            value={sessionKey}
            onChange={(event) => {
              const next = event.target.value
              selectedSessionByFilter.current[sourceFilter] = next
              setSessionKey(next)
              setSessionTarget(undefined)
              setWaitingForSession(false)
              const session = sessions.find(candidate => candidate.id === next)
              if (session !== undefined) {
                const url = new URL(window.location.href)
                url.searchParams.set('source', session.source)
                url.searchParams.set('session', session.sourceSessionId)
                window.history.replaceState(null, '', url)
              }
            }}
            aria-label="选择会话"
          >
            {sessions.length === 0 && <option value="">无可用会话</option>}
            {sessions.map(session => (
              <option value={session.id} key={session.id}>
                [{sourceLabel(session.source)}] {session.title}
              </option>
            ))}
          </select>
        </div>
        <div className="header-actions">
          {currentSession?.capabilities.live === true && <span className="live-status"><i /> 准实时</span>}
          <button
            className="icon-button"
            type="button"
            disabled={currentSession === undefined}
            onClick={() => currentSession === undefined
              ? undefined
              : void loadDetail(currentSession.source, currentSession.sourceSessionId)}
            title="刷新"
          >
            <RefreshCw size={17} />
          </button>
          <button
            className="text-button export-button"
            type="button"
            disabled={detail === undefined}
            onClick={exportProjection}
            aria-label="导出投影"
            title="导出不含原始事件的当前投影 JSON"
          >
            <Download size={16} />
            <span>投影导出</span>
          </button>
          {auditExport === undefined
            ? (
                <span
                  className="text-button export-button disabled"
                  aria-hidden="true"
                >
                  <FileJson size={16} />
                  <span>审计导出</span>
                </span>
              )
            : (
                <a
                  className="text-button export-button"
                  href={auditExport.href}
                  download={auditExport.filename}
                  aria-label="完整审计导出"
                  title="导出完整、已脱敏的投影与原始事件"
                >
                  <FileJson size={16} />
                  <span>审计导出</span>
                </a>
              )}
        </div>
      </header>

      <nav className="view-tabs" aria-label="会话视图" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'conversation'}
          className={view === 'conversation' ? 'active' : ''}
          onClick={() => {
            setView('conversation')
            setSelectedId(undefined)
          }}
        >
          <MessageSquare size={17} /> 对话
        </button>
        {detail?.projection.modelContextRecordIds !== undefined && (
          <button
            type="button"
            role="tab"
            aria-selected={view === 'model-context'}
            className={view === 'model-context' ? 'active' : ''}
            onClick={() => {
              setView('model-context')
              setSelectedId(undefined)
            }}
          >
            <Layers3 size={17} /> 模型上下文
          </button>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={view === 'trajectory'}
          className={view === 'trajectory' ? 'active' : ''}
          onClick={() => setView('trajectory')}
        >
          <Activity size={17} /> 轨迹
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'summary'}
          className={view === 'summary' ? 'active' : ''}
          onClick={() => {
            setView('summary')
            setSelectedId(undefined)
          }}
        >
          <BarChart3 size={17} /> 轨迹评测
        </button>
      </nav>

      {view !== 'summary' && <section className="toolbar">
        <div className="toolbar-modes" aria-label={view === 'trajectory' ? '轨迹控制' : '消息控制'}>
          {view === 'trajectory' && (
            <>
            {currentCapabilities?.timing !== false && (
              <button type="button" className={actualDuration ? 'active' : ''} onClick={toggleDuration} aria-pressed={actualDuration}>
                <Clock3 size={16} /> <span>时长</span>
              </button>
            )}
            <button type="button" className={collapsedTurns.size > 0 ? 'active' : ''} onClick={collapseAll} aria-pressed={collapsedTurns.size > 0}>
              <PanelTop size={16} /> <span>轮次</span>
            </button>
            {currentCapabilities?.tools !== false && (
              <button type="button" className={collapseCalls ? 'active' : ''} onClick={() => setCollapseCalls(current => !current)} aria-pressed={collapseCalls}>
                <SquareTerminal size={16} /> <span>调用</span>
              </button>
            )}
            </>
          )}
        </div>
        <div className="toolbar-actions">
          <label className="search-box">
            <Search size={16} />
            <input
              aria-label={view === 'trajectory' ? '搜索轨迹记录' : '搜索会话内容'}
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={view === 'trajectory'
                ? '搜索记录、调用 ID 或错误'
                : '搜索消息、推理或工具调用'}
            />
            {query !== '' && (
              <button type="button" onClick={() => setQuery('')} title="清空搜索"><X size={14} /></button>
            )}
          </label>
        </div>
      </section>}

      {error !== undefined && <div className="error-banner">{error}</div>}
      {waitingForSession && sessionTarget !== undefined && detail === undefined
        ? (
            <div className="loading-state">
              <Activity size={22} />
              <span>
                正在等待 {sourceLabel(sessionTarget.source)} 会话写入…
              </span>
            </div>
          )
        : loading && detail === undefined
        ? (
            <div className="loading-state">
              <Activity size={22} />
              <span>正在读取本地会话…</span>
            </div>
          )
        : detail === undefined
          ? (
              <div className="empty-state">
                <FileJson size={28} />
                <strong>当前筛选没有可用的 Agent 会话</strong>
                {blockedSources.length === 0
                  ? <span>未检测到可读取的本地会话</span>
                  : (
                      <div className="source-diagnostics">
                        {blockedSources.map(source => (
                          <article key={source.source}>
                            <strong>
                              {source.label}：
                              {source.protocol === undefined ? '来源不可用' : '协议暂不兼容'}
                            </strong>
                            {source.detail !== undefined && <span>{source.detail}</span>}
                            {source.protocol !== undefined && (
                              <>
                                <span>
                                  检测到 {source.protocol.detected} · 支持{' '}
                                  {source.protocol.supported.join('、')}
                                </span>
                                <code>{source.protocol.fingerprint}</code>
                              </>
                            )}
                          </article>
                        ))}
                      </div>
                    )}
              </div>
            )
          : (
              <>
                {view !== 'summary' && <div className="session-meta">
                  <div className="session-identity">
                    <strong>
                      <span className={`source-badge source-color-${sourceColor(detail.summary.source)}`}>
                        {sourceLabel(detail.summary.source)}
                      </span>
                      <span className="session-title">{detail.summary.title}</span>
                    </strong>
                    <span>{detail.summary.cwd || '工作目录未记录'}</span>
                    {(detail.projection.header.parentSessionId !== undefined
                      || detail.projection.header.traceId !== undefined
                      || detail.projection.header.delegationDepth !== undefined) && (
                      <div className="session-lineage">
                        {detail.projection.header.parentSessionId !== undefined && (
                          <span title={detail.projection.header.parentSessionId}>
                            父会话 {detail.projection.header.parentSessionId}
                          </span>
                        )}
                        {detail.projection.header.delegationDepth !== undefined && (
                          <span>深度 {detail.projection.header.delegationDepth}</span>
                        )}
                        {detail.projection.header.traceId !== undefined && (
                          <span title={detail.projection.header.traceId}>
                            Trace {detail.projection.header.traceId}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {taskState !== undefined && (
                    <section className="task-state" aria-label="任务状态">
                      {taskState.target !== undefined && (
                        <div className="task-target">
                          <span className={`task-status status-${taskState.target.status}`}>
                            {taskState.target.status}
                          </span>
                          <strong title={taskState.target.objective}>
                            {taskState.target.objective}
                          </strong>
                          {taskState.target.roundsStarted !== undefined
                            && taskState.target.maxRounds !== undefined && (
                              <small>
                                {taskState.target.roundsStarted} / {taskState.target.maxRounds} 轮
                              </small>
                            )}
                        </div>
                      )}
                      <span className="task-todo-summary">
                        {activeTodos} 进行中 · {completedTodos} 已完成 · {taskState.todos.length} 总计
                      </span>
                    </section>
                  )}
                  <dl>
                    <div><dt>事件</dt><dd>{detail.projection.eventCount}</dd></div>
                    <div><dt>记录</dt><dd>{detail.projection.records.length}</dd></div>
                    <div>
                      <dt>Token</dt>
                      <dd>
                        {detail.projection.usage === undefined
                          ? '未记录'
                          : `${detail.projection.usage.inputTokens ?? 0} 输入 / ${
                            detail.projection.usage.outputTokens ?? 0
                          } 输出 / ${
                            detail.projection.usage.totalTokens
                              ?? (detail.projection.usage.inputTokens ?? 0)
                                + (detail.projection.usage.outputTokens ?? 0)
                          } 总计`}
                      </dd>
                    </div>
                    <div><dt>完成轮次</dt><dd>{completedTurns} / {detail.projection.turns.length}</dd></div>
                    {detail.projection.coverageSummary !== undefined && (
                      <div>
                        <dt>投影覆盖</dt>
                        <dd>
                          {detail.projection.coverageSummary.consumed} / {
                            detail.projection.coverageSummary.total
                          } 已消费 · {detail.projection.coverageSummary.gap} gap
                        </dd>
                      </div>
                    )}
                    <details className="event-type-stat">
                      <summary>{eventTypeCounts.length} 种事件类型</summary>
                      <div className="event-type-popover">
                        {eventTypeCounts.length === 0
                          ? <span>没有事件类型统计</span>
                          : eventTypeCounts.map(([type, count]) => (
                              <div className="event-type-item" key={type}>
                                <code>{type}</code>
                                <span className="event-type-count">{count}</span>
                              </div>
                            ))}
                      </div>
                    </details>
                    <div><dt>更新时间</dt><dd>{formatTime(detail.summary.updatedAt)}</dd></div>
                  </dl>
                </div>}
                {view === 'summary' && analysis !== undefined
                  ? (
                      <TrajectorySummary
                        analysis={analysis}
                        source={detail.summary.source}
                        sourceSessionId={detail.summary.sourceSessionId}
                        sessionModel={detail.projection.header.model}
                        sessionProvider={detail.projection.header.provider}
                        sessionMeta={{
                          eventCount: detail.projection.eventCount,
                          recordCount: detail.projection.records.length,
                          eventTypeCount: eventTypeCounts.length,
                          completedTurns,
                          createdAt: detail.summary.createdAt,
                          updatedAt: detail.summary.updatedAt,
                          projectionStartTime: detail.projection.startTime,
                          projectionEndTime: detail.projection.endTime,
                        }}
                        onOpenRecord={(id) => {
                          setView('trajectory')
                          setSelectedId(id)
                          setInspectorTab('details')
                        }}
                      />
                    )
                  : view !== 'trajectory'
                  ? (
                      <Conversation
                        records={conversationRecords}
                        onInspect={(id) => {
                          setSelectedId(id)
                          setInspectorTab('details')
                        }}
                        onLocate={(id) => {
                          setView('trajectory')
                          setSelectedId(id)
                          setInspectorTab('details')
                        }}
                      />
                    )
                  : (
                      <>
                        <Timeline
                          records={timelineRecords}
                          actualDuration={useActualDuration}
                          range={range}
                          selectedId={selectedId}
                          onRangeChange={setRange}
                          onSelect={(id) => {
                            setSelectedId(id)
                            setInspectorTab('details')
                          }}
                        />
                        <section className="ledger">
                          <header className="ledger-header">
                            <span />
                            <span>类型</span>
                            <span>记录</span>
                            <span />
                            <span>耗时</span>
                            <span><Hash size={13} /></span>
                          </header>
                          {filteredRecords.length === 0
                            ? <div className="no-results">当前筛选范围内没有记录</div>
                            : (
                                <VirtualLedger
                                  records={filteredRecords}
                                  turns={detail.projection.turns}
                                  selectedId={selectedId}
                                  collapsedTurns={collapsedTurns}
                                  onToggleTurn={toggleTurn}
                                  onSelect={(id) => {
                                    setSelectedId(id)
                                    setInspectorTab('details')
                                  }}
                                />
                              )}
                        </section>
                      </>
                    )}
              </>
            )}

      {selected !== undefined && (
        <Inspector
          record={selected}
          capabilities={detail!.summary.capabilities}
          sourceLabel={sourceLabel(selected.source)}
          tab={inspectorTab}
          raw={selectedRawKey === undefined
            ? selected.raw
            : rawByRecord[selectedRawKey] ?? selected.raw}
          rawLoading={selectedRawKey !== undefined && rawLoadingKey === selectedRawKey}
          rawError={rawError}
          onTabChange={setInspectorTab}
          onClose={() => setSelectedId(undefined)}
        />
      )}
    </main>
  )
}
