import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  handleApi,
  sendError,
  type ApiRegistry,
} from '../server/api'
import { DiagnosisEvidenceStore } from '../server/diagnosis/evidence-store'
import { TrajectoryDiagnosisService } from '../server/diagnosis/service'
import { capabilities, sessionKey } from '../server/sources/types'
import type { SessionDetail, SourceStatus } from '../src/types'

const servers: ReturnType<typeof createServer>[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server =>
    new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

async function start(
  registry: ApiRegistry,
  diagnosis: TrajectoryDiagnosisService,
): Promise<string> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (!await handleApi(request, response, url, { registry, diagnosis })) {
        response.writeHead(404).end()
      }
    })().catch(error => sendError(response, 500, error))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

function detail(source: 'codex' | 'zcode' | 'dsh' = 'codex'): SessionDetail {
  return {
    summary: {
      id: sessionKey(source, 'source-thread'),
      source,
      sourceSessionId: 'source-thread',
      format: 'test',
      capabilities: capabilities('messages', 'tools'),
      cwd: '/Users/test/project',
      title: 'Source thread',
      createdAt: 1_000,
      updatedAt: 2_000,
      size: 1,
    },
    projection: {
      header: {
        source,
        format: 'test',
        id: 'source-thread',
        createdAt: 1_000,
      },
      records: [{
        id: 'user-1',
        source,
        sourceEventIds: ['event-1'],
        fidelity: 'exact',
        seq: 1,
        turn: 1,
        step: 0,
        kind: 'user',
        title: '用户',
        summary: '检查实现',
        input: '检查实现',
        startTime: 1_000,
        endTime: 1_000,
        status: 'complete',
        depth: 0,
        searchText: '检查实现',
      }],
      turns: [{
        id: 'turn-1',
        number: 1,
        startTime: 1_000,
        endTime: 2_000,
        status: 'complete',
      }],
      lanes: [],
      startTime: 1_000,
      endTime: 2_000,
      eventCount: 1,
      eventTypeCounts: { user: 1 },
      unknownEventTypes: [],
      turnEnds: { 1: { time: 2_000, reason: 'complete' } },
    },
  }
}

async function fixture(registry: ApiRegistry): Promise<{
  base: string
  evidenceDirectory: string
}> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-diagnosis-api-'))
  roots.push(root)
  const evidenceDirectory = path.join(root, 'snapshots')
  const diagnosis = new TrajectoryDiagnosisService(
    registry,
    new DiagnosisEvidenceStore(evidenceDirectory),
    '/Users/test/app/lib/diagnosis-evidence.mjs',
    '/Users/test/app/skills/trajectory-diagnosis/SKILL.md',
  )
  return {
    base: await start(registry, diagnosis),
    evidenceDirectory,
  }
}

function registry(
  targetSource: 'codex' | 'zcode' | 'dsh' = 'codex',
): ApiRegistry {
  return {
    listSources: async (): Promise<SourceStatus[]> => [],
    listSessions: vi.fn(async () => []),
    load: vi.fn(async () => detail(targetSource)),
    fingerprint: vi.fn(async () => 'source-version-1'),
  }
}

describe('trajectory diagnosis prompt API', () => {
  it.each(['codex', 'zcode', 'dsh'] as const)(
    'prepares a frozen prompt for a %s trajectory without creating a session',
    async (targetSource) => {
      const source = registry(targetSource)
      const { base, evidenceDirectory } = await fixture(source)

      const response = await fetch(`${base}/api/diagnosis/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: { source: targetSource, sessionId: 'source-thread' },
        }),
      })

      expect(response.status).toBe(201)
      const body = await response.json() as Record<string, unknown>
      expect(body).toMatchObject({
        status: 'prepared',
        protocol: 'trajectory-diagnosis-v1',
        snapshotId: expect.any(String),
        prompt: expect.any(String),
      })
      expect(body).not.toHaveProperty('host')
      expect(body).not.toHaveProperty('sessionId')
      expect(body).not.toHaveProperty('turnId')
      expect(body).not.toHaveProperty('deepLink')
      expect(String(body.prompt)).toContain(`"source":"${targetSource}"`)
      expect(String(body.prompt)).toContain('"session_id":"source-thread"')
      expect(String(body.prompt)).toContain(
        '"evidence_command":"/Users/test/app/lib/diagnosis-evidence.mjs"',
      )
      expect(String(body.prompt)).toContain(`"evidence_root":"${evidenceDirectory}"`)
      expect(String(body.prompt)).toContain('$trajectory-diagnosis')
      expect(String(body.prompt)).toContain(
        'skill_path: "/Users/test/app/skills/trajectory-diagnosis/SKILL.md"',
      )
      expect(String(body.prompt)).not.toContain('【最终目标】')
      expect(String(body.prompt).length).toBeLessThan(700)
      expect(source.load).toHaveBeenCalledWith(targetSource, 'source-thread')
      expect(source.fingerprint).toHaveBeenCalledTimes(2)
    },
  )

  it('does not expose the removed session-starting endpoint', async () => {
    const source = registry()
    const { base } = await fixture(source)

    const response = await fetch(`${base}/api/diagnosis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: { source: 'codex', sessionId: 'source-thread' },
      }),
    })

    expect(response.status).toBe(404)
    expect(source.load).not.toHaveBeenCalled()
  })

  it('ignores a legacy initiator and prepares only the requested target', async () => {
    const source = registry('codex')
    const { base } = await fixture(source)

    const response = await fetch(`${base}/api/diagnosis/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initiator: 'zcode',
        target: { source: 'codex', sessionId: 'source-thread' },
      }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      status: 'prepared',
      protocol: 'trajectory-diagnosis-v1',
    })
    expect(source.load).toHaveBeenCalledWith('codex', 'source-thread')
  })

  it('rejects an invalid target before reading the source session', async () => {
    const source = registry()
    const { base } = await fixture(source)

    const response = await fetch(`${base}/api/diagnosis/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: { source: 'unknown', sessionId: 'source-thread' },
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid diagnosis request' })
    expect(source.load).not.toHaveBeenCalled()
  })

  it('does not prepare a prompt when the source changes throughout freezing', async () => {
    const source = registry()
    source.fingerprint = vi.fn()
      .mockResolvedValueOnce('version-1')
      .mockResolvedValueOnce('version-2')
      .mockResolvedValueOnce('version-3')
      .mockResolvedValueOnce('version-4')
    const { base, evidenceDirectory } = await fixture(source)

    const response = await fetch(`${base}/api/diagnosis/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: { source: 'codex', sessionId: 'source-thread' },
      }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'diagnosis target changed while freezing evidence; retry when the session is idle',
    })
    expect(source.load).toHaveBeenCalledTimes(2)
    await expect(fs.readdir(evidenceDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
