import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseJsonlRows } from '../server/parsers/jsonl'
import { ProjectionWorkerClient } from '../server/projection-worker-client'
import {
  projectCodexTrajectory,
  type CodexEnvelope,
} from '../server/projectors/codex'
import {
  projectOpenCodeTrajectory,
} from '../server/projectors/opencode'
import {
  projectZcodeTrajectory,
  type ZcodeProjectionInput,
} from '../server/projectors/zcode'
import { parseDshJsonl } from '../server/sources/dsh'
import { projectTrajectory } from '../src/projector'
import { projectedRecord } from '../src/projector-utils'
import type { SessionEvent, SessionHeader } from '../src/types'

const fixturesRoot = path.resolve('tests/fixtures')
const dshFixture = readFileSync(path.join(fixturesRoot, 'dsh-session-v4.jsonl'), 'utf8')
const codexFixture = readFileSync(path.join(fixturesRoot, 'codex-rollout.jsonl'), 'utf8')
const zcodeFixture = readFileSync(path.join(fixturesRoot, 'zcode-session.json'), 'utf8')

describe('large trajectory baseline', () => {
  it('projects 70,000 visible records without spreading time arrays onto the stack', () => {
    const session = {
      id: 'large-visible-session',
      parent_id: null,
      directory: '/workspace',
      title: 'Large visible session',
      version: '1',
      model: null,
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      time_created: 1_000,
      time_updated: 100_000,
    }
    const messages = Array.from({ length: 70_000 }, (_, index) => ({
      id: `message-${index}`,
      type: index === 0 ? 'user' : 'assistant',
      seq: index,
      time_created: 1_000 + index,
      time_updated: 1_000 + index,
      data: index === 0
        ? { text: 'Start' }
        : { content: [{ type: 'text', text: 'Continue' }] },
    }))

    expect(projectOpenCodeTrajectory({ session, messages }).records)
      .toHaveLength(70_000)
  }, 10_000)

  it('parses and projects 100,000 event envelopes without complexity regression', () => {
    const header: SessionHeader = {
      type: 'session',
      version: 4,
      id: 'session-benchmark',
      createdAt: 1_000,
      cwd: '/workspace/benchmark',
    }
    const events: SessionEvent[] = Array.from({ length: 100_000 }, (_, seq) => ({
      type: 'turn/start',
      seq,
      time: 1_000 + seq,
      data: { turn: seq + 1 },
    }))
    const source = `${JSON.stringify(header)}\n${events.map(event => JSON.stringify(event)).join('\n')}\n`

    const parseStarted = performance.now()
    const parsed = parseDshJsonl(source)
    const parseDuration = performance.now() - parseStarted
    const projectStarted = performance.now()
    const projection = projectTrajectory(parsed.header, parsed.events)
    const projectDuration = performance.now() - projectStarted

    expect(parsed.events).toHaveLength(100_000)
    expect(projection.eventCount).toBe(100_000)
    expect(parseDuration).toBeLessThan(2_000)
    expect(projectDuration).toBeLessThan(3_000)
  }, 30_000)

  it('keeps parse and projection costs bounded for all three anonymous source shapes', () => {
    const iterations = 1_000
    const parseStarted = performance.now()
    for (let iteration = 0; iteration < iterations; iteration++) {
      parseDshJsonl(dshFixture)
      parseJsonlRows<CodexEnvelope>(codexFixture)
      JSON.parse(zcodeFixture)
    }
    const parseDuration = performance.now() - parseStarted

    const dsh = parseDshJsonl(dshFixture)
    const codex = parseJsonlRows<CodexEnvelope>(codexFixture).map(row => row.value)
    const zcode = JSON.parse(zcodeFixture) as ZcodeProjectionInput
    const projectStarted = performance.now()
    for (let iteration = 0; iteration < iterations; iteration++) {
      projectTrajectory(dsh.header, dsh.events)
      projectCodexTrajectory(codex)
      projectZcodeTrajectory(zcode)
    }
    const projectDuration = performance.now() - projectStarted

    expect(parseDuration).toBeLessThan(500)
    expect(projectDuration).toBeLessThan(2_000)
  }, 10_000)

  it('projects all three anonymous source shapes through the shared worker within budget', async () => {
    const dsh = parseDshJsonl(dshFixture)
    const codex = parseJsonlRows<CodexEnvelope>(codexFixture).map(row => row.value)
    const zcode = JSON.parse(zcodeFixture) as ZcodeProjectionInput
    const worker = new ProjectionWorkerClient()
    try {
      const started = performance.now()
      const projections = await Promise.all([
        worker.projectDsh('performance:dsh', dsh.header, dsh.events),
        worker.projectCodex('performance:codex', codex),
        worker.projectZcode('performance:zcode', zcode),
      ])
      const duration = performance.now() - started

      expect(projections.map(projection => projection.eventCount)).toEqual([8, 9, 6])
      expect(duration).toBeLessThan(3_000)
    } finally {
      await worker.close()
    }
  }, 10_000)

  it('measures a 10k history plus one append before deeper worker optimization', async () => {
    const header: SessionHeader = {
      type: 'session',
      version: 4,
      id: 'session-append-benchmark',
      createdAt: 1_000,
      cwd: '/workspace/benchmark',
    }
    const events: SessionEvent[] = Array.from({ length: 10_000 }, (_, seq) => ({
      type: 'turn/start',
      seq,
      time: 1_000 + seq,
      data: { turn: seq + 1 },
    }))
    const appended: SessionEvent = {
      type: 'turn/start',
      seq: events.length,
      time: 1_000 + events.length,
      data: { turn: events.length + 1 },
    }
    const worker = new ProjectionWorkerClient()
    try {
      await worker.projectDsh('performance:append', header, events)
      const started = performance.now()
      const projection = await worker.projectDsh(
        'performance:append',
        header,
        [...events, appended],
        [appended],
      )
      const duration = performance.now() - started
      const metrics = worker.metrics()

      expect(projection.eventCount).toBe(10_001)
      expect(duration).toBeLessThan(3_000)
      expect(metrics).toMatchObject({
        requests: 2,
        snapshots: 1,
        appends: 1,
        snapshotFallbacks: 0,
        payloadBytes: expect.any(Number),
        queueWaitMs: { p95: expect.any(Number) },
        roundTripMs: { p95: expect.any(Number) },
        workerExecutionMs: { p95: expect.any(Number) },
        ipcOverheadMs: { p95: expect.any(Number) },
        workerStateEntries: 1,
        workerStateBytes: expect.any(Number),
        processRssBytes: expect.any(Number),
      })
    } finally {
      await worker.close()
    }
  }, 10_000)

  it('redacts long tool outputs without a credential-scanning regression', () => {
    const privateValues = [
      'long-private-token',
      'private-password',
      'private-secret',
    ]
    const longOutput = [
      'x'.repeat(64 * 1024),
      ['https://', 'alice:private-password', '@example.test/path'].join(''),
      ['Authorization:', 'Bearer', privateValues[0]].join(' '),
      `secret=${privateValues[2]}`,
    ].join(' ')
    const started = performance.now()
    const records = Array.from({ length: 200 }, (_, index) =>
      projectedRecord('codex', {
        id: `tool:long-output:${index}`,
        sourceEventIds: [String(index)],
        fidelity: 'exact',
        seq: index,
        turn: 1,
        step: index + 1,
        kind: 'tool',
        title: 'exec_command',
        summary: 'long anonymous output',
        startTime: index,
        endTime: index + 1,
        status: 'complete',
        depth: 0,
        input: { authorization: ['Bearer', privateValues[0]].join(' ') },
        output: longOutput,
      }))
    const duration = performance.now() - started
    const serialized = JSON.stringify(records)

    privateValues.forEach(value => expect(serialized).not.toContain(value))
    expect(duration).toBeLessThan(2_000)
  }, 10_000)
})
