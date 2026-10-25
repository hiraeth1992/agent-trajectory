import { describe, expect, it } from 'vitest'
import { parseDshJsonl } from '../server/sources/dsh'
import {
  KNOWN_EVENT_TYPES,
  MESSAGE_PROJECTION_EVENT_TYPES,
  projectTrajectory,
} from '../src/projector'
import { projectedRecord, redactSensitive } from '../src/projector-utils'
import type { SessionEvent, SessionHeader } from '../src/types'

// deepseek-ai/deepseek-harness@22ddee3792402c3e70ec5f86a63c3e3e895a2f60
const UPSTREAM_PERSISTED_EVENT_TYPES = [
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/attempt',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'deliverables/presented',
  'developer/message',
  'feedback/message-delete',
  'feedback/message-put',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'image/offload',
  'job/registered',
  'job/settled',
  'llm/retry',
  'llm/retry-started',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'step/end',
  'step/start',
  'subagent/catalog',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'system/message',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/call',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'tool/result',
  'turn/end',
  'turn/start',
  'user/message',
  'web/deepseek-search-llm-request',
  'working-directory/change',
  'workspace/changes',
] as const

const header: SessionHeader = {
  type: 'session',
  version: 4,
  id: 'session-test',
  createdAt: 1_000,
  cwd: '/tmp/test',
}

function event(seq: number, time: number, type: string, data: Record<string, unknown>): SessionEvent {
  return {
    type,
    seq,
    time,
    data,
    ...([
      'system/message',
      'developer/message',
      'user/message',
      'assistant/message',
      'tool/result',
    ].includes(type)
      ? { surfaceOp: 'append' as const }
      : {}),
  }
}

