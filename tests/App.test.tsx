// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  App,
  sessionTargetFromLocation,
} from '../src/App'
import { capabilities, sessionKey } from '../server/sources/types'
import type {
  SessionDetail,
  SessionDetailDelta,
  SessionDetailResponse,
  SessionSummary,
  SourceStatus,
  TrajectoryRecord,
} from '../src/types'

function response(value: unknown): Response {
  const payload: unknown = value !== null
    && typeof value === 'object'
    && 'summary' in value
    && 'projection' in value
    ? {
        kind: 'snapshot',
        revision: `revision-${(value as SessionDetail).summary.updatedAt}`,
        detail: value as SessionDetail,
      } satisfies SessionDetailResponse
    : value
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

function summary(source: 'dsh' | 'zcode', id: string, title: string): SessionSummary {
  return {
    id: sessionKey(source, id),
    source,
    sourceSessionId: id,
    format: 'test',
    capabilities: capabilities('messages'),
    cwd: '/tmp',
    title,
    createdAt: 1,
    updatedAt: 2,
    size: 3,
  }
}

function detail(value: SessionSummary): SessionDetail {
  return {
    summary: value,
    projection: {
      header: {
        source: value.source,
        format: value.format,
        id: value.sourceSessionId,
        createdAt: value.createdAt,
      },
      records: [],
      turns: [],
      lanes: [],
      startTime: value.createdAt,
      endTime: value.updatedAt,
      eventCount: 0,
      eventTypeCounts: {},
      unknownEventTypes: [],
      turnEnds: {},
    },
  }
}

function detailWithRecord(value: SessionSummary, record: TrajectoryRecord): SessionDetail {
  const result = detail(value)
  result.projection.records = [record]
  result.projection.eventCount = 1
  return result
}

const statuses: SourceStatus[] = [
  {
    source: 'dsh',
    availability: 'available',
    label: 'DSH API',
    colorToken: 'blue',
    iconToken: 'agent',
    sessionCount: 1,
    capabilities: capabilities('messages'),
  },
  {
    source: 'zcode',
    availability: 'available',
    label: 'ZCode API',
    colorToken: 'amber',
    iconToken: 'terminal',
    sessionCount: 1,
    capabilities: capabilities('messages'),
  },
]

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  })
})

function openTrajectory(): void {
  fireEvent.click(screen.getByRole('tab', { name: '轨迹' }))
}

async function chooseSource(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: '筛选来源' }))
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(`^${name}`) }))
}

async function waitForLoadedSession(source: string, id: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole('link', { name: '完整审计导出' }).getAttribute('href'))
      .toBe(`/api/sessions/${source}/${id}/export`)
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  window.history.replaceState(null, '', '/')
})

