import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleApi, sendError, type ApiRegistry } from '../server/api'
import { projectCodexTrajectory } from '../server/projectors/codex'
import {
  capabilities,
  completeAudit,
  sessionKey,
  sourceApplicationIcons,
} from '../server/sources/types'
import type { SessionDetail, SessionSummary, SourceStatus } from '../src/types'

const summary: SessionSummary = {
  id: sessionKey('dsh', 'session-1'),
  source: 'dsh',
  sourceSessionId: 'session-1',
  format: 'session-v4',
  capabilities: capabilities('messages', 'live'),
  cwd: '/tmp',
  title: 'Session one',
  createdAt: 1,
  updatedAt: 2,
  size: 3,
}

const detail: SessionDetail = {
  summary,
  projection: {
    header: {
      source: 'dsh',
      format: 'session-v4',
      id: 'session-1',
      createdAt: 1,
    },
    records: [{
      id: 'record-1',
      source: 'dsh',
      sourceEventIds: ['0'],
      fidelity: 'exact',
      seq: 0,
      turn: 1,
      step: 1,
      kind: 'user',
      title: 'User',
      summary: 'hello',
      startTime: 1,
      endTime: 1,
      status: 'complete',
      depth: 0,
      output: 'x'.repeat(100_000),
      raw: [{ type: 'user/message', secret: '<redacted>' }],
      searchText: 'hello',
    }],
    turns: [],
    lanes: [],
    startTime: 1,
    endTime: 1,
    eventCount: 0,
    eventTypeCounts: {},
    unknownEventTypes: [],
    turnEnds: {},
  },
}

const status: SourceStatus = {
  source: 'dsh',
  availability: 'available',
  label: 'DSH',
  colorToken: 'blue',
  iconToken: 'agent',
  sessionCount: 1,
  capabilities: capabilities('messages', 'live'),
}

const servers: ReturnType<typeof createServer>[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(fulfill => {
    resolve = fulfill
  })
  return { promise, resolve }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server =>
    new Promise<void>(resolve => server.close(() => resolve()))))
})

async function start(
  registry: ApiRegistry,
): Promise<string> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (!await handleApi(request, response, url, {
        registry,
        streamIntervalMs: 10,
      })) {
        response.writeHead(404).end()
      }
    })().catch(error => sendError(response, 500, error))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function getWithHost(base: string, pathname: string, host: string): Promise<{
  status: number
  body: string
}> {
  const target = new URL(base)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: pathname,
      headers: { Host: host },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.once('error', reject)
    request.end()
  })
}