describe('projectTrajectory', () => {
  it('keeps persisted and required message-projection event sets in sync with upstream', () => {
    expect([...KNOWN_EVENT_TYPES].sort()).toEqual([...UPSTREAM_PERSISTED_EVENT_TYPES].sort())
    expect([...MESSAGE_PROJECTION_EVENT_TYPES]).toEqual(['image/offload'])
    expect(KNOWN_EVENT_TYPES.has('assistant/live-chunk')).toBe(false)
  })

  it('preserves DSH session lineage in the projection header', () => {
    const projection = projectTrajectory({
      ...header,
      parentSession: 'session-parent',
      origin: 'subagent',
      delegationDepth: 2,
    }, [])

    expect(projection.header).toMatchObject({
      parentSessionId: 'session-parent',
      origin: 'subagent',
      delegationDepth: 2,
    })
  })

  it('groups one assistant request and derives persisted stream timing', () => {
    const events = [
      event(0, 1_000, 'turn/start', { turn: 1 }),
      event(1, 1_010, 'step/start', { turn: 1, step: 1 }),
      event(2, 1_020, 'user/message', {
        turn: 1,
        step: 1,
        id: 'message-1',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'hello' }],
      }),
      event(3, 1_150, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          source: { provider: 'deepseek-account', model: 'deepseek-flash' },
          content: [{ type: 'text', text: 'world' }],
        },
        usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
        stream: [
          { type: 'chunk', time: 1_025, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
          { type: 'text-chunks', time0: 1_050, index: 0, dt: [0, 40], texts: ['wor', 'ld'] },
          { type: 'chunk', time: 1_120, chunk: { type: 'finish', reason: { kind: 'stop' } } },
        ],
      }),
      event(4, 1_160, 'step/end', { turn: 1, step: 1 }),
      event(5, 1_170, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]

    const projection = projectTrajectory(header, events)
    const assistant = projection.records.find(record => record.kind === 'assistant')
    expect(assistant).toMatchObject({
      id: 'assistant:1:1',
      seq: 1,
      endSeq: 3,
      status: 'complete',
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      usage: { inputTokens: 12, outputTokens: 5 },
      metrics: { ttftMs: 40, decodeMs: 100, throughput: 50 },
    })
    expect(projection.header).toMatchObject({
      provider: 'deepseek-account',
      model: 'deepseek-flash',
    })
    expect(projection.records.find(record => record.kind === 'user')?.summary).toBe('hello')
    expect(projection.turns).toEqual([{
      id: '1',
      number: 1,
      startTime: 1_000,
      endTime: 1_170,
      status: 'complete',
      reason: { kind: 'completed' },
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      metrics: { ttftMs: 40 },
      model: 'deepseek-flash',
    }])
    expect(projection.usage).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
    })
  })

  it('pairs root tools and rebuilds nested PTC dispatch depth', () => {
    const events = [
      event(0, 1_000, 'step/start', { turn: 2, step: 3 }),
      event(1, 1_010, 'tool/call', {
        turn: 2,
        step: 3,
        callId: 'root',
        name: 'run_code',
        arguments: '{"program":"main()"}',
      }),
      event(2, 1_020, 'tool/ptc-dispatch-start', {
        rootCallId: 'root',
        parentCallId: 'root',
        subCallId: 'child',
        name: 'read',
        arguments: { path: '/tmp/a' },
      }),
      event(3, 1_030, 'tool/ptc-dispatch', {
        rootCallId: 'root',
        parentCallId: 'root',
        subCallId: 'child',
        name: 'read',
        arguments: { path: '/tmp/a' },
        isError: false,
        content: [{ type: 'text', text: 'ok' }],
      }),
      event(4, 1_050, 'tool/result', {
        turn: 2,
        step: 3,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'root' },
          content: [{ type: 'text', text: 'done' }],
          isError: false,
        },
      }),
      event(5, 1_060, 'step/end', { turn: 2, step: 3 }),
    ]

    const projection = projectTrajectory(header, events)
    expect(projection.records.find(record => record.id === 'tool:root')).toMatchObject({
      title: 'run_code',
      status: 'complete',
      input: { program: 'main()' },
      depth: 0,
    })
    expect(projection.records.find(record => record.id === 'subtool:child')).toMatchObject({
      title: 'read',
      parentCallId: 'root',
      status: 'complete',
      depth: 1,
    })
  })

  it('derives turn model and TTFT from the first assistant that records each value', () => {
    const events = [
      event(0, 1_000, 'turn/start', { turn: 1 }),
      event(1, 1_010, 'step/start', { turn: 1, step: 1 }),
      event(2, 1_020, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          source: { model: 'first-model' },
          content: [{ type: 'text', text: 'first' }],
        },
      }),
      event(3, 1_030, 'step/end', { turn: 1, step: 1 }),
      event(4, 1_040, 'step/start', { turn: 1, step: 2 }),
      event(5, 1_100, 'assistant/message', {
        turn: 1,
        step: 2,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'second' }],
        },
        stream: [
          { type: 'text-chunks', time0: 1_070, index: 0, dt: [0], texts: ['second'] },
        ],
      }),
      event(6, 1_110, 'step/end', { turn: 1, step: 2 }),
      event(7, 1_120, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]

    expect(projectTrajectory(header, events).turns[0]).toMatchObject({
      model: 'first-model',
      metrics: { ttftMs: 30 },
    })
  })

  it('aggregates usage across assistant steps and turns', () => {
    const events = [
      event(0, 1_000, 'turn/start', { turn: 1 }),
      event(1, 1_010, 'step/start', { turn: 1, step: 1 }),
      event(2, 1_020, 'assistant/message', {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      }),
      event(3, 1_030, 'step/end', { turn: 1, step: 1 }),
      event(4, 1_040, 'step/start', { turn: 1, step: 2 }),
      event(5, 1_050, 'assistant/message', {
        turn: 1,
        step: 2,
        message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      }),
      event(6, 1_060, 'step/end', { turn: 1, step: 2 }),
      event(7, 1_070, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event(8, 1_080, 'turn/start', { turn: 2 }),
      event(9, 1_090, 'step/start', { turn: 2, step: 1 }),
      event(10, 1_100, 'assistant/message', {
        turn: 2,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'third' }] },
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      }),
    ]

    const projection = projectTrajectory(header, events)
    expect(projection.turns.map(turn => turn.usage)).toEqual([
      { inputTokens: 15, outputTokens: 7, totalTokens: 22 },
      { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    ])
    expect(projection.usage).toEqual({
      inputTokens: 17,
      outputTokens: 8,
      totalTokens: 25,
    })
  })

  it('redacts sensitive tool fields from projected values and raw events', () => {
    const events = [
      event(0, 1_000, 'tool/call', {
        turn: 1,
        step: 1,
        callId: 'safe-call',
        name: 'request',
        arguments: JSON.stringify({
          url: 'https://example.test',
          authorization: 'Bearer private-token',
          password: 'plain-private-value',
        }),
      }),
      event(1, 1_010, 'tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'safe-call' },
          content: [{ type: 'json', cookie: 'session=private' }],
          isError: false,
        },
      }),
    ]
    const tool = projectTrajectory(header, events).records.find(record => record.kind === 'tool')
    expect(tool?.input).toMatchObject({ authorization: '<redacted>' })
    expect(tool?.output).toMatchObject([{ cookie: '<redacted>' }])
    expect(JSON.stringify(tool)).not.toContain('private')
  })

  it('redacts credential-shaped string contents and remains idempotent', () => {
    const bearerCredential = ['Authorization:', 'Bearer', 'bearer-private-value'].join(' ')
    const credentialUrl = ['https://', 'alice:password', '@example.test/path'].join('')
    const openAiCredential = ['sk', 'private-openai-value'].join('-')
    const githubCredential = ['ghp', 'privategithubvalue'].join('_')
    const awsCredential = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')
    const rawBearerCredential = ['Authorization:', 'Bearer', 'raw-private-value'].join(' ')
    const sensitiveValues = [
      bearerCredential,
      'dXNlcjpwYXNz',
      'split-private-token',
      'c3BsaXQ6cHJpdmF0ZQ==',
      credentialUrl,
      openAiCredential,
      githubCredential,
      awsCredential,
      rawBearerCredential,
      'cmF3OnByaXZhdGU=',
      'raw-split-private-token',
    ]
    const record = projectedRecord('codex', {
      id: 'tool:credential-test',
      sourceEventIds: ['1'],
      fidelity: 'exact',
      seq: 1,
      turn: 1,
      step: 1,
      kind: 'tool',
      title: 'exec_command',
      summary: 'credential test',
      startTime: 1,
      endTime: 2,
      status: 'complete',
      depth: 0,
      input: {
        command: [
          'curl',
          '-H',
          bearerCredential,
          '-H',
          'Authorization: Basic dXNlcjpwYXNz',
          '-H',
          'Authorization:',
          'Bearer',
          'split-private-token',
          '-H',
          'Authorization:',
          'Basic',
          'c3BsaXQ6cHJpdmF0ZQ==',
          credentialUrl,
          openAiCredential,
          githubCredential,
          awsCredential,
        ],
      },
      raw: [{
        encrypted_content: undefined,
        note: rawBearerCredential,
        basic: 'Authorization: Basic cmF3OnByaXZhdGU=',
        split: ['Authorization:', 'Bearer', 'raw-split-private-token'],
      }],
    })
    const serialized = JSON.stringify(record)

    for (const value of sensitiveValues) {
      expect(serialized).not.toContain(value)
      expect(record.searchText).not.toContain(value.toLowerCase())
    }
    expect(record.searchText).not.toContain('private')
    expect(redactSensitive(record)).toEqual(record)
  })

  it('redacts sensitive shapes formed while composing search text', () => {
    const record = projectedRecord('codex', {
      id: 'tool:search-boundary',
      sourceEventIds: ['1'],
      fidelity: 'exact',
      seq: 1,
      turn: 1,
      step: 1,
      kind: 'tool',
      title: 'authorization:',
      summary: 'boundary-private-value',
      startTime: 1,
      endTime: 2,
      status: 'complete',
      depth: 0,
    })

    expect(record.searchText).not.toContain('boundary-private-value')
    expect(redactSensitive(record)).toEqual(record)
  })

  it('redacts standalone token assignments without hiding token usage metrics', () => {
    const value = redactSensitive({
      note: 'run with token=private-token-value',
      token: 'private-object-token',
      inputTokens: 120,
      outputTokens: 30,
      tokenAllocationCoverage: 0.8,
    })

    expect(value).toEqual({
      note: 'run with token=<redacted>',
      token: '<redacted>',
      inputTokens: 120,
      outputTokens: 30,
      tokenAllocationCoverage: 0.8,
    })
  })

  it('closes an unanswered tool at the step boundary without inventing live duration', () => {
    const events = [
      event(0, 1_000, 'step/start', { turn: 1, step: 1 }),
      event(1, 1_010, 'tool/call', {
        turn: 1,
        step: 1,
        callId: 'lost',
        name: 'bash',
        arguments: '{}',
      }),
      event(2, 1_090, 'step/end', { turn: 1, step: 1 }),
    ]
    const tool = projectTrajectory(header, events).records.find(record => record.kind === 'tool')
    expect(tool).toMatchObject({
      status: 'interrupted',
      endTime: 1_090,
      error: { name: 'Interrupted', code: 'interrupted' },
    })
  })

  it('classifies injected user messages as context', () => {
    const events = [
      event(0, 1_000, 'user/message', {
        turn: 1,
        step: 1,
        id: 'context-1',
        source: { kind: 'runtime-context', plugin: 'clock' },
        content: [{ type: 'text', text: 'time snapshot' }],
      }),
    ]
    expect(projectTrajectory(header, events).records[0]).toMatchObject({
      kind: 'context',
      title: 'clock',
    })
  })

  it('omits a separate model context when no surface replacement occurred', () => {
    const appended = {
      ...event(0, 1_000, 'user/message', {
        id: 'message',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'original request' }],
      }),
      surfaceOp: 'append' as const,
    }

    const projection = projectTrajectory(header, [appended])

    expect(projection.transcriptRecordIds).toEqual(['user:0'])
    expect(projection.modelContextRecordIds).toBeUndefined()
  })

  it('separates the durable transcript from replaced model context', () => {
    const original = {
      ...event(0, 1_000, 'user/message', {
        id: 'original',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'original request' }],
      }),
      surfaceOp: 'append' as const,
    }
    const replacement = {
      ...event(1, 1_010, 'developer/message', {
        message: {
          role: 'developer',
          source: { kind: 'compaction' },
          content: [{ type: 'text', text: 'replacement context' }],
        },
      }),
      surfaceOp: { op: 'replace' as const, startSeq: 0, endSeq: 0 },
      sourceEventSeqs: [0],
    }

    const projection = projectTrajectory(header, [original, replacement])

    expect(projection.transcriptRecordIds).toEqual(['user:0'])
    expect(projection.modelContextRecordIds).toEqual(['context:1'])
    expect(projection.records.find(record => record.id === 'user:0')).toMatchObject({
      summary: 'original request',
      surface: 'shadowed',
    })
    expect(projection.records.find(record => record.id === 'context:1')).toMatchObject({
      summary: 'replacement context',
      surface: 'current',
    })
    expect(projection.relations).toEqual([
      {
        type: 'replaces',
        from: 'event:1',
        to: 'event:0',
        fidelity: 'exact',
        sourceEventIds: ['1', '0'],
      },
      {
        type: 'derived-from',
        from: 'event:1',
        to: 'event:0',
        fidelity: 'exact',
        sourceEventIds: ['1', '0'],
      },
    ])
  })

  it('projects image offloads only into the current model context', () => {
    const source = {
      ...event(0, 1_000, 'user/message', {
        id: 'images',
        source: { kind: 'user' },
        content: [
          { type: 'text', text: 'inspect these images' },
          { type: 'image', attachment: { attachmentId: 'first' } },
          { type: 'image', attachment: { attachmentId: 'second' } },
          { type: 'image', attachment: { attachmentId: 'third' } },
        ],
      }),
      surfaceOp: 'append' as const,
    }
    const offload = event(1, 1_010, 'image/offload', {
      targets: [{ seq: 0, imageIndexes: [1] }],
    })

    const projection = projectTrajectory(header, [source, offload])
    const durable = projection.records.find(record => record.id === 'user:0')

    expect(durable?.input).toEqual(source.data.content)
    expect(durable?.summary).toBe('inspect these images [image] [image] [image]')
    expect(projection.transcriptRecordIds).toEqual(['user:0'])
    expect(projection.modelContextRecordIds).toEqual(['user:0'])
    expect(projection.modelContextRecordOverrides).toEqual({
      'user:0': {
        input: [
          { type: 'text', text: 'inspect these images' },
          { type: 'image', attachment: { attachmentId: 'first' } },
          {
            type: 'image',
            attachment: { attachmentId: 'second' },
            offloaded: true,
          },
          { type: 'image', attachment: { attachmentId: 'third' } },
        ],
        summary: 'inspect these images [image] [offloaded image] [image]',
      },
    })
    expect(projection.coverage?.find(item => item.type === 'image/offload'))
      .toEqual({
        type: 'image/offload',
        total: 1,
        consumed: 1,
        disposition: 'folded-state',
      })
  })

  it('redacts sensitive fields from projected model-context overrides', () => {
    const source = {
      ...event(0, 1_000, 'user/message', {
        id: 'sensitive-image',
        source: { kind: 'user' },
        content: [{
          type: 'image',
          attachment: { attachmentId: 'first' },
          authorization: 'Bearer projected-private-token',
        }],
      }),
      surfaceOp: 'append' as const,
    }

    const projection = projectTrajectory(header, [
      source,
      event(1, 1_010, 'image/offload', {
        targets: [{ seq: 0, imageIndexes: [0] }],
      }),
    ])
    const serialized = JSON.stringify(projection.modelContextRecordOverrides)

    expect(serialized).not.toContain('projected-private-token')
    expect(projection.modelContextRecordOverrides?.['user:0']?.input).toEqual([{
      type: 'image',
      attachment: { attachmentId: 'first' },
      authorization: '<redacted>',
      offloaded: true,
    }])
  })

  it('applies consecutive image offloads to tool-result model context', () => {
    const call = event(0, 1_000, 'tool/call', {
      turn: 1,
      step: 1,
      callId: 'shot',
      name: 'read_images',
      arguments: '{}',
    })
    const result = {
      ...event(1, 1_010, 'tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'shot' },
          content: [
            { type: 'image', attachment: { attachmentId: 'first' } },
            { type: 'image', attachment: { attachmentId: 'second' } },
          ],
          isError: false,
        },
      }),
      surfaceOp: 'append' as const,
    }
    const first = event(2, 1_020, 'image/offload', {
      targets: [{ seq: 1, imageIndexes: [1] }],
    })
    const second = event(3, 1_030, 'image/offload', {
      targets: [{ seq: 1, imageIndexes: [0] }],
    })

    const projection = projectTrajectory(header, [call, result, first, second])
    const resultMessage = result.data.message as { content: unknown[] }

    expect(projection.records.find(record => record.id === 'tool:shot')?.output)
      .toEqual(resultMessage.content)
    expect(projection.modelContextRecordOverrides).toEqual({
      'tool:shot': {
        output: [
          {
            type: 'image',
            attachment: { attachmentId: 'first' },
            offloaded: true,
          },
          {
            type: 'image',
            attachment: { attachmentId: 'second' },
            offloaded: true,
          },
        ],
        summary: '{} → [offloaded image] [offloaded image]',
      },
    })
  })

  it.each([
    [{}, /data must contain a nonempty targets array/],
    [{ targets: [] }, /data must contain a nonempty targets array/],
    [{ targets: [{ seq: 0, imageIndexes: [] }] }, /nonempty imageIndexes/],
    [{ targets: [{ seq: 0, imageIndexes: [1, 0] }] }, /strictly increasing/],
    [{ targets: [{ seq: 0, imageIndexes: [0, 0] }] }, /strictly increasing/],
    [{ targets: [{ seq: 0, imageIndexes: [2] }] }, /does not exist/],
    [{
      targets: [
        { seq: 0, imageIndexes: [0] },
        { seq: 0, imageIndexes: [1] },
      ],
    }, /duplicate target seq/],
  ])('rejects malformed image offloads without partial projection: %j', (
    data,
    message,
  ) => {
    const source = {
      ...event(0, 1_000, 'user/message', {
        id: 'images',
        source: { kind: 'user' },
        content: [
          { type: 'image', attachment: { attachmentId: 'first' } },
          { type: 'image', attachment: { attachmentId: 'second' } },
        ],
      }),
      surfaceOp: 'append' as const,
    }

    expect(() => projectTrajectory(header, [
      source,
      event(1, 1_010, 'image/offload', data),
    ])).toThrow(message)
  })

  it('rejects repeated, shadowed, and assistant image offload targets', () => {
    const source = {
      ...event(0, 1_000, 'user/message', {
        id: 'images',
        source: { kind: 'user' },
        content: [{ type: 'image', attachment: { attachmentId: 'first' } }],
      }),
      surfaceOp: 'append' as const,
    }
    const first = event(1, 1_010, 'image/offload', {
      targets: [{ seq: 0, imageIndexes: [0] }],
    })
    const repeated = event(2, 1_020, 'image/offload', {
      targets: [{ seq: 0, imageIndexes: [0] }],
    })
    expect(() => projectTrajectory(header, [source, first, repeated]))
      .toThrow(/already offloaded/)

    const replacement = {
      ...event(1, 1_010, 'developer/message', {
        message: {
          role: 'developer',
          source: { kind: 'compaction' },
          content: [{ type: 'text', text: 'replacement' }],
        },
      }),
      surfaceOp: { op: 'replace' as const, startSeq: 0, endSeq: 0 },
      sourceEventSeqs: [0],
    }
    expect(() => projectTrajectory(header, [
      source,
      replacement,
      event(2, 1_020, 'image/offload', {
        targets: [{ seq: 0, imageIndexes: [0] }],
      }),
    ])).toThrow(/not a current surface node/)

    const assistant = {
      ...event(0, 1_000, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'image', attachment: { attachmentId: 'first' } }],
        },
      }),
      surfaceOp: 'append' as const,
    }
    expect(() => projectTrajectory(header, [
      assistant,
      event(1, 1_010, 'image/offload', {
        targets: [{ seq: 0, imageIndexes: [0] }],
      }),
    ])).toThrow(/must be user\/message or tool\/result/)
  })

  it('rejects duplicate source references on a surface replacement', () => {
    const original = {
      ...event(0, 1_000, 'user/message', {
        id: 'original',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'original request' }],
      }),
      surfaceOp: 'append' as const,
    }
    const replacement = {
      ...event(1, 1_010, 'developer/message', {
        message: {
          role: 'developer',
          source: { kind: 'compaction' },
          content: [{ type: 'text', text: 'replacement context' }],
        },
      }),
      surfaceOp: { op: 'replace' as const, startSeq: 0, endSeq: 0 },
      sourceEventSeqs: [0, 0],
    }

    expect(() => projectTrajectory(header, [original, replacement]))
      .toThrow(/sourceEventSeqs must not contain duplicates/)
  })

  it('preserves derived-from relations on append surface events', () => {
    const source = {
      ...event(0, 1_000, 'user/message', {
        id: 'source',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'source request' }],
      }),
      surfaceOp: 'append' as const,
    }
    const derived = {
      ...event(1, 1_010, 'developer/message', {
        message: {
          role: 'developer',
          source: { kind: 'plugin', plugin: 'context' },
          content: [{ type: 'text', text: 'derived context' }],
        },
      }),
      surfaceOp: 'append' as const,
      sourceEventSeqs: [0],
    }

    const projection = projectTrajectory(header, [source, derived])

    expect(projection.transcriptRecordIds).toEqual(['user:0', 'context:1'])
    expect(projection.modelContextRecordIds).toBeUndefined()
    expect(projection.relations).toEqual([{
      type: 'derived-from',
      from: 'event:1',
      to: 'event:0',
      fidelity: 'exact',
      sourceEventIds: ['1', '0'],
    }])
  })

  it('rejects an explicitly empty surface source list', () => {
    const appended = {
      ...event(0, 1_000, 'user/message', {
        id: 'message',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'message' }],
      }),
      surfaceOp: 'append' as const,
      sourceEventSeqs: [],
    }

    expect(() => projectTrajectory(header, [appended]))
      .toThrow(/sourceEventSeqs must not be empty/)
  })

  it('requires explicit surface markers and rejects metadata on log-only events', () => {
    const { surfaceOp: _surfaceOp, ...missingMarker } = event(
      0,
      1_000,
      'user/message',
      {
        id: 'message',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'message' }],
      },
    )
    expect(() => projectTrajectory(header, [missingMarker]))
      .toThrow(/requires a surfaceOp marker/)

    expect(() => projectTrajectory(header, [{
      ...event(0, 1_000, 'turn/start', { turn: 1 }),
      surfaceOp: 'append',
    }])).toThrow(/not surface-eligible and cannot carry surfaceOp/)
    expect(() => projectTrajectory(header, [{
      ...event(0, 1_000, 'turn/start', { turn: 1 }),
      sourceEventSeqs: [0],
    }])).toThrow(/not surface-eligible and cannot carry sourceEventSeqs/)
  })

  it('restricts tool-result replacement to one current result and content-only changes', () => {
    const original = event(0, 1_000, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'text', text: 'before' }],
        isError: false,
      },
    })
    const rewrite = {
      ...event(1, 1_010, 'tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'text', text: 'after' }],
          isError: false,
        },
      }),
      surfaceOp: { op: 'replace' as const, startSeq: 0, endSeq: 0 },
      sourceEventSeqs: [0],
    }
    expect(projectTrajectory(header, [original, rewrite]).modelContextRecordIds)
      .toEqual(['tool:call-1'])

    const user = event(0, 1_000, 'user/message', {
      id: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'before' }],
    })
    expect(() => projectTrajectory(header, [
      user,
      { ...rewrite, sourceEventSeqs: [0] },
    ])).toThrow(/must target a current tool\/result/)

    const changedIdentity = {
      ...rewrite,
      data: {
        ...rewrite.data,
        message: {
          ...(rewrite.data.message as Record<string, unknown>),
          source: { kind: 'tool', callId: 'different-call' },
        },
      },
    }
    expect(() => projectTrajectory(header, [original, changedIdentity]))
      .toThrow(/may change only content/)
  })

  it('protects the system prompt at the surface head', () => {
    const system = event(0, 1_000, 'system/message', {
      message: {
        role: 'system',
        content: [{ type: 'text', text: 'trusted system' }],
      },
    })
    const user = event(1, 1_010, 'user/message', {
      id: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'request' }],
    })
    const invalid = {
      ...event(2, 1_020, 'developer/message', {
        message: {
          role: 'developer',
          source: { kind: 'compaction' },
          content: [{ type: 'text', text: 'replacement' }],
        },
      }),
      surfaceOp: { op: 'replace' as const, startSeq: 0, endSeq: 1 },
      sourceEventSeqs: [0, 1],
    }
    expect(() => projectTrajectory(header, [system, user, invalid]))
      .toThrow(/node 0 holds the system prompt/)

    const valid = {
      ...event(1, 1_010, 'system/message', {
        message: {
          role: 'system',
          content: [{ type: 'text', text: 'updated system' }],
        },
      }),
      surfaceOp: { op: 'replace' as const, startSeq: 0, endSeq: 0 },
      sourceEventSeqs: [0],
    }
    expect(projectTrajectory(header, [system, valid]).modelContextRecordIds)
      .toEqual(['system:1'])
  })

  it('validates developer header lineage and complete tool additions', () => {
    const headerEvent = event(0, 1_000, 'request/header', {
      header: {
        tools: [{
          name: 'search',
          description: 'Search records',
          parameters: { type: 'object' },
          deferLoading: true,
        }],
      },
    })
    const addition = event(1, 1_010, 'developer/message', {
      headerSeq: 0,
      message: {
        role: 'developer',
        source: { kind: 'plugin', plugin: 'tools' },
        content: [{ type: 'tool-addition', toolName: 'search' }],
      },
    })
    expect(() => projectTrajectory(header, [headerEvent, addition])).not.toThrow()

    expect(() => projectTrajectory(header, [{
      ...addition,
      seq: 0,
      data: { ...addition.data, headerSeq: 1 },
    }])).toThrow(/must reference an earlier request\/header/)

    const missing = {
      ...addition,
      data: {
        ...addition.data,
        message: {
          ...(addition.data.message as Record<string, unknown>),
          content: [{ type: 'tool-addition', toolName: 'missing' }],
        },
      },
    }
    expect(() => projectTrajectory(header, [headerEvent, missing]))
      .toThrow(/must name exactly one tool/)

    const invalidHeader = {
      ...headerEvent,
      data: {
        header: {
          tools: [{
            name: 'search',
            description: 'Search records',
            parameters: { type: 'object' },
            deferLoading: false,
          }],
        },
      },
    }
    expect(() => projectTrajectory(header, [invalidHeader, addition]))
      .toThrow(/deferLoading must be true/)
  })

  it('deduplicates transcript record ids when one step contains multiple assistant messages', () => {
    const events = [
      {
        ...event(0, 1_000, 'assistant/message', {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'draft' }],
          },
        }),
        surfaceOp: 'append' as const,
      },
      {
        ...event(1, 1_010, 'assistant/message', {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'final' }],
          },
        }),
        surfaceOp: 'append' as const,
      },
    ]

    const projection = projectTrajectory(header, events)

    expect(projection.transcriptRecordIds).toEqual(['assistant:1:1'])
    expect(projection.modelContextRecordIds).toBeUndefined()
  })

  it('folds complete goal snapshots and clear tombstones into current task state', () => {
    const created = event(0, 1_000, 'goal/change', {
      kind: 'goal/change',
      version: 1,
      operation: 'create',
      goal: {
        id: 'goal-1',
        revision: 1,
        objective: 'Ship trajectory improvements',
        phase: 'active',
        maxGoalRounds: 5,
      },
      roundsStarted: 0,
      createdAt: 900,
      updatedAt: 1_000,
    })
    const admittedRound = event(1, 1_050, 'user/message', {
      id: 'goal-round-1',
      source: {
        kind: 'goal',
        goalId: 'goal-1',
        revision: 1,
        round: 1,
      },
      content: [{ type: 'text', text: 'continue the goal' }],
    })
    const edited = event(2, 1_100, 'goal/change', {
      kind: 'goal/change',
      version: 1,
      operation: 'edit',
      goal: {
        id: 'goal-1',
        revision: 2,
        objective: 'Ship verified trajectory improvements',
        phase: 'active',
        maxGoalRounds: 8,
      },
      roundsStarted: 1,
      createdAt: 900,
      updatedAt: 1_100,
    })
    const paused = event(3, 1_200, 'goal/change', {
      kind: 'goal/change',
      version: 1,
      operation: 'pause',
      goal: {
        id: 'goal-1',
        revision: 3,
        objective: 'Ship verified trajectory improvements',
        phase: 'paused',
        maxGoalRounds: 8,
      },
      roundsStarted: 1,
      createdAt: 900,
      updatedAt: 1_200,
    })

    expect(projectTrajectory(header, [created, admittedRound, edited, paused]).taskState).toEqual({
      target: {
        id: 'goal-1',
        revision: 3,
        objective: 'Ship verified trajectory improvements',
        status: 'paused',
        maxRounds: 8,
        roundsStarted: 1,
        updatedAt: 1_200,
      },
      todos: [],
    })

    const cleared = event(4, 1_300, 'goal/change', {
      kind: 'goal/change',
      version: 1,
      operation: 'clear',
      cleared: { id: 'goal-1', revision: 4 },
      clearedAt: 1_300,
    })
    expect(projectTrajectory(
      header,
      [created, admittedRound, edited, paused, cleared],
    ).taskState).toBeUndefined()
  })

  it('folds todo snapshots last-write-wins and clears them on the next turn', () => {
    const firstTurn = [
      event(0, 1_000, 'turn/start', { turn: 1 }),
      event(1, 1_010, 'todo/write', {
        todos: [{ content: 'Inspect upstream', status: 'in_progress' }],
      }),
      event(2, 1_020, 'todo/write', {
        todos: [
          { content: 'Inspect upstream', status: 'completed' },
          { content: 'Implement projection', status: 'in_progress' },
        ],
      }),
      event(3, 1_030, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]

    expect(projectTrajectory(header, firstTurn).taskState).toEqual({
      todos: [
        {
          content: 'Inspect upstream',
          status: 'completed',
          position: 0,
          updatedAt: 1_020,
        },
        {
          content: 'Implement projection',
          status: 'in_progress',
          position: 1,
          updatedAt: 1_020,
        },
      ],
    })

    expect(projectTrajectory(header, [
      ...firstTurn,
      event(4, 1_040, 'turn/start', { turn: 2 }),
    ]).taskState).toBeUndefined()
  })

  it('retains the last valid task snapshots when later reducer payloads are malformed', () => {
    const projection = projectTrajectory(header, [
      event(0, 1_000, 'goal/change', {
        kind: 'goal/change',
        version: 1,
        operation: 'create',
        goal: {
          id: 'goal-1',
          revision: 1,
          objective: 'Keep valid state',
          phase: 'active',
          maxGoalRounds: 5,
        },
        roundsStarted: 0,
        createdAt: 900,
        updatedAt: 1_000,
      }),
      event(1, 1_010, 'todo/write', {
        todos: [{ content: 'Keep this item', status: 'in_progress' }],
      }),
      event(2, 1_020, 'goal/change', {
        kind: 'goal/change',
        version: 1,
        operation: 'edit',
      }),
      event(3, 1_030, 'todo/write', {
        todos: [{ content: 'Malformed replacement', status: 'unknown' }],
      }),
    ])

    expect(projection.taskState).toEqual({
      target: {
        id: 'goal-1',
        revision: 1,
        objective: 'Keep valid state',
        status: 'active',
        maxRounds: 5,
        roundsStarted: 0,
        updatedAt: 1_000,
      },
      todos: [{
        content: 'Keep this item',
        status: 'in_progress',
        position: 0,
        updatedAt: 1_010,
      }],
    })
    expect(projection.coverage?.find(item => item.type === 'goal/change')).toMatchObject({
      total: 2,
      consumed: 1,
      disposition: 'folded-state',
      reason: '1 event failed semantic validation and remains audit-only',
    })
    expect(projection.coverage?.find(item => item.type === 'todo/write')).toMatchObject({
      total: 2,
      consumed: 1,
      disposition: 'folded-state',
      reason: '1 event failed semantic validation and remains audit-only',
    })
    expect(projection.coverageSummary).toEqual({
      total: 4,
      consumed: 2,
      gap: 2,
    })
  })

  it('rejects goal snapshots that violate the upstream lifecycle transition rules', () => {
    const projection = projectTrajectory(header, [
      event(0, 1_000, 'goal/change', {
        kind: 'goal/change',
        version: 1,
        operation: 'create',
        goal: {
          id: 'goal-1',
          revision: 1,
          objective: 'Keep the definition stable',
          phase: 'active',
          maxGoalRounds: 5,
        },
        roundsStarted: 0,
        createdAt: 900,
        updatedAt: 1_000,
      }),
      event(1, 1_100, 'goal/change', {
        kind: 'goal/change',
        version: 1,
        operation: 'pause',
        goal: {
          id: 'goal-1',
          revision: 2,
          objective: 'Illegally changed during pause',
          phase: 'paused',
          maxGoalRounds: 5,
        },
        roundsStarted: 0,
        createdAt: 900,
        updatedAt: 1_100,
      }),
    ])

    expect(projection.taskState?.target).toMatchObject({
      revision: 1,
      objective: 'Keep the definition stable',
      status: 'active',
    })
    expect(projection.coverage?.find(item => item.type === 'goal/change')).toMatchObject({
      total: 2,
      consumed: 1,
      reason: '1 event failed semantic validation and remains audit-only',
    })
  })

  it('freezes the goal reducer at the last valid state after its first replay failure', () => {
    const projection = projectTrajectory(header, [
      event(0, 1_000, 'goal/change', {
        kind: 'goal/change',
        version: 1,
        operation: 'create',
        goal: {
          id: 'goal-1',
          revision: 1,
          objective: 'Keep the last trusted state',
          phase: 'active',
          maxGoalRounds: 5,
        },
        roundsStarted: 0,
        createdAt: 900,
        updatedAt: 1_000,
      }),
      event(1, 1_100, 'goal/change', {
        kind: 'goal/change',
        version: 1,
        operation: 'pause',
        goal: {
          id: 'goal-1',
          revision: 3,
          objective: 'Keep the last trusted state',
          phase: 'paused',
          maxGoalRounds: 5,
        },
        roundsStarted: 0,
        createdAt: 900,
        updatedAt: 1_100,
      }),
      event(2, 1_200, 'goal/change', {
        kind: 'goal/change',
        version: 1,
        operation: 'edit',
        goal: {
          id: 'goal-1',
          revision: 2,
          objective: 'Must not be accepted after failure',
          phase: 'active',
          maxGoalRounds: 5,
        },
        roundsStarted: 0,
        createdAt: 900,
        updatedAt: 1_200,
      }),
    ])

    expect(projection.taskState?.target).toMatchObject({
      revision: 1,
      objective: 'Keep the last trusted state',
      status: 'active',
    })
    expect(projection.coverage).toEqual([{
      type: 'goal/change',
      total: 3,
      consumed: 1,
      disposition: 'folded-state',
      reason: '2 events failed semantic validation and remain audit-only',
    }])
  })

  it('keeps recorded goal-attributed messages consumed when the secondary goal fold rejects them', () => {
    const projection = projectTrajectory(header, [
      event(0, 1_000, 'user/message', {
        id: 'invalid-goal-round',
        source: {
          kind: 'goal',
          goalId: 'missing-goal',
          revision: 1,
          round: 1,
        },
        content: [{ type: 'text', text: 'still visible in the transcript' }],
      }),
    ])

    expect(projection.records[0]).toMatchObject({
      kind: 'context',
      summary: 'still visible in the transcript',
    })
    expect(projection.coverage).toEqual([{
      type: 'user/message',
      total: 1,
      consumed: 1,
      disposition: 'record',
    }])
    expect(projection.coverageSummary).toEqual({
      total: 1,
      consumed: 1,
      gap: 0,
    })
  })

  it('reports unprojected and malformed known events as projection gaps', () => {
    const projection = projectTrajectory(header, [
      event(0, 1_000, 'goal/change', {
        kind: 'goal/change',
        version: 1,
        operation: 'create',
      }),
      event(1, 1_010, 'todo/write', {
        todos: [{ content: 'implement coverage', status: 'in_progress' }],
      }),
      event(2, 1_020, 'approval/asked', {
        id: 'approval-1',
        toolName: 'bash',
      }),
      event(3, 1_030, 'user/message', {
        id: 'message-1',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'continue' }],
      }),
    ])

    expect(projection.coverage).toEqual([
      {
        type: 'approval/asked',
        total: 1,
        consumed: 0,
        disposition: 'raw-only',
        reason: 'known event is retained for audit but has no semantic projector',
      },
      {
        type: 'goal/change',
        total: 1,
        consumed: 0,
        disposition: 'folded-state',
        reason: '1 event failed semantic validation and remains audit-only',
      },
      {
        type: 'todo/write',
        total: 1,
        consumed: 1,
        disposition: 'folded-state',
      },
      {
        type: 'user/message',
        total: 1,
        consumed: 1,
        disposition: 'record',
      },
    ])
    expect(projection.coverageSummary).toEqual({
      total: 4,
      consumed: 2,
      gap: 2,
    })
  })
})

