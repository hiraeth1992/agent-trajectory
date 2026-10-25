import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startAgentTrajectoryServer } from '../server/app'
import { ProjectionWorkerClient } from '../server/projection-worker-client'
import { capabilities, sessionKey } from '../server/sources/types'
import { MemorySummarySecretStore } from '../server/summary/types'
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
      summaryDataRoot: path.join(root, 'first'),
      summarySecretStore: new MemorySummarySecretStore(),
    })
    const second = await startAgentTrajectoryServer({
      root,
      port: 0,
      registry: registry(secondWorker, 'second'),
      summaryDataRoot: path.join(root, 'second'),
      summarySecretStore: new MemorySummarySecretStore(),
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
})
