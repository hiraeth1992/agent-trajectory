import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DshSource, inferredDshId } from '../../server/sources/dsh'
import type { SessionEvent, SessionHeader } from '../../src/types'

describe('DSH source identity', () => {
  it('preserves the session- prefix used by the v4 header', () => {
    expect(inferredDshId('/tmp/session-123/session.v4.jsonl.zstd')).toBe('session-123')
  })

  it('reads Zstandard sessions without an external zstd executable', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-dsh-zstd-'))
    const file = path.join(root, 'session-compressed', 'session.v4.jsonl.zstd')
    const compressed = Buffer.from(
      'KLUv/QRYTQIAgsQPF4DFbYGOK1pIhodMgZkQee+DJLawjHECQcAK7WB0KsZ2dwR6jfweX8bmvOqXQskIeWwFric2I+moXo2+WtaAAgA+t2hbms8K5ok=',
      'base64',
    )
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, compressed)
    const configuredBinary = process.env.ZSTD_BIN
    delete process.env.ZSTD_BIN
    try {
      const source = new DshSource({ sessionsRoot: root })
      const [ref] = await source.list()

      expect(ref?.sourceSessionId).toBe('session-compressed')
      expect((await source.load(ref!)).projection.header.cwd).toBe('/tmp')
    } finally {
      if (configuredBinary === undefined) delete process.env.ZSTD_BIN
      else process.env.ZSTD_BIN = configuredBinary
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('loads a valid v4 session from a directory whose name is not the session id', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-dsh-identity-'))
    const sessionId = 'actual-session-id'
    const file = path.join(root, 'custom-directory', 'session.v4.jsonl')
    await fs.mkdir(path.dirname(file), { recursive: true })
    try {
      await fs.writeFile(file, `${JSON.stringify({
        type: 'session',
        version: 4,
        id: sessionId,
        createdAt: 1_000,
        cwd: '/tmp/custom',
      } satisfies SessionHeader)}\n`)

      const source = new DshSource({ sessionsRoot: root })
      const [ref] = await source.list()

      expect(ref?.sourceSessionId).toBe(sessionId)
      expect((await source.load(ref!)).projection.header.id).toBe(sessionId)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('shows the distinctive part of an unloaded session id in the fallback title', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-dsh-title-'))
    const sessionId = 'session-1234567890abcdef'
    const file = path.join(root, sessionId, 'session.v4.jsonl')
    await fs.mkdir(path.dirname(file), { recursive: true })
    try {
      await fs.writeFile(file, `${JSON.stringify({
        type: 'session',
        version: 4,
        id: sessionId,
        createdAt: 1_000,
        cwd: '',
      } satisfies SessionHeader)}\n`)

      const [ref] = await new DshSource({ sessionsRoot: root }).list()

      expect(ref?.summary.title).toBe('DSH · 1234567890ab')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('DSH source incremental loading', () => {
  it('refreshes file size and update time in the session list after an append', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-dsh-summary-'))
    const sessionId = 'session-summary'
    const file = path.join(root, sessionId, 'session.v4.jsonl')
    const header: SessionHeader = {
      type: 'session',
      version: 4,
      id: sessionId,
      createdAt: 1_000,
      cwd: '/tmp/summary',
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    try {
      await fs.writeFile(file, `${JSON.stringify(header)}\n`)
      const source = new DshSource({ sessionsRoot: root })
      const [ref] = await source.list()
      await source.load(ref!)
      await new Promise(resolve => setTimeout(resolve, 20))
      await fs.appendFile(file, `${JSON.stringify({
        type: 'turn/start',
        seq: 0,
        time: 1_100,
        data: { turn: 1 },
      } satisfies SessionEvent)}\n`)

      const stat = await fs.stat(file)
      const [updated] = await source.list()

      expect(updated?.summary.size).toBe(stat.size)
      expect(updated?.summary.updatedAt).toBe(stat.mtimeMs)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('rebuilds the least recently used session after the cache reaches its limit', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-dsh-lru-'))
    const writeSession = async (sessionId: string) => {
      const file = path.join(root, sessionId, 'session.v4.jsonl')
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, `${JSON.stringify({
        type: 'session',
        version: 4,
        id: sessionId,
        createdAt: 1_000,
        cwd: `/tmp/${sessionId}`,
      } satisfies SessionHeader)}\n`)
    }
    try {
      await writeSession('session-first')
      await writeSession('session-second')
      const source = new DshSource({ sessionsRoot: root, cacheEntries: 1 })
      const refs = await source.list()
      const first = refs.find(ref => ref.sourceSessionId === 'session-first')!
      const second = refs.find(ref => ref.sourceSessionId === 'session-second')!

      const initial = await source.load(first)
      await source.load(second)

      expect(await source.load(first)).not.toBe(initial)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('does not retain a session that exceeds the cache byte budget', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-dsh-bytes-'))
    const sessionId = 'session-oversized'
    const file = path.join(root, sessionId, 'session.v4.jsonl')
    await fs.mkdir(path.dirname(file), { recursive: true })
    try {
      await fs.writeFile(file, `${JSON.stringify({
        type: 'session',
        version: 4,
        id: sessionId,
        createdAt: 1_000,
        cwd: '/tmp/oversized',
      } satisfies SessionHeader)}\n`)
      const source = new DshSource({
        sessionsRoot: root,
        cacheEntries: 8,
        cacheBytes: 1,
      })
      const [ref] = await source.list()

      const initial = await source.load(ref!)

      expect(await source.load(ref!)).not.toBe(initial)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('keeps prior events and projects newly appended plain JSONL rows', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-dsh-'))
    const sessionId = 'session-incremental'
    const file = path.join(root, sessionId, 'session.v4.jsonl')
    const header: SessionHeader = {
      type: 'session',
      version: 4,
      id: sessionId,
      createdAt: 1_000,
      cwd: '/tmp/work',
    }
    const user: SessionEvent = {
      type: 'user/message',
      seq: 0,
      time: 1_100,
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'first' }],
      },
    }
    const assistant: SessionEvent = {
      type: 'assistant/message',
      seq: 1,
      time: 1_200,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'second' }],
        },
      },
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    try {
      await fs.writeFile(file, `${JSON.stringify(header)}\n${JSON.stringify(user)}\n`)
      const source = new DshSource({ sessionsRoot: root })
      const [ref] = await source.list()
      expect((await source.load(ref!)).projection.eventCount).toBe(1)

      await fs.appendFile(file, `${JSON.stringify(assistant)}\n`)

      const detail = await source.load(ref!)
      expect(detail.projection.eventCount).toBe(2)
      expect(detail.projection.records.map(record => record.summary)).toEqual(['first', 'second'])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('recovers when a plain JSONL session is rewritten with longer content', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-dsh-rewrite-'))
    const sessionId = 'session-rewritten'
    const file = path.join(root, sessionId, 'session.v4.jsonl')
    const header = (cwd: string): SessionHeader => ({
      type: 'session',
      version: 4,
      id: sessionId,
      createdAt: 1_000,
      cwd,
    })
    const message = (seq: number, text: string): SessionEvent => ({
      type: 'user/message',
      seq,
      time: 1_100 + seq,
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text }],
      },
    })
    await fs.mkdir(path.dirname(file), { recursive: true })
    try {
      await fs.writeFile(file, [
        header('/tmp/old'),
        message(0, 'old'),
      ].map(value => JSON.stringify(value)).join('\n') + '\n')
      const source = new DshSource({ sessionsRoot: root })
      const [ref] = await source.list()
      expect((await source.load(ref!)).projection.records.map(record => record.summary))
        .toEqual(['old'])

      await fs.writeFile(file, [
        header('/tmp/a-much-longer-rewritten-directory'),
        message(0, 'rewritten content replaces the old session'),
        message(1, 'new trailing message'),
      ].map(value => JSON.stringify(value)).join('\n') + '\n')

      expect((await source.load(ref!)).projection.records.map(record => record.summary))
        .toEqual(['rewritten content replaces the old session', 'new trailing message'])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