describe('parseDshJsonl', () => {
  it('accepts a contiguous v4 session', () => {
    const source = [
      JSON.stringify(header),
      JSON.stringify(event(0, 1_000, 'turn/start', { turn: 1 })),
    ].join('\n')
    expect(parseDshJsonl(source).events).toHaveLength(1)
  })

  it('rejects a sequence gap', () => {
    const source = [
      JSON.stringify(header),
      JSON.stringify(event(1, 1_000, 'turn/start', { turn: 1 })),
    ].join('\n')
    expect(() => parseDshJsonl(source)).toThrow(/expected 0, got 1/)
  })

  it('ignores a torn trailing row but rejects unknown required events', () => {
    const prefix = [
      JSON.stringify(header),
      JSON.stringify(event(0, 1_000, 'turn/start', { turn: 1 })),
    ].join('\n')
    expect(parseDshJsonl(`${prefix}\n{"type":"turn/end"`).events).toHaveLength(1)
    const unknown = `${JSON.stringify(header)}\n${JSON.stringify(event(0, 1_000, 'future/required', {}))}\n`
    expect(() => parseDshJsonl(unknown)).toThrow(/unknown required session event/)
  })

  it('rejects transient assistant live chunks in durable sessions', () => {
    const source = `${JSON.stringify(header)}\n${JSON.stringify(
      event(0, 1_000, 'assistant/live-chunk', {}),
    )}\n`

    expect(() => parseDshJsonl(source)).toThrow(/unknown required session event/)
  })
})