describe('App request ordering', () => {
  it('shows a portable protocol diagnosis for a blocked source', async () => {
    vi.stubGlobal('EventSource', class {
      addEventListener() {}
      close() {}
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') {
        return response([{
          ...statuses[0],
          availability: 'blocked',
          sessionCount: 0,
          sessionCountState: 'ready',
          reason: 'unsupported_dsh_protocol',
          detail: '检测到 dsh-session-v5；当前仅支持 dsh-session-v4',
          protocol: {
            detected: 'dsh-session-v5',
            supported: ['dsh-session-v4'],
            fingerprint: 'dsh:session:v5',
          },
        } satisfies SourceStatus])
      }
      if (url === '/api/sessions?source=all') return response([])
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)

    expect(await screen.findByText('DSH API：协议暂不兼容')).toBeTruthy()
    expect(screen.getByText(
      '检测到 dsh-session-v5 · 支持 dsh-session-v4',
    )).toBeTruthy()
    expect(screen.getByText('dsh:session:v5')).toBeTruthy()
  })

  it('updates a pending source count after session discovery completes', async () => {
    const dshSession = summary('dsh', 'discovered-session', 'Discovered session')
    vi.stubGlobal('EventSource', class {
      addEventListener() {}
      close() {}
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') {
        return response([{
          ...statuses[0],
          sessionCount: 0,
          sessionCountState: 'pending',
        } satisfies SourceStatus])
      }
      if (url === '/api/sessions?source=all') return response([dshSession])
      if (url === '/api/sessions/dsh/discovered-session') {
        return response(detail(dshSession))
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    await screen.findByRole('option', { name: '[DSH API] Discovered session' })
    fireEvent.click(screen.getByRole('button', { name: '筛选来源' }))

    expect(screen.getByRole('option', { name: /^DSH API/ }).textContent)
      .toContain('1 个会话')
  })

  it('parses a source-qualified session deep link without accepting invalid sources', () => {
    expect(sessionTargetFromLocation({
      search: '?source=codex&session=thread%2Fone',
    } as Location)).toEqual({
      source: 'codex',
      sessionId: 'thread/one',
    })
    expect(sessionTargetFromLocation({
      search: '?source=../../etc&session=thread-one',
    } as Location)).toBeUndefined()
  })

  it('copies a diagnosis prompt for the switched trajectory target', async () => {
    const zcodeSession = summary('zcode', 'trigger-session', 'Trigger session')
    const dshSession = summary('dsh', 'target-session', 'Target session')
    const diagnosisRequests: Array<Record<string, unknown>> = []
    const writeText = vi.fn(async () => {})
    window.history.replaceState(
      null,
      '',
      '/?source=zcode&session=trigger-session',
    )
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('EventSource', class {
      addEventListener() {}
      close() {}
    })
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText },
    })
    vi.stubGlobal('fetch', vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=zcode') return response([zcodeSession])
      if (url === '/api/sessions?source=all') {
        return response([zcodeSession, dshSession])
      }
      if (url === '/api/sessions/zcode/trigger-session') {
        return response(detail(zcodeSession))
      }
      if (url === '/api/sessions/dsh/target-session') {
        return response(detail(dshSession))
      }
      if (url === '/api/diagnosis/prompt') {
        diagnosisRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({
          status: 'prepared',
          protocol: 'trajectory-diagnosis-v1',
          snapshotId: 'snapshot-codex-diagnosis',
          prompt: 'app diagnosis prompt',
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    await waitForLoadedSession('zcode', 'trigger-session')
    await chooseSource('全部来源')
    await screen.findByRole('option', { name: '[DSH API] Target session' })
    fireEvent.change(screen.getByRole('combobox', { name: '选择会话' }), {
      target: { value: dshSession.id },
    })
    await waitForLoadedSession('dsh', 'target-session')
    fireEvent.click(screen.getByRole('button', { name: '本地 Agent 诊断' }))

    await waitFor(() => expect(diagnosisRequests).toEqual([{
      target: { source: 'dsh', sessionId: 'target-session' },
    }]))
    expect(writeText).toHaveBeenCalledWith('app diagnosis prompt')
    expect(await screen.findByRole('dialog', { name: '已复制 Prompt' })).toBeTruthy()
    expect(window.location.search).not.toContain('initiator=')
  })

  it('loads the exact deep-linked session instead of the newest session', async () => {
    const newest = summary('zcode', 'newest-session', 'Newest session')
    const linked = summary('zcode', 'linked-session', 'Linked session')
    window.history.replaceState(
      null,
      '',
      '/?source=zcode&session=linked-session',
    )
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('EventSource', class {
      addEventListener() {}
      close() {}
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=zcode') return response([newest, linked])
      if (url === '/api/sessions/zcode/linked-session') return response(detail(linked))
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)

    await waitForLoadedSession('zcode', 'linked-session')
    expect((screen.getByRole('combobox', { name: '选择会话' }) as HTMLSelectElement).value)
      .toBe(linked.id)
  })

  it('keeps the newest source selection when an older session request finishes last', async () => {
    const oldRequest = deferred<Response>()
    const oldSession = summary('dsh', 'old-session', 'Old DSH session')
    const currentSession = summary('zcode', 'current-session', 'Current ZCode session')
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return oldRequest.promise
      if (url === '/api/sessions?source=zcode') return response([currentSession])
      if (url === '/api/sessions/zcode/current-session') return response(detail(currentSession))
      if (url === '/api/sessions/dsh/old-session') return response(detail(oldSession))
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    await chooseSource('ZCode API')
    await screen.findByRole('option', { name: '[ZCode API] Current ZCode session' })

    oldRequest.resolve(response([oldSession]))

    await waitFor(() => {
      expect((screen.getByRole('combobox', { name: '选择会话' }) as HTMLSelectElement).value)
        .toBe(sessionKey('zcode', 'current-session'))
    })
    expect(screen.queryByRole('option', { name: '[DSH] Old DSH session' })).toBeNull()
  })

  it('keeps the newest session detail when an older detail request finishes last', async () => {
    const firstRequest = deferred<Response>()
    const firstSession = summary('zcode', 'first-session', 'First session')
    const secondSession = summary('zcode', 'second-session', 'Second session')
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([firstSession, secondSession])
      if (url === '/api/sessions/zcode/first-session') return firstRequest.promise
      if (url === '/api/sessions/zcode/second-session') return response(detail(secondSession))
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    const sessionSelect = await screen.findByRole('combobox', { name: '选择会话' })
    await screen.findByRole('option', { name: '[ZCode API] Second session' })
    fireEvent.change(sessionSelect, {
      target: { value: sessionKey('zcode', 'second-session') },
    })
    await waitForLoadedSession('zcode', 'second-session')

    firstRequest.resolve(response(detail(firstSession)))

    await waitFor(() => {
      expect(screen.getByRole('link', { name: '完整审计导出' }).getAttribute('href'))
        .toBe('/api/sessions/zcode/second-session/export')
    })
  })

  it('remembers the selected session for each source filter', async () => {
    const first = summary('zcode', 'remember-first', 'Remember first')
    const second = summary('zcode', 'remember-second', 'Remember second')
    const dsh = summary('dsh', 'remember-dsh', 'Remember DSH')
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([first, second, dsh])
      if (url === '/api/sessions?source=zcode') return response([first, second])
      if (url === '/api/sessions?source=dsh') return response([dsh])
      if (url === '/api/sessions/zcode/remember-first') return response(detail(first))
      if (url === '/api/sessions/zcode/remember-second') return response(detail(second))
      if (url === '/api/sessions/dsh/remember-dsh') return response(detail(dsh))
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '筛选来源' }).textContent)
        .toContain('3')
    })
    const sessionSelect = screen.getByRole('combobox', { name: '选择会话' })
    fireEvent.click(screen.getByRole('button', { name: '筛选来源' }))
    expect(screen.getByRole('option', { name: /^全部来源/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /^ZCode API/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '筛选来源' }))

    fireEvent.change(sessionSelect, { target: { value: second.id } })
    await waitForLoadedSession('zcode', 'remember-second')
    await chooseSource('DSH API')
    await waitForLoadedSession('dsh', 'remember-dsh')
    await chooseSource('全部来源')

    await waitFor(() => {
      expect((screen.getByRole('combobox', { name: '选择会话' }) as HTMLSelectElement).value)
        .toBe(second.id)
    })
    expect(screen.getByRole('tab', { name: '轨迹评测', selected: true })).toBeTruthy()
  })

  it('loads raw events only after the inspector raw tab is opened', async () => {
    const currentSession = summary('zcode', 'raw-session', 'Raw session')
    const record: TrajectoryRecord = {
      id: 'record:1',
      source: 'zcode',
      sourceEventIds: ['part-1'],
      fidelity: 'exact',
      seq: 1,
      turn: 1,
      step: 1,
      kind: 'assistant',
      title: 'Raw record',
      summary: 'raw is loaded separately',
      startTime: 1,
      endTime: 2,
      status: 'complete',
      depth: 0,
      searchText: 'raw record',
    }
    const rawUrl = '/api/sessions/zcode/raw-session/records/record%3A1/raw'
    const requested: string[] = []
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requested.push(url)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([currentSession])
      if (url === '/api/sessions/zcode/raw-session') {
        return response(detailWithRecord(currentSession, record))
      }
      if (url === rawUrl) {
        return response({ raw: [{ type: 'text', text: 'loaded on demand' }] })
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    openTrajectory()
    await screen.findByText('Raw record', { selector: '.record-main strong' })
    expect(requested).not.toContain(rawUrl)

    fireEvent.click(screen.getByText('Raw record', { selector: '.record-main strong' }))
    fireEvent.click(await screen.findByRole('button', { name: '原始事件' }))

    await waitFor(() => expect(requested).toContain(rawUrl))
    expect(await screen.findByText(/loaded on demand/, { selector: '.raw-inspector' }))
      .toBeTruthy()
    expect(requested.filter(url => url === rawUrl)).toHaveLength(1)
  })

  it('clears raw event cache when switching sessions', async () => {
    const firstSession = summary('zcode', 'first-raw-session', 'First raw session')
    const secondSession = summary('zcode', 'second-raw-session', 'Second raw session')
    const firstRecord: TrajectoryRecord = {
      id: 'record-1',
      source: 'zcode',
      sourceEventIds: ['part-1'],
      fidelity: 'exact',
      seq: 1,
      turn: 1,
      step: 1,
      kind: 'assistant',
      title: 'First raw record',
      summary: 'first raw record',
      startTime: 1,
      endTime: 2,
      status: 'complete',
      depth: 0,
      searchText: 'first raw record',
    }
    const firstRawUrl = '/api/sessions/zcode/first-raw-session/records/record-1/raw'
    let firstRawRequests = 0
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') {
        return response([firstSession, secondSession])
      }
      if (url === '/api/sessions/zcode/first-raw-session') {
        return response(detailWithRecord(firstSession, firstRecord))
      }
      if (url === '/api/sessions/zcode/second-raw-session') {
        return response(detail(secondSession))
      }
      if (url === firstRawUrl) {
        firstRawRequests++
        return response({
          raw: [{ text: firstRawRequests === 1 ? 'first visit raw' : 'second visit raw' }],
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    openTrajectory()
    const sessionSelect = await screen.findByRole('combobox', { name: '选择会话' })
    fireEvent.click(await screen.findByText('First raw record', { selector: '.record-main strong' }))
    fireEvent.click(await screen.findByRole('button', { name: '原始事件' }))
    expect(await screen.findByText(/first visit raw/, { selector: '.raw-inspector' }))
      .toBeTruthy()

    fireEvent.change(sessionSelect, {
      target: { value: sessionKey('zcode', 'second-raw-session') },
    })
    await waitForLoadedSession('zcode', 'second-raw-session')
    fireEvent.change(sessionSelect, {
      target: { value: sessionKey('zcode', 'first-raw-session') },
    })
    fireEvent.click(await screen.findByText('First raw record', { selector: '.record-main strong' }))
    fireEvent.click(await screen.findByRole('button', { name: '原始事件' }))

    expect(await screen.findByText(/second visit raw/, { selector: '.raw-inspector' }))
      .toBeTruthy()
    expect(firstRawRequests).toBe(2)
  })
})

describe('App live session state', () => {
  it('coalesces live updates while the current session detail request is in flight', async () => {
    const currentSession = summary('dsh', 'coalesced-session', 'Coalesced session')
    currentSession.capabilities = capabilities('messages', 'live')
    const initialRequest = deferred<Response>()
    const listeners = new Map<string, Set<EventListener>>()
    class FakeEventSource {
      constructor(public readonly url: string) {}
      addEventListener(type: string, listener: EventListener) {
        const registered = listeners.get(type) ?? new Set<EventListener>()
        registered.add(listener)
        listeners.set(type, registered)
      }
      close() {}
    }
    const requested: string[] = []
    let initialSignal: AbortSignal | undefined
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input)
      requested.push(url)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([currentSession])
      if (url === '/api/sessions/dsh/coalesced-session') {
        initialSignal = init?.signal ?? undefined
        return initialRequest.promise
      }
      if (url === '/api/sessions/dsh/coalesced-session?revision=revision-2') {
        const current = detail(currentSession)
        const { records: _records, ...projection } = current.projection
        return response({
          kind: 'delta',
          baseRevision: 'revision-2',
          revision: 'revision-2',
          summary: current.summary,
          projection,
          upserts: [],
          removedIds: [],
          recordOrder: [],
        } satisfies SessionDetailDelta)
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    await waitFor(() => expect(listeners.get('update')?.size).toBe(1))
    for (let index = 0; index < 3; index++) {
      for (const listener of listeners.get('update') ?? []) {
        listener(new MessageEvent('update'))
      }
    }

    expect(initialSignal?.aborted).toBe(false)
    expect(requested.filter(url =>
      url === '/api/sessions/dsh/coalesced-session')).toHaveLength(1)

    initialRequest.resolve(response(detail(currentSession)))

    await waitForLoadedSession('dsh', 'coalesced-session')
    await waitFor(() => {
      expect(requested.filter(url =>
        url === '/api/sessions/dsh/coalesced-session?revision=revision-2'))
        .toHaveLength(1)
    })
  })

  it('reloads raw events when a live delta updates the selected record', async () => {
    const currentSession = summary('dsh', 'raw-delta-session', 'Raw delta session')
    currentSession.capabilities = capabilities('messages', 'live')
    const initialRecord: TrajectoryRecord = {
      id: 'record-1',
      source: 'dsh',
      sourceEventIds: ['1'],
      fidelity: 'exact',
      seq: 1,
      turn: 1,
      step: 1,
      kind: 'assistant',
      title: 'Mutable record',
      summary: 'before update',
      startTime: 1,
      endTime: null,
      status: 'running',
      depth: 0,
      searchText: 'mutable record before update',
    }
    const updatedRecord: TrajectoryRecord = {
      ...initialRecord,
      summary: 'after update',
      endTime: 3,
      status: 'complete',
      searchText: 'mutable record after update',
    }
    const initial = detailWithRecord(currentSession, initialRecord)
    const { records: _records, ...projection } = initial.projection
    const { searchText: _searchText, ...transportRecord } = updatedRecord
    const delta: SessionDetailDelta = {
      kind: 'delta',
      baseRevision: 'revision-2',
      revision: 'revision-3',
      summary: { ...currentSession, updatedAt: 3 },
      projection,
      upserts: [transportRecord],
      removedIds: [],
      recordOrder: ['record-1'],
    }
    const snapshotAfterDelta = detailWithRecord(
      { ...currentSession, updatedAt: 4 },
      { ...updatedRecord, summary: 'after snapshot' },
    )
    const listeners = new Map<string, Set<EventListener>>()
    class FakeEventSource {
      constructor(public readonly url: string) {}
      addEventListener(type: string, listener: EventListener) {
        const registered = listeners.get(type) ?? new Set<EventListener>()
        registered.add(listener)
        listeners.set(type, registered)
      }
      close() {}
    }
    const rawUrl = '/api/sessions/dsh/raw-delta-session/records/record-1/raw'
    let rawRequests = 0
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([currentSession])
      if (url === '/api/sessions/dsh/raw-delta-session') return response(initial)
      if (url === '/api/sessions/dsh/raw-delta-session?revision=revision-2') {
        return new Response(JSON.stringify(delta))
      }
      if (url === '/api/sessions/dsh/raw-delta-session?revision=revision-3') {
        return response(snapshotAfterDelta)
      }
      if (url === rawUrl) {
        rawRequests++
        return response({
          raw: [{
            text: rawRequests === 1
              ? 'old raw'
              : rawRequests === 2
                ? 'new raw'
                : 'snapshot raw',
          }],
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    openTrajectory()
    fireEvent.click(await screen.findByText('Mutable record', { selector: '.record-main strong' }))
    fireEvent.click(await screen.findByRole('button', { name: '原始事件' }))
    expect(await screen.findByText(/old raw/, { selector: '.raw-inspector' })).toBeTruthy()

    for (const listener of listeners.get('update') ?? []) {
      listener(new MessageEvent('update'))
    }

    expect(await screen.findByText(/new raw/, { selector: '.raw-inspector' })).toBeTruthy()
    expect(rawRequests).toBe(2)

    for (const listener of listeners.get('update') ?? []) {
      listener(new MessageEvent('update'))
    }

    expect(await screen.findByText(/snapshot raw/, { selector: '.raw-inspector' }))
      .toBeTruthy()
    expect(rawRequests).toBe(3)
  })

  it('reloads raw events when a removed record later reappears with the same id', async () => {
    const currentSession = summary('dsh', 'raw-remove-session', 'Raw remove session')
    currentSession.capabilities = capabilities('messages', 'live')
    const record: TrajectoryRecord = {
      id: 'record-1',
      source: 'dsh',
      sourceEventIds: ['1'],
      fidelity: 'exact',
      seq: 1,
      turn: 1,
      step: 1,
      kind: 'assistant',
      title: 'Reappearing record',
      summary: 'initial',
      startTime: 1,
      endTime: 2,
      status: 'complete',
      depth: 0,
      searchText: 'reappearing record initial',
    }
    const initial = detailWithRecord(currentSession, record)
    const { records: _records, ...projection } = initial.projection
    const removed: SessionDetailDelta = {
      kind: 'delta',
      baseRevision: 'revision-2',
      revision: 'revision-3',
      summary: { ...currentSession, updatedAt: 3 },
      projection: { ...projection, eventCount: 0 },
      upserts: [],
      removedIds: ['record-1'],
      recordOrder: [],
    }
    const { searchText: _searchText, ...transportRecord } = {
      ...record,
      summary: 'reappeared',
      searchText: 'reappearing record reappeared',
    }
    const reappeared: SessionDetailDelta = {
      kind: 'delta',
      baseRevision: 'revision-3',
      revision: 'revision-4',
      summary: { ...currentSession, updatedAt: 4 },
      projection,
      upserts: [transportRecord],
      removedIds: [],
      recordOrder: ['record-1'],
    }
    const listeners = new Map<string, Set<EventListener>>()
    class FakeEventSource {
      constructor(public readonly url: string) {}
      addEventListener(type: string, listener: EventListener) {
        const registered = listeners.get(type) ?? new Set<EventListener>()
        registered.add(listener)
        listeners.set(type, registered)
      }
      close() {}
    }
    const rawUrl = '/api/sessions/dsh/raw-remove-session/records/record-1/raw'
    let rawRequests = 0
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([currentSession])
      if (url === '/api/sessions/dsh/raw-remove-session') return response(initial)
      if (url === '/api/sessions/dsh/raw-remove-session?revision=revision-2') {
        return new Response(JSON.stringify(removed))
      }
      if (url === '/api/sessions/dsh/raw-remove-session?revision=revision-3') {
        return new Response(JSON.stringify(reappeared))
      }
      if (url === rawUrl) {
        rawRequests++
        return response({ raw: [{ text: rawRequests === 1 ? 'old raw' : 'reappeared raw' }] })
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    openTrajectory()
    fireEvent.click(await screen.findByText('Reappearing record', { selector: '.record-main strong' }))
    fireEvent.click(await screen.findByRole('button', { name: '原始事件' }))
    expect(await screen.findByText(/old raw/, { selector: '.raw-inspector' })).toBeTruthy()

    for (const listener of listeners.get('update') ?? []) {
      listener(new MessageEvent('update'))
    }
    await waitFor(() => {
      expect(screen.queryByText('Reappearing record', { selector: '.record-main strong' }))
        .toBeNull()
    })
    for (const listener of listeners.get('update') ?? []) {
      listener(new MessageEvent('update'))
    }
    fireEvent.click(await screen.findByText('Reappearing record', { selector: '.record-main strong' }))
    fireEvent.click(await screen.findByRole('button', { name: '原始事件' }))

    expect(await screen.findByText(/reappeared raw/, { selector: '.raw-inspector' }))
      .toBeTruthy()
    expect(rawRequests).toBe(2)
  })

  it('requests and applies record deltas after a live update', async () => {
    const currentSession = summary('dsh', 'delta-session', 'Delta session')
    currentSession.capabilities = capabilities('messages', 'live')
    const first: TrajectoryRecord = {
      id: 'record-1',
      source: 'dsh',
      sourceEventIds: ['1'],
      fidelity: 'exact',
      seq: 1,
      turn: 1,
      step: 1,
      kind: 'assistant',
      title: 'First',
      summary: 'running',
      startTime: 1,
      endTime: null,
      status: 'running',
      depth: 0,
      output: [{ type: 'text', text: 'running' }],
      searchText: 'server-only search text',
    }
    const second: TrajectoryRecord = {
      ...first,
      id: 'record-2',
      sourceEventIds: ['2'],
      seq: 2,
      title: 'Second',
      summary: 'appended',
      startTime: 2,
      endTime: 3,
      status: 'complete',
      output: [{ type: 'text', text: 'appended' }],
    }
    const initial = detailWithRecord(currentSession, first)
    const listeners = new Map<string, Set<EventListener>>()
    class FakeEventSource {
      constructor(public readonly url: string) {}
      addEventListener(type: string, listener: EventListener) {
        const registered = listeners.get(type) ?? new Set<EventListener>()
        registered.add(listener)
        listeners.set(type, registered)
      }
      close() {}
    }
    const requested: string[] = []
    const { records: _records, ...projection } = initial.projection
    const { searchText: _searchText, ...transportSecond } = second
    const delta: SessionDetailDelta = {
      kind: 'delta',
      baseRevision: 'revision-2',
      revision: 'revision-3',
      summary: { ...currentSession, updatedAt: 3 },
      projection,
      upserts: [transportSecond],
      removedIds: ['record-1'],
      recordOrder: ['record-2'],
    }
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requested.push(url)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([currentSession])
      if (url === '/api/sessions/dsh/delta-session') return response(initial)
      if (url === '/api/sessions/dsh/delta-session?revision=revision-2') {
        return new Response(JSON.stringify(delta))
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    openTrajectory()
    await screen.findByText('First', { selector: '.record-main strong' })
    for (const listener of listeners.get('update') ?? []) {
      listener(new MessageEvent('update'))
    }

    expect(await screen.findByText('Second', { selector: '.record-main strong' })).toBeTruthy()
    expect(screen.queryByText('First', { selector: '.record-main strong' })).toBeNull()
    expect(requested).toContain('/api/sessions/dsh/delta-session?revision=revision-2')

    fireEvent.change(screen.getByRole('textbox', { name: '搜索轨迹记录' }), {
      target: { value: 'appended' },
    })
    expect(screen.getByText('Second', { selector: '.record-main strong' })).toBeTruthy()
  })

  it('reloads a snapshot when a delta does not match the current revision', async () => {
    const currentSession = summary('dsh', 'stale-delta-session', 'Stale delta session')
    currentSession.capabilities = capabilities('messages', 'live')
    const record = (id: string, title: string): TrajectoryRecord => ({
      id,
      source: 'dsh',
      sourceEventIds: [id],
      fidelity: 'exact',
      seq: 1,
      turn: 1,
      step: 1,
      kind: 'assistant',
      title,
      summary: title,
      startTime: 1,
      endTime: 2,
      status: 'complete',
      depth: 0,
      searchText: title.toLowerCase(),
    })
    const initial = detailWithRecord(currentSession, record('record-1', 'Initial record'))
    const recovered = detailWithRecord(
      { ...currentSession, updatedAt: 3 },
      record('record-2', 'Recovered snapshot'),
    )
    const { records: _records, ...projection } = initial.projection
    const staleDelta: SessionDetailDelta = {
      kind: 'delta',
      baseRevision: 'stale-revision',
      revision: 'revision-3',
      summary: currentSession,
      projection,
      upserts: [],
      removedIds: [],
      recordOrder: ['record-1'],
    }
    const listeners = new Map<string, Set<EventListener>>()
    class FakeEventSource {
      constructor(public readonly url: string) {}
      addEventListener(type: string, listener: EventListener) {
        const registered = listeners.get(type) ?? new Set<EventListener>()
        registered.add(listener)
        listeners.set(type, registered)
      }
      close() {}
    }
    let snapshotRequests = 0
    const requested: string[] = []
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requested.push(url)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([currentSession])
      if (url === '/api/sessions/dsh/stale-delta-session') {
        snapshotRequests++
        return response(snapshotRequests === 1 ? initial : recovered)
      }
      if (url === '/api/sessions/dsh/stale-delta-session?revision=revision-2') {
        return new Response(JSON.stringify(staleDelta))
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    openTrajectory()
    await screen.findByText('Initial record', { selector: '.record-main strong' })
    for (const listener of listeners.get('update') ?? []) {
      listener(new MessageEvent('update'))
    }

    expect(await screen.findByText('Recovered snapshot', { selector: '.record-main strong' }))
      .toBeTruthy()
    expect(snapshotRequests).toBe(2)
    expect(requested).toContain(
      '/api/sessions/dsh/stale-delta-session?revision=revision-2',
    )
  })

  it('keeps details on a transient stream error and removes a missing session', async () => {
    const currentSession = summary('dsh', 'live-session', 'Live session')
    currentSession.capabilities = capabilities('messages', 'live')
    const listeners = new Map<string, Set<EventListener>>()
    const close = vi.fn()
    class FakeEventSource {
      constructor(public readonly url: string) {}

      addEventListener(type: string, listener: EventListener) {
        const registered = listeners.get(type) ?? new Set<EventListener>()
        registered.add(listener)
        listeners.set(type, registered)
      }

      close = close
    }
    const dispatch = (type: string) => {
      for (const listener of listeners.get(type) ?? []) {
        listener(new MessageEvent(type))
      }
    }
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([currentSession])
      if (url === '/api/sessions/dsh/live-session') return response(detail(currentSession))
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    await waitForLoadedSession('dsh', 'live-session')

    dispatch('error')
    expect(await screen.findByText('实时刷新失败，正在等待自动重试')).toBeTruthy()
    expect(screen.getByRole('link', { name: '完整审计导出' })).toBeTruthy()

    dispatch('missing')
    expect(await screen.findByText('会话已被删除或不再可用')).toBeTruthy()
    expect(screen.queryByRole('link', { name: '完整审计导出' })).toBeNull()
    expect(close).toHaveBeenCalled()
  })

  it('selects and loads the next session when the current live session is missing', async () => {
    const removedSession = summary('dsh', 'removed-session', 'Removed session')
    removedSession.capabilities = capabilities('messages', 'live')
    const remainingSession = summary('dsh', 'remaining-session', 'Remaining session')
    const listeners = new Map<string, Set<EventListener>>()
    class FakeEventSource {
      constructor(public readonly url: string) {}
      addEventListener(type: string, listener: EventListener) {
        const registered = listeners.get(type) ?? new Set<EventListener>()
        registered.add(listener)
        listeners.set(type, registered)
      }
      close() {}
    }
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') {
        return response([removedSession, remainingSession])
      }
      if (url === '/api/sessions/dsh/removed-session') {
        return response(detail(removedSession))
      }
      if (url === '/api/sessions/dsh/remaining-session') {
        return response(detail(remainingSession))
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    await waitForLoadedSession('dsh', 'removed-session')
    for (const listener of listeners.get('missing') ?? []) {
      listener(new MessageEvent('missing'))
    }

    await waitForLoadedSession('dsh', 'remaining-session')
    expect((screen.getByRole('combobox', { name: '选择会话' }) as HTMLSelectElement).value)
      .toBe(sessionKey('dsh', 'remaining-session'))
  })

  it('uses the latest filtered session list when choosing a missing-session fallback', async () => {
    const removedSession = summary('dsh', 'filtered-removed', 'Filtered removed')
    removedSession.capabilities = capabilities('messages', 'live')
    const staleCandidate = summary('zcode', 'stale-candidate', 'Stale candidate')
    const remainingSession = summary('dsh', 'filtered-remaining', 'Filtered remaining')
    const listeners = new Map<string, Set<EventListener>>()
    class FakeEventSource {
      constructor(public readonly url: string) {}
      addEventListener(type: string, listener: EventListener) {
        const registered = listeners.get(type) ?? new Set<EventListener>()
        registered.add(listener)
        listeners.set(type, registered)
      }
      close() {}
    }
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') {
        return response([removedSession, staleCandidate, remainingSession])
      }
      if (url === '/api/sessions?source=dsh') {
        return response([removedSession, remainingSession])
      }
      if (url === '/api/sessions/dsh/filtered-removed') {
        return response(detail(removedSession))
      }
      if (url === '/api/sessions/dsh/filtered-remaining') {
        return response(detail(remainingSession))
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    await waitForLoadedSession('dsh', 'filtered-removed')
    await chooseSource('DSH API')
    await waitFor(() => {
      expect(screen.queryByRole('option', { name: '[ZCode API] Stale candidate' })).toBeNull()
    })

    for (const listener of listeners.get('missing') ?? []) {
      listener(new MessageEvent('missing'))
    }

    await waitForLoadedSession('dsh', 'filtered-remaining')
    expect((screen.getByRole('combobox', { name: '选择会话' }) as HTMLSelectElement).value)
      .toBe(sessionKey('dsh', 'filtered-remaining'))
  })
})

describe('App conversation view', () => {
  it('separates the durable transcript from the current model context and shows coverage gaps', async () => {
    const currentSession = summary('dsh', 'surface-session', 'Surface session')
    const original: TrajectoryRecord = {
      id: 'user:0',
      source: 'dsh',
      sourceEventIds: ['0'],
      fidelity: 'exact',
      seq: 0,
      turn: 1,
      step: 1,
      kind: 'user',
      title: '用户',
      summary: 'Original transcript message',
      startTime: 1,
      endTime: 1,
      status: 'complete',
      depth: 0,
      surface: 'shadowed',
      input: [{ type: 'text', text: 'Original transcript message' }],
      searchText: 'original transcript message',
    }
    const replacement: TrajectoryRecord = {
      id: 'user:1',
      source: 'dsh',
      sourceEventIds: ['1'],
      fidelity: 'exact',
      seq: 1,
      turn: 1,
      step: 1,
      kind: 'user',
      title: '用户',
      summary: 'Current model context message',
      startTime: 2,
      endTime: 2,
      status: 'complete',
      depth: 0,
      surface: 'current',
      input: [{ type: 'text', text: 'Current model context message' }],
      searchText: 'current model context message',
    }
    const currentDetail = detail(currentSession)
    currentDetail.projection.records = [original, replacement]
    currentDetail.projection.transcriptRecordIds = ['user:0']
    currentDetail.projection.modelContextRecordIds = ['user:1']
    currentDetail.projection.coverageSummary = {
      total: 4,
      consumed: 1,
      gap: 3,
    }
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([currentSession])
      if (url === '/api/sessions/dsh/surface-session') return response(currentDetail)
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)

    fireEvent.click(screen.getByRole('tab', { name: '对话' }))
    expect(await screen.findByText('1 / 4 已消费 · 3 gap')).toBeTruthy()
    expect(screen.getByText('Original transcript message')).toBeTruthy()
    expect(screen.queryByText('Current model context message')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: '模型上下文' }))
    expect(screen.getByText('Current model context message')).toBeTruthy()
    expect(screen.queryByText('Original transcript message')).toBeNull()
  })

  it('returns to the conversation when the selected session has no model context view', async () => {
    const dshSession = summary('dsh', 'surface-session', 'Surface session')
    const zcodeSession = summary('zcode', 'plain-session', 'Plain session')
    const dshRecord: TrajectoryRecord = {
      id: 'user:1',
      source: 'dsh',
      sourceEventIds: ['1'],
      fidelity: 'exact',
      seq: 1,
      turn: 1,
      step: 1,
      kind: 'user',
      title: '用户',
      summary: 'Current model context message',
      startTime: 1,
      endTime: 1,
      status: 'complete',
      depth: 0,
      surface: 'current',
      input: [{ type: 'text', text: 'Current model context message' }],
      searchText: 'current model context message',
    }
    const zcodeRecord: TrajectoryRecord = {
      id: 'message:user-1',
      source: 'zcode',
      sourceEventIds: ['user-1'],
      fidelity: 'exact',
      seq: 0,
      turn: 1,
      step: 0,
      kind: 'user',
      title: '用户消息',
      summary: 'ZCode conversation message',
      startTime: 2,
      endTime: 2,
      status: 'complete',
      depth: 0,
      input: [{ type: 'text', text: 'ZCode conversation message' }],
      searchText: 'zcode conversation message',
    }
    const dshDetail = detailWithRecord(dshSession, dshRecord)
    dshDetail.projection.transcriptRecordIds = []
    dshDetail.projection.modelContextRecordIds = [dshRecord.id]
    const zcodeDetail = detailWithRecord(zcodeSession, zcodeRecord)
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([dshSession, zcodeSession])
      if (url === '/api/sessions/dsh/surface-session') return response(dshDetail)
      if (url === '/api/sessions/zcode/plain-session') return response(zcodeDetail)
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)

    await screen.findByRole('tab', { name: '模型上下文' })
    fireEvent.click(screen.getByRole('tab', { name: '模型上下文' }))
    expect(screen.getByText('Current model context message')).toBeTruthy()

    fireEvent.change(screen.getByRole('combobox', { name: '选择会话' }), {
      target: { value: zcodeSession.id },
    })

    expect(await screen.findByText('ZCode conversation message')).toBeTruthy()
    expect(screen.queryByRole('tab', { name: '模型上下文' })).toBeNull()
    expect(screen.getByRole('tab', { name: '对话', selected: true })).toBeTruthy()
  })

  it('shows session statistics and offers distinct projection and audit exports', async () => {
    const currentSession = summary('zcode', 'statistics-session', 'Statistics session')
    currentSession.capabilities = capabilities('messages', 'usage')
    const currentDetail = detail(currentSession)
    currentDetail.projection.usage = {
      inputTokens: 20,
      outputTokens: 8,
      totalTokens: 30,
    }
    currentDetail.projection.turns = [
      {
        id: 'turn-1',
        number: 1,
        startTime: 1,
        endTime: 2,
        status: 'complete',
      },
      {
        id: 'turn-2',
        number: 2,
        startTime: 3,
        endTime: null,
        status: 'running',
      },
    ]
    currentDetail.projection.eventCount = 3
    currentDetail.projection.eventTypeCounts = {
      'user/message': 1,
      'assistant/message': 2,
    }
    const createObjectURL = vi.fn(() => 'blob:projection')
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    })
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([currentSession])
      if (url === '/api/sessions/zcode/statistics-session') return response(currentDetail)
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)

    const metrics = await screen.findByRole('region', { name: '轨迹核心指标' })
    expect(metrics.textContent).toContain('墙钟耗时 / 活跃耗时1 ms / —')
    expect(metrics.textContent).toContain('事件 / 记录3 / 02 种事件类型')
    expect(metrics.textContent).toContain('Token30')
    expect(metrics.textContent).toContain('输入 20 · 输出 8')
    expect(metrics.textContent).toContain('轮次 / 步骤2 / 0')
    expect(metrics.textContent).toContain('1 / 2 轮已完成')

    fireEvent.click(screen.getByRole('tab', { name: '对话' }))
    fireEvent.click(screen.getByText('2 种事件类型'))
    expect(screen.getByText('user/message')).toBeTruthy()
    expect(screen.getByText('assistant/message')).toBeTruthy()
    expect(screen.getByText('2', { selector: '.event-type-count' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '导出投影' }))
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:projection')

    const audit = screen.getByRole('link', { name: '完整审计导出' })
    expect(audit.getAttribute('href'))
      .toBe('/api/sessions/zcode/statistics-session/export')
    expect(audit.getAttribute('download')).toBe('zcode-statistics-session.audit.json')
  })

  it('shows session lineage, task state, trace context, and tool policy', async () => {
    const currentSession = summary('zcode', 'observability-session', 'Observability session')
    currentSession.capabilities = capabilities(
      'messages',
      'tools',
      'trace',
      'lineage',
      'policy',
      'tasks',
    )
    const tool: TrajectoryRecord = {
      id: 'tool:observed',
      source: 'zcode',
      sourceEventIds: ['tool-1'],
      fidelity: 'exact',
      seq: 1,
      turn: 1,
      step: 1,
      kind: 'tool',
      title: 'shell',
      summary: 'Apply the verified change',
      startTime: 1,
      endTime: 2,
      status: 'complete',
      depth: 0,
      callId: 'call-1',
      traceId: 'trace-1',
      spanId: 'span-tool-1',
      parentSpanId: 'span-model-1',
      policy: {
        sideEffectScope: 'workspace',
        readOnly: false,
        destructive: true,
        approvalStatus: 'approved',
      },
      searchText: 'shell apply the verified change',
    }
    const currentDetail = detailWithRecord(currentSession, tool)
    currentDetail.projection.header = {
      ...currentDetail.projection.header,
      parentSessionId: 'parent-session',
      origin: 'subagent',
      delegationDepth: 2,
      traceId: 'trace-1',
    }
    currentDetail.projection.taskState = {
      target: {
        id: 'goal-1',
        revision: 2,
        objective: 'Ship verified trajectory improvements',
        status: 'active',
        maxRounds: 8,
        roundsStarted: 3,
        updatedAt: 2,
      },
      todos: [
        { content: 'Inspect upstream', status: 'completed', position: 0 },
        { content: 'Implement projection', status: 'in_progress', position: 1 },
        { content: 'Verify build', status: 'pending', position: 2 },
      ],
    }
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([currentSession])
      if (url === '/api/sessions/zcode/observability-session') return response(currentDetail)
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    openTrajectory()

    expect(await screen.findByRole('region', { name: '任务状态' })).toBeTruthy()
    expect(screen.getByText('Ship verified trajectory improvements')).toBeTruthy()
    expect(screen.getByText('1 进行中 · 1 已完成 · 3 总计')).toBeTruthy()
    expect(screen.getByText('父会话 parent-session')).toBeTruthy()
    expect(screen.getByText('深度 2')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '选择 shell' }))

    const inspector = screen.getByRole('complementary', { name: '记录检查器' })
    expect(inspector.textContent).toContain('trace-1')
    expect(inspector.textContent).toContain('span-tool-1')
    expect(inspector.textContent).toContain('span-model-1')
    expect(inspector.textContent).toContain('workspace')
    expect(inspector.textContent).toContain('approved')
    expect(inspector.textContent).toContain('破坏性')
  })

  it('shows turn-level duration, token totals, and TTFT on the ledger turn row', async () => {
    const currentSession = summary('zcode', 'turn-summary-session', 'Turn summary session')
    currentSession.capabilities = capabilities('messages', 'timing', 'usage')
    const record: TrajectoryRecord = {
      id: 'message:assistant-turn-summary',
      source: 'zcode',
      sourceEventIds: ['assistant-turn-summary'],
      fidelity: 'exact',
      seq: 1,
      turn: 1,
      step: 1,
      kind: 'assistant',
      title: '助手回复',
      summary: 'Done',
      startTime: 1_800,
      endTime: 1_900,
      status: 'complete',
      depth: 0,
      output: [{ type: 'text', text: 'Done' }],
      searchText: 'done',
    }
    const currentDetail = detailWithRecord(currentSession, record)
    currentDetail.projection.turns = [{
      id: 'turn-1',
      number: 1,
      startTime: 1_000,
      endTime: 2_000,
      status: 'complete',
      usage: {
        inputTokens: 20,
        outputTokens: 8,
      },
      metrics: {
        ttftMs: 200,
      },
    }]
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([currentSession])
      if (url === '/api/sessions/zcode/turn-summary-session') return response(currentDetail)
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    openTrajectory()

    expect(await screen.findByText('1.00 s · 20→8 tok · TTFT 200 ms')).toBeTruthy()
  })

  it('defaults to summary after trajectory in the tabs and opens its evidence in trajectory', async () => {
    const currentSession = summary('zcode', 'conversation-session', 'Conversation session')
    const user: TrajectoryRecord = {
      id: 'message:user-1',
      source: 'zcode',
      sourceEventIds: ['user-1'],
      fidelity: 'exact',
      seq: 1,
      turn: 1,
      step: 0,
      kind: 'user',
      title: '用户消息',
      summary: 'Plan the migration',
      startTime: 1,
      endTime: 1,
      status: 'complete',
      depth: 0,
      input: [{ type: 'text', text: 'Plan the migration' }],
      searchText: 'plan the migration',
    }
    const assistant: TrajectoryRecord = {
      id: 'message:assistant-1',
      source: 'zcode',
      sourceEventIds: ['assistant-1'],
      fidelity: 'exact',
      seq: 2,
      turn: 1,
      step: 1,
      kind: 'assistant',
      title: '助手回复',
      summary: 'Migration complete',
      startTime: 2,
      endTime: 3,
      status: 'complete',
      depth: 0,
      output: [{ type: 'text', text: 'Migration complete' }],
      searchText: 'migration complete',
    }
    const currentDetail = detail(currentSession)
    currentDetail.projection.records = [user, assistant]
    currentDetail.projection.eventCount = 2
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([currentSession])
      if (url === '/api/sessions/zcode/conversation-session') return response(currentDetail)
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    expect(await screen.findByRole('tab', { name: '轨迹评测', selected: true })).toBeTruthy()
    expect(screen.getByRole('region', { name: '轨迹评测' })).toBeTruthy()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.findIndex(tab => tab.textContent?.includes('轨迹')))
      .toBeLessThan(tabs.findIndex(tab => tab.textContent?.includes('轨迹评测')))

    fireEvent.doubleClick(screen.getByRole('button', {
      name: /汇报阶段结果，第 1 轮，1 步/,
    }))
    fireEvent.click(await screen.findByRole('button', {
      name: '查看轨迹证据：完成模型响应',
    }))

    expect(screen.getByRole('tab', { name: '轨迹', selected: true })).toBeTruthy()
    expect(screen.getByRole('region', { name: '轨迹概览' })).toBeTruthy()
    expect(screen.getByRole('complementary', { name: '记录检查器' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '选择 助手回复' }).className).toContain('selected')

    fireEvent.click(screen.getByRole('tab', { name: '对话' }))

    expect(screen.getByRole('tab', { name: '对话', selected: true })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '轨迹概览' })).toBeNull()
    expect(screen.getByRole('region', { name: '会话内容' })).toBeTruthy()
    expect(screen.getByText('Plan the migration')).toBeTruthy()
    expect(screen.getByText('Migration complete')).toBeTruthy()
  })

  it('keeps context, reasoning, and tools collapsed until the user expands a turn', async () => {
    const currentSession = summary('zcode', 'activity-session', 'Activity session')
    const records: TrajectoryRecord[] = [
      {
        id: 'message:environment-1',
        source: 'zcode',
        sourceEventIds: ['environment-1'],
        fidelity: 'exact',
        seq: 0,
        turn: 1,
        step: 0,
        kind: 'user',
        title: '用户消息',
        summary: '<environment_context>fixture</environment_context>',
        startTime: 0,
        endTime: 0,
        status: 'complete',
        depth: 0,
        input: [{
          type: 'text',
          text: '<environment_context><cwd>/workspace/example</cwd></environment_context>',
        }],
        searchText: 'environment context workspace example',
      },
      {
        id: 'message:user-1',
        source: 'zcode',
        sourceEventIds: ['user-1'],
        fidelity: 'exact',
        seq: 1,
        turn: 1,
        step: 0,
        kind: 'user',
        title: '用户消息',
        summary: 'Start the task',
        startTime: 1,
        endTime: 1,
        status: 'complete',
        depth: 0,
        input: [{ type: 'text', text: 'Start the task' }],
        searchText: 'start the task',
      },
      {
        id: 'message:context-1',
        source: 'zcode',
        sourceEventIds: ['context-1'],
        fidelity: 'exact',
        seq: 2,
        turn: 1,
        step: 0,
        kind: 'context',
        title: '运行时上下文',
        summary: 'Runtime policy applied',
        startTime: 2,
        endTime: 2,
        status: 'complete',
        depth: 0,
        searchText: 'runtime policy applied',
      },
      {
        id: 'reasoning:1',
        source: 'zcode',
        sourceEventIds: ['reasoning-1'],
        fidelity: 'exact',
        seq: 3,
        turn: 1,
        step: 1,
        kind: 'assistant',
        title: '推理',
        summary: 'Inspect dependencies first',
        startTime: 3,
        endTime: 4,
        status: 'complete',
        depth: 0,
        output: [{ type: 'reasoning', text: 'Inspect dependencies first' }],
        searchText: 'inspect dependencies first',
      },
      {
        id: 'tool:1',
        source: 'zcode',
        sourceEventIds: ['tool-1'],
        fidelity: 'exact',
        seq: 4,
        turn: 1,
        step: 1,
        kind: 'tool',
        title: 'shell',
        summary: 'Run the test suite',
        startTime: 4,
        endTime: 5,
        status: 'complete',
        depth: 0,
        searchText: 'shell run the test suite',
      },
      {
        id: 'message:assistant-empty',
        source: 'zcode',
        sourceEventIds: ['assistant-empty'],
        fidelity: 'exact',
        seq: 5,
        turn: 1,
        step: 1,
        kind: 'assistant',
        title: '助手',
        summary: '空消息',
        startTime: 5,
        endTime: 5,
        status: 'complete',
        depth: 0,
        output: [],
        searchText: '空消息',
      },
      {
        id: 'message:assistant-1',
        source: 'zcode',
        sourceEventIds: ['assistant-1'],
        fidelity: 'exact',
        seq: 6,
        turn: 1,
        step: 1,
        kind: 'assistant',
        title: '助手回复',
        summary: 'Task complete',
        startTime: 5,
        endTime: 6,
        status: 'complete',
        depth: 0,
        output: [{ type: 'text', text: 'Task complete' }],
        searchText: 'task complete',
      },
    ]
    const currentDetail = detail(currentSession)
    currentDetail.projection.records = records
    currentDetail.projection.eventCount = records.length
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([currentSession])
      if (url === '/api/sessions/zcode/activity-session') return response(currentDetail)
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    await waitForLoadedSession('zcode', 'activity-session')
    fireEvent.click(screen.getByRole('tab', { name: '对话' }))

    const expand = screen.getByRole('button', {
      name: '展开第 1 轮执行详情（5 条）',
      expanded: false,
    })
    expect(screen.queryByText('空消息')).toBeNull()
    expect(screen.queryByText('<environment_context>fixture</environment_context>')).toBeNull()
    expect(screen.queryByText('Runtime policy applied')).toBeNull()
    expect(screen.queryByText('Inspect dependencies first')).toBeNull()
    expect(screen.queryByText('Run the test suite')).toBeNull()

    fireEvent.click(expand)

    expect(screen.getByRole('button', {
      name: '收起第 1 轮执行详情（5 条）',
      expanded: true,
    })).toBeTruthy()
    expect(screen.getByText('<environment_context>fixture</environment_context>')).toBeTruthy()
    expect(screen.getByText('Runtime policy applied')).toBeTruthy()
    expect(screen.getByText('Inspect dependencies first')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '检查 shell：Run the test suite' }))
    expect(screen.getByRole('complementary', { name: '记录检查器' })).toBeTruthy()
  })

  it('navigates from a message to the selected trajectory record', async () => {
    const currentSession = summary('zcode', 'navigation-session', 'Navigation session')
    const record: TrajectoryRecord = {
      id: 'message:user-navigation',
      source: 'zcode',
      sourceEventIds: ['user-navigation'],
      fidelity: 'exact',
      seq: 1,
      turn: 1,
      step: 0,
      kind: 'user',
      title: '用户消息',
      summary: 'Locate this message',
      startTime: 1,
      endTime: 1,
      status: 'complete',
      depth: 0,
      input: [{ type: 'text', text: 'Locate this message' }],
      searchText: 'locate this message',
    }
    const currentDetail = detailWithRecord(currentSession, record)
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([currentSession])
      if (url === '/api/sessions/zcode/navigation-session') return response(currentDetail)
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    await waitForLoadedSession('zcode', 'navigation-session')
    fireEvent.click(screen.getByRole('tab', { name: '对话' }))
    fireEvent.click(screen.getByRole('button', {
      name: '在轨迹中定位：Locate this message',
    }))

    expect(screen.getByRole('tab', { name: '轨迹', selected: true })).toBeTruthy()
    expect(screen.getByRole('complementary', { name: '记录检查器' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '选择 用户消息' }).className).toContain('selected')
  })

  it('uses the shared search box to filter conversation messages', async () => {
    const currentSession = summary('zcode', 'search-session', 'Search session')
    const records: TrajectoryRecord[] = [
      {
        id: 'message:user-alpha',
        source: 'zcode',
        sourceEventIds: ['user-alpha'],
        fidelity: 'exact',
        seq: 1,
        turn: 1,
        step: 0,
        kind: 'user',
        title: '用户消息',
        summary: 'Alpha request',
        startTime: 1,
        endTime: 1,
        status: 'complete',
        depth: 0,
        input: [{ type: 'text', text: 'Alpha request' }],
        searchText: 'alpha request',
      },
      {
        id: 'message:assistant-beta',
        source: 'zcode',
        sourceEventIds: ['assistant-beta'],
        fidelity: 'exact',
        seq: 2,
        turn: 1,
        step: 1,
        kind: 'assistant',
        title: '助手回复',
        summary: 'Beta response',
        startTime: 2,
        endTime: 3,
        status: 'complete',
        depth: 0,
        output: [{ type: 'text', text: 'Beta response' }],
        searchText: 'beta response',
      },
    ]
    const currentDetail = detail(currentSession)
    currentDetail.projection.records = records
    currentDetail.projection.eventCount = records.length
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return response(statuses)
      if (url === '/api/sessions?source=all') return response([currentSession])
      if (url === '/api/sessions/zcode/search-session') return response(currentDetail)
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<App />)
    await waitForLoadedSession('zcode', 'search-session')
    fireEvent.click(screen.getByRole('tab', { name: '对话' }))
    const search = screen.getByRole('textbox', { name: '搜索会话内容' })
    fireEvent.change(search, { target: { value: 'beta' } })

    expect(screen.queryByText('Alpha request')).toBeNull()
    expect(screen.getByText('Beta response')).toBeTruthy()
  })
})
