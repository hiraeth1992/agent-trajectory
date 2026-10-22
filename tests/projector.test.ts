import { describe, expect, it } from 'vitest'
import { parseDshJsonl } from '../server/sources/dsh'
import { projectTrajectory } from '../src/projector'
import { projectedRecord, redactSensitive } from '../src/projector-utils'
import type { SessionEvent, SessionHeader } from '../src/types'

const header: SessionHeader = {
  type: 'session',
  version: 4,
  id: 'session-test',
  createdAt: 1_000,
  cwd: '/tmp/test',
}

function event(seq: number, time: number, type: string, data: Record<string, unknown>): SessionEvent {
  return { type, seq, time, data }
}

describe('projectTrajectory', () => {
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

    expect(projection.modelContextRecordIds).toEqual(['user:0', 'context:1'])
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

  it('deduplicates surface record ids when one step contains multiple assistant messages', () => {
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
    expect(projection.modelContextRecordIds).toEqual(['assistant:1:1'])
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
})
