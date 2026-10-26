import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startAgentTrajectoryServer } from '../server/app'
import { ProjectionWorkerClient } from '../server/projection-worker-client'
import { capabilities, sessionKey } from '../server/sources/types'
import type { SourceId } from '../src/types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

function registry(worker: ProjectionWorkerClient, namespace: string) {
  return {
    listSources: async () => [],
    listSessions: async () => [],
    fingerprint: async () => 'v1',
    load: async (source: SourceId, sourceSessionId: string) => {
      const projection = await worker.projectCodex(
        `${namespace}:${sourceSessionId}`,
        [{ type: 'session_meta', payload: { id: sourceSessionId } }],
      )
      return {
        summary: {
          id: sessionKey(source, sourceSessionId),
          source,
          sourceSessionId,
          format: 'codex-rollout-jsonl',
          capabilities: capabilities('messages'),
          cwd: '/tmp',
          title: sourceSessionId,
          createdAt: 0,
          updatedAt: 0,
          size: 0,
        },
        projection,
      }
    },
  }
}

describe('server resource ownership', () => {
  it('does not close projection resources owned by another server', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-lifecycle-'))
    roots.push(root)
    const firstWorker = new ProjectionWorkerClient()
    const secondWorker = new ProjectionWorkerClient()
    const first = await startAgentTrajectoryServer({
      root,
      port: 0,
      registry: registry(firstWorker, 'first'),
      dataRoot: path.join(root, 'first'),
    })
    const second = await startAgentTrajectoryServer({
      root,
      port: 0,
      registry: registry(secondWorker, 'second'),
      dataRoot: path.join(root, 'second'),
    })
    try {
      await first.close()
      const response = await fetch(`${second.url}/api/sessions/codex/session-2`)
      expect(response.status).toBe(200)
    } finally {
      await second.close()
      await firstWorker.close()
      await secondWorker.close()
    }
  })

  it('keeps detail revision history isolated per server instance', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-lifecycle-'))
    roots.push(root)
    const makeRegistry = (title: string) => ({
      listSources: async () => [],
      listSessions: async () => [],
      fingerprint: async () => title,
      load: async (source: SourceId, sourceSessionId: string) => ({
        summary: {
          id: sessionKey(source, sourceSessionId),
          source,
          sourceSessionId,
          format: 'test',
          capabilities: capabilities('messages'),
          cwd: '/tmp',
          title,
          createdAt: 0,
          updatedAt: 0,
          size: 1,
        },
        projection: {
          header: {
            source,
            format: 'test',
            id: sourceSessionId,
            createdAt: 0,
          },
          records: [],
          turns: [],
          lanes: [],
          startTime: 0,
          endTime: 0,
          eventCount: 0,
          eventTypeCounts: {},
          unknownEventTypes: [],
          turnEnds: {},
        },
      }),
    })
    const first = await startAgentTrajectoryServer({
      root,
      port: 0,
      registry: makeRegistry('first'),
      dataRoot: path.join(root, 'first-state'),
    })
    const second = await startAgentTrajectoryServer({
      root,
      port: 0,
      registry: makeRegistry('second'),
      dataRoot: path.join(root, 'second-state'),
    })
    try {
      const firstResponse = await fetch(`${first.url}/api/sessions/codex/shared`)
      const firstSnapshot = await firstResponse.json() as {
        kind: 'snapshot'
        revision: string
      }
      const crossServer = await (
        await fetch(
          `${second.url}/api/sessions/codex/shared?revision=${
            encodeURIComponent(firstSnapshot.revision)
          }`,
        )
      ).json() as { kind: string; detail?: { summary?: { title?: string } } }

      expect(crossServer).toMatchObject({
        kind: 'snapshot',
        detail: { summary: { title: 'second' } },
      })
      await first.close()
      expect((await fetch(`${second.url}/api/sessions/codex/shared`)).status).toBe(200)
    } finally {
      await first.close()
      await second.close()
    }
  })
})