describe('multi-source API', () => {
  it('redacts sensitive session titles at the list boundary', async () => {
    const sensitive = 'list-boundary-private-value'
    const base = await start({
      listSources: async () => [status],
      listSessions: async () => [{
        ...summary,
        title: `password=${sensitive}`,
      }],
      load: async () => detail,
      fingerprint: async () => 'v1',
    })

    const body = await (await fetch(`${base}/api/sessions`)).text()

    expect(body).not.toContain(sensitive)
    expect(body).toContain('password=<redacted>')
  })

  it('routes first-batch sources through source, session-list, and detail APIs', async () => {
    const sourceIds = [
      'claude',
      'doubao-work',
      'workbuddy',
      'qoder',
      'opencode',
    ] as const
    const summaries = sourceIds.map((source): SessionSummary => ({
      ...summary,
      id: sessionKey(source, `${source}-session`),
      source,
      sourceSessionId: `${source}-session`,
      format: `${source}-fixture`,
      title: `${source} fixture`,
    }))
    const details = new Map(summaries.map(selected => [
      selected.source,
      {
        ...detail,
        summary: selected,
        projection: {
          ...detail.projection,
          header: {
            ...detail.projection.header,
            source: selected.source,
            format: selected.format,
            id: selected.sourceSessionId,
          },
          records: detail.projection.records.map(record => ({
            ...record,
            source: selected.source,
          })),
        },
      } satisfies SessionDetail,
    ]))
    const listSessions = vi.fn(async source =>
      source === 'all' || source === undefined
        ? summaries
        : summaries.filter(selected => selected.source === source))
    const load = vi.fn(async (source, sourceSessionId) => {
      const selected = details.get(source)
      return selected?.summary.sourceSessionId === sourceSessionId
        ? selected
        : undefined
    })
    const base = await start({
      listSources: async () => sourceIds.map(source => ({
        ...status,
        source,
        label: source,
        sessionCount: 1,
      })),
      listSessions,
      load,
      fingerprint: async () => 'v1',
    })

    expect(await (await fetch(`${base}/api/sources`)).json()).toMatchObject(
      sourceIds.map(source => ({ source, sessionCount: 1 })),
    )
    for (const source of sourceIds) {
      const listed = await fetch(`${base}/api/sessions?source=${source}`)
      expect(listed.status).toBe(200)
      expect(await listed.json()).toMatchObject([{
        source,
        sourceSessionId: `${source}-session`,
      }])

      const loaded = await fetch(
        `${base}/api/sessions/${source}/${source}-session`,
      )
      expect(loaded.status).toBe(200)
      expect(await loaded.json()).toMatchObject({
        kind: 'snapshot',
        detail: {
          summary: {
            source,
            sourceSessionId: `${source}-session`,
          },
          projection: { header: { source } },
        },
      })
    }
  })

  it('returns protocol status without waiting for session discovery', async () => {
    const sessions = deferred<SessionSummary[]>()
    const base = await start({
      listSources: async () => [{
        ...status,
        sessionCount: 0,
        sessionCountState: 'pending',
        protocol: {
          detected: 'dsh-session-v4',
          supported: ['dsh-session-v4'],
          fingerprint: 'dsh:session:v4',
        },
      }],
      listSessions: async () => sessions.promise,
      load: async () => detail,
      fingerprint: async () => 'v1',
    })

    const pendingList = fetch(`${base}/api/sessions?source=dsh`)
    const sources = await fetch(`${base}/api/sources`)

    expect(sources.status).toBe(200)
    expect(await sources.json()).toMatchObject([{
      source: 'dsh',
      sessionCountState: 'pending',
      protocol: {
        detected: 'dsh-session-v4',
        fingerprint: 'dsh:session:v4',
      },
    }])

    sessions.resolve([summary])
    expect(await (await pendingList).json()).toMatchObject([{
      source: 'dsh',
      sourceSessionId: 'session-1',
    }])
  })

  it('rejects API requests with a foreign Host and keeps health output path-free', async () => {
    const listSessions = vi.fn(async () => [summary])
    const base = await start({
      listSources: async () => [status],
      listSessions,
      load: async () => detail,
      fingerprint: async () => 'v1',
    })

    const foreign = await getWithHost(base, '/api/sessions', 'evil.example.com')
    expect(foreign.status).toBe(403)
    expect(listSessions).not.toHaveBeenCalled()

    const health = await fetch(`${base}/api/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })
  })

  it('exposes anonymous local cache and worker metrics', async () => {
    const base = await start({
      listSources: async () => [status],
      listSessions: async () => [summary],
      load: async () => detail,
      fingerprint: async () => 'v1',
      metrics: () => ({
        detailCache: {
          entries: 1,
          weight: 100,
          hits: 2,
          misses: 1,
          sets: 1,
          evictions: 0,
        },
        projectionWorker: {
          requests: 3,
          payloadBytes: 1234,
        },
      }),
    })

    const response = await fetch(`${base}/api/metrics`)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      registry: {
        detailCache: { entries: 1, hits: 2, misses: 1 },
        projectionWorker: { requests: 3, payloadBytes: 1234 },
      },
    })
    expect(JSON.stringify(body)).not.toContain('session-1')
    expect(JSON.stringify(body)).not.toContain('/tmp')
  })

  it('isolates source routes and rejects the removed legacy DSH detail route', async () => {
    const load = vi.fn(async (source, id) =>
      source === 'dsh' && id === 'session-1' ? detail : undefined)
    const listSessions = vi.fn(async () => [summary])
    const base = await start({
      listSources: async () => [status],
      listSessions,
      load,
      fingerprint: async () => 'v1',
    })

    const sources = await fetch(`${base}/api/sources`)
    expect(sources.status).toBe(200)
    expect(await sources.json()).toMatchObject([{ source: 'dsh', sessionCount: 1 }])

    const list = await fetch(`${base}/api/sessions?source=dsh`)
    expect(list.status).toBe(200)
    expect(listSessions).toHaveBeenCalledWith('dsh')

    const invalid = await fetch(`${base}/api/sessions?source=../../etc`)
    expect(invalid.status).toBe(400)

    const sourced = await fetch(`${base}/api/sessions/dsh/session-1`)
    expect(sourced.status).toBe(200)
    const legacy = await fetch(`${base}/api/sessions/session-1`)
    expect(legacy.status).toBe(404)
    expect(load).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledWith('dsh', 'session-1')
  })

  it('serves only whitelisted source application icons and falls back safely', async () => {
    const base = await start({
      listSources: async () => [status],
      listSessions: async () => [summary],
      load: async () => detail,
      fingerprint: async () => 'v1',
    })

    expect(sourceApplicationIcons('doubao-work', 'darwin')).toContain(
      '/Applications/DoubaoWork.app/Contents/Resources/app.icns',
    )
    expect(sourceApplicationIcons('workbuddy', 'darwin').length).toBeGreaterThan(0)
    expect(sourceApplicationIcons('qoder', 'darwin').length).toBeGreaterThan(0)

    for (const source of ['dsh', 'doubao-work', 'workbuddy', 'qoder', 'zcode'] as const) {
      const icon = await fetch(`${base}/api/sources/${source}/icon`)
      expect([200, 404]).toContain(icon.status)
      if (icon.status === 200) {
        expect(icon.headers.get('content-type')).toMatch(/^image\/(?:png|svg\+xml)$/)
        expect((await icon.arrayBuffer()).byteLength).toBeGreaterThan(0)
      }
    }

    const codexIcon = await fetch(`${base}/api/sources/codex/icon`)
    expect(codexIcon.status).toBe(404)
    const invalid = await fetch(`${base}/api/sources/not-real/icon`)
    expect(invalid.status).toBe(400)
  })

  it('returns 400 for malformed path encoding without calling a source', async () => {
    const load = vi.fn(async () => detail)
    const raw = vi.fn(async () => detail.projection.records[0]!.raw)
    const base = await start({
      listSources: async () => [status],
      listSessions: async () => [summary],
      load,
      fingerprint: async () => 'v1',
      raw,
    })

    for (const path of [
      '/api/sessions/dsh/%E0%A4%A',
      '/api/sessions/dsh/%E0%A4%A/export',
      '/api/sessions/dsh/session-1/records/%E0%A4%A/raw',
    ]) {
      const response = await fetch(`${base}${path}`)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid path encoding' })
    }
    expect(load).not.toHaveBeenCalled()
    expect(raw).not.toHaveBeenCalled()
  })

  it('publishes the selected source fingerprint over SSE', async () => {
    const fingerprint = vi.fn(async () => 'fingerprint-1')
    const base = await start({
      listSources: async () => [status],
      listSessions: async () => [summary],
      load: async () => detail,
      fingerprint,
    })
    const controller = new AbortController()
    const response = await fetch(
      `${base}/api/stream?source=dsh&session=session-1`,
      { signal: controller.signal },
    )
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    let output = ''
    for (let index = 0; index < 3 && !output.includes('event: update'); index++) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += new TextDecoder().decode(chunk.value)
    }
    controller.abort()
    expect(output).toContain('event: update')
    expect(output).toContain('fingerprint-1')
    expect(fingerprint).toHaveBeenCalledWith('dsh', 'session-1')
  })

  it('keeps raw events out of session details and loads them by record id', async () => {
    const base = await start({
      listSources: async () => [status],
      listSessions: async () => [summary],
      load: async () => detail,
      fingerprint: async () => 'v1',
      raw: async (_source, _sessionId, recordId) =>
        recordId === 'record-1' ? detail.projection.records[0]!.raw : undefined,
    })

    const detailResponse = await fetch(`${base}/api/sessions/dsh/session-1`)
    const snapshot = await detailResponse.json() as {
      kind: string
      revision: string
      detail: SessionDetail
    }
    expect(snapshot.kind).toBe('snapshot')
    expect(snapshot.revision).not.toBe('')
    expect(snapshot.detail.projection.records[0]).not.toHaveProperty('raw')
    expect(snapshot.detail.projection.records[0]).not.toHaveProperty('searchText')
    expect(snapshot.detail.projection.records[0]!.output).toMatchObject({
      truncated: true,
      originalBytes: 100_000,
    })
    expect(JSON.stringify(snapshot.detail.projection.records[0]!.output).length)
      .toBeLessThan(20_000)

    const rawResponse = await fetch(
      `${base}/api/sessions/dsh/session-1/records/record-1/raw`,
    )
    expect(rawResponse.status).toBe(200)
    expect(await rawResponse.json()).toEqual({
      raw: [{ type: 'user/message', secret: '<redacted>' }],
    })
  })

  it('redacts and bounds model-context record overrides at the detail boundary', async () => {
    const unsafeDetail = structuredClone(detail)
    unsafeDetail.projection.modelContextRecordOverrides = {
      'record-1': {
        input: {
          note: 'password=override-private-input',
          payload: 'i'.repeat(100_000),
        },
        output: {
          authorization: 'Bearer override-private-output',
          payload: 'o'.repeat(100_000),
        },
        summary: 'token=override-private-summary',
      },
    }
    const base = await start({
      listSources: async () => [status],
      listSessions: async () => [summary],
      load: async () => unsafeDetail,
      fingerprint: async () => 'v1',
    })

    const response = await fetch(`${base}/api/sessions/dsh/session-1`)
    const body = await response.text()
    const snapshot = JSON.parse(body) as {
      detail: SessionDetail
    }
    const override = snapshot.detail.projection.modelContextRecordOverrides?.['record-1']

    expect(response.status).toBe(200)
    expect(body).not.toMatch(
      /override-private-input|override-private-output|override-private-summary/,
    )
    expect(override?.input).toMatchObject({
      truncated: true,
      originalBytes: expect.any(Number),
    })
    expect(override?.output).toMatchObject({
      truncated: true,
      originalBytes: expect.any(Number),
    })
    expect(JSON.stringify(override?.input).length).toBeLessThan(20_000)
    expect(JSON.stringify(override?.output).length).toBeLessThan(20_000)
    expect(override?.summary).toBe('token=<redacted>')
  })

  it('downloads a complete redacted audit export without preview truncation', async () => {
    const base = await start({
      listSources: async () => [status],
      listSessions: async () => [summary],
      load: async () => detail,
      fingerprint: async () => 'v1',
      audit: async () => {
        const events = [{
          type: 'approval/asked',
          data: { id: 'approval-1', secret: 'private-approval' },
        }]
        return completeAudit(events, { events })
      },
    })

    const response = await fetch(`${base}/api/sessions/dsh/session-1/export`)
    const payload = await response.json() as {
      format: string
      version: number
      complete: boolean
      detail: SessionDetail
      sourceEvents: unknown[]
      audit: {
        completeness: string
        events?: unknown[]
      }
    }

    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition'))
      .toContain('dsh-session-1.audit.json')
    expect(payload).toMatchObject({
      format: 'agent-trajectory-audit',
      version: 3,
      complete: true,
      detail: {
        summary: { sourceSessionId: 'session-1' },
        projection: {
          records: [{
            id: 'record-1',
            output: 'x'.repeat(100_000),
            raw: [{ type: 'user/message', secret: '<redacted>' }],
          }],
        },
      },
      sourceEvents: [{
        type: 'approval/asked',
        data: { id: 'approval-1', secret: '<redacted>' },
      }],
      audit: {
        completeness: 'complete',
      },
    })
    expect(payload.audit).not.toHaveProperty('events')
    expect(payload.detail.projection.records[0]).not.toHaveProperty('searchText')
    expect(payload).toMatchObject({ sourceFingerprint: 'v1' })
  })

  it('rejects an audit export when the session changes during both freeze attempts', async () => {
    let version = 0
    const base = await start({
      listSources: async () => [status],
      listSessions: async () => [summary],
      load: async () => detail,
      fingerprint: async () => `v${++version}`,
      audit: async () => completeAudit([], { events: [] }),
    })

    const response = await fetch(`${base}/api/sessions/dsh/session-1/export`)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'session_changed_during_export',
    })
  })

  it('redacts credentials again at raw and audit export boundaries', async () => {
    const rawBearer = ['Authorization:', 'Bearer', 'raw-private-token'].join(' ')
    const unsafeDetail = structuredClone(detail)
    unsafeDetail.projection.records[0]!.summary =
      'Authorization: Basic c3VtbWFyeTpwcml2YXRl'
    unsafeDetail.projection.records[0]!.raw = [{
      note: rawBearer,
      split: ['Authorization:', 'Basic', 'cmF3OnByaXZhdGU='],
    }]
    const base = await start({
      listSources: async () => [status],
      listSessions: async () => [summary],
      load: async () => unsafeDetail,
      fingerprint: async () => 'v1',
      raw: async () => [{
        note: 'Authorization: Basic cmF3OnByaXZhdGU=',
        split: ['Authorization:', 'Bearer', 'raw-split-private-token'],
      }],
      audit: async () => {
        const events = [{
          type: 'raw-only',
          authorization: 'Bearer audit-private-token',
        }]
        return completeAudit(events, { events })
      },
    })

    const rawResponse = await fetch(
      `${base}/api/sessions/dsh/session-1/records/record-1/raw`,
    )
    const rawBody = await rawResponse.text()
    expect(rawResponse.status).toBe(200)
    expect(rawBody).not.toMatch(/cmF3OnByaXZhdGU|raw-split-private-token/)

    const exportResponse = await fetch(`${base}/api/sessions/dsh/session-1/export`)
    const exportBody = await exportResponse.text()
    expect(exportResponse.status).toBe(200)
    expect(exportBody).not.toMatch(
      /c3VtbWFyeTpwcml2YXRl|raw-private-token|cmF3OnByaXZhdGU|audit-private-token/,
    )
  })

  it('redacts task state at the ordinary detail transport boundary', async () => {
    const unsafeDetail = structuredClone(detail)
    unsafeDetail.projection.taskState = {
      target: {
        id: 'target-1',
        objective: 'password=synthetic-private-value',
        status: 'active',
        updatedAt: 1,
      },
      todos: [{
        content: 'secret=synthetic-private-todo',
        status: 'pending',
        position: 0,
      }],
    }
    const base = await start({
      listSources: async () => [status],
      listSessions: async () => [summary],
      load: async () => unsafeDetail,
      fingerprint: async () => 'v1',
    })

    const response = await fetch(`${base}/api/sessions/dsh/session-1`)
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).not.toContain('synthetic-private-value')
    expect(body).not.toContain('synthetic-private-todo')
    expect(body).toContain('password=<redacted>')
    expect(body).toContain('secret=<redacted>')
  })

  it('returns a redacted full-fact analysis with facts-quality gating', async () => {
    const unsafeDetail = structuredClone(detail)
    unsafeDetail.projection.unknownEventTypes = ['future/required']
    unsafeDetail.projection.taskState = {
      target: {
        id: 'target-1',
        objective: 'password=analysis-private-value',
        status: 'complete',
        updatedAt: 1,
      },
      todos: [],
    }
    const base = await start({
      listSources: async () => [status],
      listSessions: async () => [summary],
      load: async () => unsafeDetail,
      fingerprint: async () => 'v1',
    })

    const response = await fetch(`${base}/api/sessions/dsh/session-1`)
    const body = await response.json() as {
      analysis: { outcome: { label: string }; objective: string }
    }

    expect(body.analysis.outcome.label).toBe('事实质量不足')
    expect(body.analysis.objective).not.toContain('analysis-private-value')
  })

  it('does not replace all Codex criteria with insufficient facts for normal completion and telemetry events', async () => {
    const projection = projectCodexTrajectory([
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-codex' } },
      {
        type: 'response_item',
        payload: {
          type: 'message', id: 'codex-message', role: 'assistant', turn_id: 'turn-codex',
          content: [{ type: 'output_text', text: '已启动服务' }],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'item_completed', turn_id: 'turn-codex', item: { type: 'AgentMessage', id: 'codex-message' } },
      },
      {
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 12 } } },
      },
      {
        type: 'compacted',
        payload: {
          window_number: 1,
          first_window_id: 'window-first',
          previous_window_id: 'window-first',
          window_id: 'window-current',
          compaction_response_id: 'response-compaction',
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'thread_settings_applied', thread_settings: { model: 'test-model' } },
      },
      { type: 'world_state', payload: { full: true, state: { model: 'test-model' } } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-codex' } },
    ])
    const codexDetail: SessionDetail = {
      summary: {
        ...summary,
        id: 'codex:completion-session',
        source: 'codex',
        sourceSessionId: 'completion-session',
        capabilities: capabilities('messages', 'timing', 'usage'),
      },
      projection,
    }
    const base = await start({
      listSources: async () => [],
      listSessions: async () => [codexDetail.summary],
      load: async () => codexDetail,
      fingerprint: async () => 'v1',
    })
    const response = await fetch(`${base}/api/sessions/codex/completion-session`)
    const body = await response.json() as {
      analysis: { evaluations: Array<{ label: string }> }
    }

    expect(response.status).toBe(200)
    expect(body.analysis.evaluations).toHaveLength(5)
    expect(body.analysis.evaluations.every(result => result.label !== '事实质量不足')).toBe(true)
  })

  it('returns record deltas for a known revision and snapshots for stale revisions', async () => {
    let version = 'v1'
    let current = structuredClone(detail)
    current.projection.records[0]!.output = 'first'
    const base = await start({
      listSources: async () => [status],
      listSessions: async () => [summary],
      load: async () => current,
      fingerprint: async () => version,
    })

    const initialResponse = await fetch(`${base}/api/sessions/dsh/session-1`)
    const initial = await initialResponse.json() as {
      kind: 'snapshot'
      revision: string
      detail: SessionDetail
    }
    expect(initial.kind).toBe('snapshot')

    version = 'v2'
    current = structuredClone(detail)
    current.projection.records = [{
      ...current.projection.records[0]!,
      id: 'record-2',
      seq: 1,
      summary: 'appended',
      output: 'second',
    }]
    current.projection.eventCount = 1
    const deltaResponse = await fetch(
      `${base}/api/sessions/dsh/session-1?revision=${encodeURIComponent(initial.revision)}`,
    )
    const delta = await deltaResponse.json() as {
      kind: 'delta'
      baseRevision: string
      revision: string
      upserts: Array<Record<string, unknown>>
      removedIds: string[]
      recordOrder: string[]
    }
    expect(delta).toMatchObject({
      kind: 'delta',
      baseRevision: initial.revision,
      removedIds: ['record-1'],
      recordOrder: ['record-2'],
    })
    expect(delta.revision).not.toBe(initial.revision)
    expect(delta.upserts).toMatchObject([{
      id: 'record-2',
      summary: 'appended',
      output: 'second',
    }])
    expect(delta.upserts[0]).not.toHaveProperty('searchText')

    const unchangedResponse = await fetch(
      `${base}/api/sessions/dsh/session-1?revision=${encodeURIComponent(delta.revision)}`,
    )
    const unchanged = await unchangedResponse.json() as {
      kind: 'delta'
      baseRevision: string
      revision: string
      upserts: Array<Record<string, unknown>>
      removedIds: string[]
      recordOrder: string[]
    }
    expect(unchanged).toMatchObject({
      kind: 'delta',
      baseRevision: delta.revision,
      revision: delta.revision,
      upserts: [],
      removedIds: [],
      recordOrder: ['record-2'],
    })

    const staleResponse = await fetch(
      `${base}/api/sessions/dsh/session-1?revision=unknown-revision`,
    )
    const stale = await staleResponse.json() as { kind: string }
    expect(stale.kind).toBe('snapshot')
  })

  it('reuses the prepared transport when the loaded detail object is unchanged', async () => {
    const cached = structuredClone(detail)
    let outputReads = 0
    Object.defineProperty(cached.projection.records[0]!, 'output', {
      configurable: true,
      enumerable: true,
      get: () => {
        outputReads++
        return 'stable output'
      },
    })
    const base = await start({
      listSources: async () => [status],
      listSessions: async () => [summary],
      load: async () => cached,
      fingerprint: async () => 'v1',
    })

    const initialResponse = await fetch(`${base}/api/sessions/dsh/session-1`)
    const initial = await initialResponse.json() as {
      kind: 'snapshot'
      revision: string
    }
    const readsAfterSnapshot = outputReads
    expect(readsAfterSnapshot).toBeGreaterThan(0)

    const unchangedResponse = await fetch(
      `${base}/api/sessions/dsh/session-1?revision=${encodeURIComponent(initial.revision)}`,
    )
    const unchanged = await unchangedResponse.json() as {
      kind: 'delta'
      revision: string
      upserts: unknown[]
    }

    expect(unchanged).toMatchObject({
      kind: 'delta',
      revision: initial.revision,
      upserts: [],
    })
    expect(outputReads).toBe(readsAfterSnapshot)
  })

  it('serializes slow SSE fingerprint polls and stops after disconnect', async () => {
    let inFlight = 0
    let maxInFlight = 0
    let calls = 0
    const fingerprint = vi.fn(async () => {
      calls++
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(resolve => setTimeout(resolve, 40))
      inFlight--
      return `v${calls}`
    })
    const base = await start({
      listSources: async () => [status],
      listSessions: async () => [summary],
      load: async () => detail,
      fingerprint,
    })
    const controller = new AbortController()
    const stream = await fetch(
      `${base}/api/stream?source=dsh&session=session-1`,
      { signal: controller.signal },
    )
    const reader = stream.body!.getReader()
    await reader.read()
    await new Promise(resolve => setTimeout(resolve, 90))
    controller.abort()
    await reader.cancel().catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 60))
    const callsAfterClose = calls
    await new Promise(resolve => setTimeout(resolve, 60))

    expect(maxInFlight).toBe(1)
    expect(calls).toBe(callsAfterClose)
  })
})
