import { describe, expect, it, vi } from 'vitest'
import { SourceRegistry } from '../../server/sources/registry'
import { capabilities, sessionKey, type SessionSource, type SourceSessionRef } from '../../server/sources/types'
import type { SessionDetail, SourceId, SourceStatus } from '../../src/types'

function fakeSource(
  id: SourceId,
  overrides: Partial<SessionSource> = {},
): SessionSource {
  const ref: SourceSessionRef = {
    source: id,
    sourceSessionId: 'local-1',
    locator: '/internal/safe-locator',
    summary: {
      id: sessionKey(id, 'local-1'),
      source: id,
      sourceSessionId: 'local-1',
      format: 'test',
      capabilities: capabilities('messages'),
      cwd: '',
      title: 'Test session',
      createdAt: 1,
      updatedAt: 2,
      size: 3,
    },
  }
  const status: SourceStatus = {
    source: id,
    availability: 'available',
    label: id,
    colorToken: 'blue',
    iconToken: 'agent',
    sessionCount: 0,
    capabilities: capabilities('messages'),
  }
  const detail: SessionDetail = {
    summary: ref.summary,
    projection: {
      header: {
        source: id,
        format: 'test',
        id: 'local-1',
        createdAt: 1,
      },
      records: [],
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
  return {
    id,
    probe: async () => status,
    list: async () => [ref],
    load: async () => detail,
    audit: async () => [],
    fingerprint: async () => 'v1',
    ...overrides,
  }
}

describe('SessionSource registry contract', () => {
  it('returns lightweight source status before session discovery', async () => {
    const list = vi.fn(async () => {
      throw new Error('slow discovery is not part of a status probe')
    })
    const registry = new SourceRegistry([
      fakeSource('codex', { list }),
    ])

    expect(await registry.listSources()).toMatchObject([{
      source: 'codex',
      availability: 'available',
      sessionCount: 0,
      sessionCountState: 'pending',
    }])
    expect(list).not.toHaveBeenCalled()
  })

  it('isolates one source list failure from healthy sources', async () => {
    const registry = new SourceRegistry([
      fakeSource('dsh'),
      fakeSource('codex', {
        list: async () => {
          throw new Error('broken source')
        },
      }),
    ])
    const statuses = await registry.listSources(true)
    expect(statuses.find(status => status.source === 'codex')).toMatchObject({
      availability: 'degraded',
      reason: 'list_failed',
    })
    expect(await registry.listSessions()).toMatchObject([
      { source: 'dsh', sourceSessionId: 'local-1' },
    ])
  })

  it('routes only opaque source ids and caches by fingerprint', async () => {
    const load = vi.fn(fakeSource('dsh').load)
    const registry = new SourceRegistry([fakeSource('dsh', { load })])
    expect(await registry.load('dsh', '/tmp/not-a-session')).toBeUndefined()
    expect(await registry.load('dsh', 'local-1')).toBeDefined()
    expect(await registry.load('dsh', 'local-1')).toBeDefined()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight load for concurrent requests to the same session', async () => {
    const base = fakeSource('dsh')
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const fingerprint = vi.fn(async () => 'v1')
    const load = vi.fn(async (ref: SourceSessionRef) => {
      await pending
      return base.load(ref)
    })
    const registry = new SourceRegistry([
      fakeSource('dsh', { fingerprint, load }),
    ])

    const requests = Array.from({ length: 10 }, () =>
      registry.load('dsh', 'local-1'))
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledTimes(1)
    })
    release()

    const details = await Promise.all(requests)
    expect(details.every(detail => detail === details[0])).toBe(true)
    expect(fingerprint).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('clears a failed in-flight load before retrying', async () => {
    const base = fakeSource('dsh')
    const failure = new Error('projection failed')
    const load = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockImplementation(base.load)
    const registry = new SourceRegistry([
      fakeSource('dsh', { load }),
    ])

    await expect(Promise.all([
      registry.load('dsh', 'local-1'),
      registry.load('dsh', 'local-1'),
    ])).rejects.toBe(failure)
    expect(await registry.load('dsh', 'local-1')).toBeDefined()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('evicts the least recently used detail when the cache limit is reached', async () => {
    const base = fakeSource('dsh')
    const [template] = await base.list()
    const refs = ['local-1', 'local-2'].map(sourceSessionId => ({
      ...template,
      sourceSessionId,
      locator: `/internal/${sourceSessionId}`,
      summary: {
        ...template.summary,
        id: sessionKey('dsh', sourceSessionId),
        sourceSessionId,
      },
    }))
    const load = vi.fn(async (ref: SourceSessionRef) => ({
      ...(await base.load(ref)),
      summary: ref.summary,
      projection: {
        ...(await base.load(ref)).projection,
        header: {
          ...(await base.load(ref)).projection.header,
          id: ref.sourceSessionId,
        },
      },
    }))
    const registry = new SourceRegistry([
      fakeSource('dsh', {
        list: async () => refs,
        load,
        fingerprint: async ref => `v:${ref.sourceSessionId}`,
      }),
    ], {
      detailCacheEntries: 1,
      detailCacheBytes: 1_000_000,
    })

    await registry.load('dsh', 'local-1')
    await registry.load('dsh', 'local-2')
    await registry.load('dsh', 'local-1')

    expect(load.mock.calls.map(([ref]) => ref.sourceSessionId))
      .toEqual(['local-1', 'local-2', 'local-1'])
  })

  it('reuses the discovered safe locator while polling one session', async () => {
    const base = fakeSource('codex')
    const list = vi.fn(base.list)
    const registry = new SourceRegistry([fakeSource('codex', { list })])

    expect(await registry.listSessions('codex')).toHaveLength(1)
    expect(await registry.fingerprint('codex', 'local-1')).toBe('v1')
    expect(await registry.fingerprint('codex', 'local-1')).toBe('v1')
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('refreshes a stale locator once when the discovered file disappears', async () => {
    const base = fakeSource('codex')
    const [original] = await base.list()
    const replacement = { ...original, locator: '/internal/replacement-locator' }
    const list = vi.fn()
      .mockResolvedValueOnce([original])
      .mockResolvedValueOnce([replacement])
    const missing = Object.assign(new Error('missing locator'), { code: 'ENOENT' })
    const fingerprint = vi.fn(async (ref: SourceSessionRef) => {
      if (ref.locator === original.locator) throw missing
      return 'v2'
    })
    const registry = new SourceRegistry([
      fakeSource('codex', { list, fingerprint }),
    ])

    expect(await registry.listSessions('codex')).toHaveLength(1)
    expect(await registry.fingerprint('codex', 'local-1')).toBe('v2')
    expect(list).toHaveBeenCalledTimes(2)
    expect(fingerprint).toHaveBeenCalledTimes(2)
  })

  it('remembers a missing session instead of rediscovering every poll', async () => {
    const base = fakeSource('codex')
    const [original] = await base.list()
    const list = vi.fn()
      .mockResolvedValueOnce([original])
      .mockResolvedValue([])
    const missing = Object.assign(new Error('missing locator'), { code: 'ENOENT' })
    const registry = new SourceRegistry([
      fakeSource('codex', {
        list,
        fingerprint: async () => {
          throw missing
        },
      }),
    ])

    expect(await registry.listSessions('codex')).toHaveLength(1)
    expect(await registry.fingerprint('codex', 'local-1')).toBeUndefined()
    expect(await registry.fingerprint('codex', 'local-1')).toBeUndefined()
    expect(await registry.fingerprint('codex', 'local-1')).toBeUndefined()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('returns a missing detail when its file disappears during loading', async () => {
    const base = fakeSource('codex')
    const [original] = await base.list()
    const list = vi.fn()
      .mockResolvedValueOnce([original])
      .mockResolvedValue([])
    const missing = Object.assign(new Error('missing locator'), { code: 'ENOENT' })
    const registry = new SourceRegistry([
      fakeSource('codex', {
        list,
        load: async () => {
          throw missing
        },
      }),
    ])

    expect(await registry.listSessions('codex')).toHaveLength(1)
    expect(await registry.load('codex', 'local-1')).toBeUndefined()
    expect(await registry.load('codex', 'local-1')).toBeUndefined()
    expect(list).toHaveBeenCalledTimes(2)
  })
})
