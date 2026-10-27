import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { ProjectionWorkerClient } from '../server/projection-worker-client'
import { projectTrajectory } from '../src/projector'
import type { SessionEvent, SessionHeader } from '../src/types'

const header: SessionHeader = {
  type: 'session',
  version: 4,
  id: 'session-worker',
  createdAt: 1_000,
  cwd: '/tmp/worker',
}

function message(seq: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 1_000 + seq,
    surfaceOp: 'append',
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    },
  }
}

describe('projection worker', () => {
  it('bounds pending requests and times out an unresponsive worker', async () => {
    class SilentWorker extends EventEmitter {
      postMessage() {}
      ref() {}
      unref() {}
      async terminate() { return 0 }
    }
    const worker = new ProjectionWorkerClient(
      () => new SilentWorker() as unknown as Worker,
      { maxPending: 1, requestTimeoutMs: 20 },
    )
    try {
      const first = worker.projectDsh('dsh:timeout', header, [])
      await expect(worker.projectDsh('dsh:overflow', header, []))
        .rejects.toThrow(/queue is full/)
      await expect(first).rejects.toThrow(/timed out/)
      expect(worker.metrics()).toMatchObject({ pending: 0, maxPending: 1 })
    } finally {
      await worker.close()
    }
  })

  it('reuses one worker and yields the main event loop during projection', async () => {
    let workerCreations = 0
    const worker = new ProjectionWorkerClient((filename, options) => {
      workerCreations++
      return new Worker(filename, options)
    })
    try {
      const events = Array.from({ length: 400 }, (_, seq) =>
        message(seq, `event ${seq} ${'x'.repeat(8 * 1024)}`))
      let mainLoopYielded = false
      const projection = worker.projectDsh('dsh:large-worker-session', header, events)
      await new Promise<void>(resolve => setImmediate(() => {
        mainLoopYielded = true
        resolve()
      }))

      expect(mainLoopYielded).toBe(true)
      expect((await projection).eventCount).toBe(events.length)
      await worker.projectDsh('dsh:second-worker-session', {
        ...header,
        id: 'second-worker-session',
      }, [])
      expect(workerCreations).toBe(1)
    } finally {
      await worker.close()
    }
  })

  it('projects DSH appends to the same result as a complete projection', async () => {
    const worker = new ProjectionWorkerClient()
    try {
      const first = message(0, 'first')
      const second = message(1, 'second')

      await worker.projectDsh('dsh:session-worker', header, [first])
      const incremental = await worker.projectDsh(
        'dsh:session-worker',
        header,
        [first, second],
        [second],
      )

      expect(incremental).toEqual(projectTrajectory(header, [first, second]))
      expect(worker.metrics()).toMatchObject({
        requests: 2,
        snapshots: 1,
        appends: 1,
        snapshotFallbacks: 0,
        payloadBytes: expect.any(Number),
        pending: 0,
        maxPending: 1,
        roundTripMs: {
          p50: expect.any(Number),
          p95: expect.any(Number),
        },
        queueWaitMs: {
          p50: expect.any(Number),
          p95: expect.any(Number),
        },
        ipcOverheadMs: {
          p50: expect.any(Number),
          p95: expect.any(Number),
        },
        workerStateEntries: 1,
        workerStateBytes: expect.any(Number),
        processRssBytes: expect.any(Number),
      })
    } finally {
      await worker.close()
    }
  })

  it('does not reuse stale record content after a complete snapshot rewrite', async () => {
    const worker = new ProjectionWorkerClient()
    try {
      const sharedPrefix = 'x'.repeat(220)
      const first = message(0, `${sharedPrefix} first-tail`)
      const rewritten = message(0, `${sharedPrefix} rewritten-tail`)

      const initial = await worker.projectDsh(
        'dsh:rewritten-worker-session',
        header,
        [first],
      )
      const refreshed = await worker.projectDsh(
        'dsh:rewritten-worker-session',
        header,
        [rewritten],
      )

      expect(initial.records[0]?.input).toEqual([{
        type: 'text',
        text: `${sharedPrefix} first-tail`,
      }])
      expect(refreshed.records[0]?.input).toEqual([{
        type: 'text',
        text: `${sharedPrefix} rewritten-tail`,
      }])
    } finally {
      await worker.close()
    }
  })
})
