import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseJsonlRows, readJsonlRowsFrom } from '../../server/parsers/jsonl'
import { projectCodexTrajectory, type CodexEnvelope } from '../../server/projectors/codex'
import { CodexSource } from '../../server/sources/codex'

function row(
  ordinal: number,
  type: string,
  payload: Record<string, unknown>,
  timestamp = '2026-01-01T00:00:01.000Z',
): CodexEnvelope {
  return { ordinal, type, payload, timestamp }
}

describe('Codex JSONL parser', () => {
  it('ignores only a torn final row', () => {
    const source = `${JSON.stringify(row(0, 'session_meta', { id: 'session-1' }))}\n{"ordinal":1`
    expect(parseJsonlRows<CodexEnvelope>(source)).toHaveLength(1)
  })

  it('rejects malformed complete rows', () => {
    const source = `${JSON.stringify(row(0, 'session_meta', { id: 'session-1' }))}\n{broken}\n`
    expect(() => parseJsonlRows(source)).toThrow(/line 2/)
  })

  it('resumes at the last complete byte without losing a torn appended row', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-codex-'))
    const file = path.join(root, 'rollout-session.jsonl')
    try {
      const first = JSON.stringify(row(0, 'session_meta', { id: 'session-1' }))
      const second = JSON.stringify(row(1, 'event_msg', { type: 'task_started' }))
      const third = JSON.stringify(row(2, 'event_msg', { type: 'task_complete' }))
      await fs.writeFile(file, `${first}\n${second.slice(0, 20)}`)

      const initial = await readJsonlRowsFrom<CodexEnvelope>(file)
      expect(initial.rows.map(entry => entry.value.ordinal)).toEqual([0])
      expect(initial.nextOffset).toBe(Buffer.byteLength(`${first}\n`))

      await fs.appendFile(file, `${second.slice(20)}\n${third}\n`)
      const appended = await readJsonlRowsFrom<CodexEnvelope>(
        file,
        initial.nextOffset,
        initial.nextLine,
      )
      expect(appended.rows.map(entry => entry.value.ordinal)).toEqual([1, 2])
      expect(appended.rows.map(entry => entry.line)).toEqual([2, 3])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('advances past a valid final row without a newline and skips its later terminator', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-codex-tail-'))
    const file = path.join(root, 'rollout-session.jsonl')
    try {
      const first = JSON.stringify(row(0, 'session_meta', { id: 'session-1' }))
      const second = JSON.stringify(row(1, 'event_msg', { type: 'task_complete' }))
      await fs.writeFile(file, first)

      const initial = await readJsonlRowsFrom<CodexEnvelope>(file)
      expect(initial.rows.map(entry => entry.value.ordinal)).toEqual([0])
      expect(initial.nextOffset).toBe(Buffer.byteLength(first))
      expect(initial.nextLine).toBe(2)

      await fs.appendFile(file, `\n${second}\n`)
      const appended = await readJsonlRowsFrom<CodexEnvelope>(
        file,
        initial.nextOffset,
        initial.nextLine,
      )
      expect(appended.rows.map(entry => entry.value.ordinal)).toEqual([1])
      expect(appended.rows.map(entry => entry.line)).toEqual([2])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('Codex projector', () => {
  it('classifies platform context separately from human messages', () => {
    const turnId = 'turn-context'
    const message = (
      ordinal: number,
      id: string,
      role: string,
      text: string,
    ): CodexEnvelope => row(ordinal, 'response_item', {
      type: 'message',
      id,
      role,
      content: [{ type: 'input_text', text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    })
    const projection = projectCodexTrajectory([
      row(0, 'session_meta', { id: 'session-context' }),
      message(1, 'developer-1', 'developer', 'Follow the repository policy'),
      message(2, 'environment-1', 'user', '<environment_context><cwd>/workspace</cwd></environment_context>'),
      message(3, 'skill-1', 'user', '<skill><name>review</name></skill>'),
      message(4, 'aborted-1', 'user', '<turn_aborted>The user interrupted the previous turn</turn_aborted>'),
      message(5, 'user-1', 'user', 'Please continue'),
    ])

    expect(projection.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'context:developer-1',
        kind: 'context',
        title: '开发者上下文',
        status: 'complete',
      }),
      expect.objectContaining({
        id: 'context:environment-1',
        kind: 'context',
        title: '环境上下文',
        status: 'complete',
      }),
      expect.objectContaining({
        id: 'context:skill-1',
        kind: 'context',
        title: '技能上下文',
        status: 'complete',
      }),
      expect.objectContaining({
        id: 'context:aborted-1',
        kind: 'context',
        title: '轮次中断',
        status: 'interrupted',
      }),
      expect.objectContaining({
        id: 'user:user-1',
        kind: 'user',
        title: '用户',
      }),
    ]))
    expect(projection.records.filter(record => record.kind === 'user')).toHaveLength(1)
  })

  it('uses the latest turn model for the session header', () => {
    const projection = projectCodexTrajectory([
      row(0, 'session_meta', {
        id: 'session-model-switch',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
      row(1, 'turn_context', { turn_id: 'turn-1', model: 'first-model' }),
      row(2, 'turn_context', { turn_id: 'turn-2', model: 'latest-model' }),
    ])

    expect(projection.header.model).toBe('latest-model')
  })

  it('sums the latest per-turn usage when thread usage is absent', () => {
    const projection = projectCodexTrajectory([
      row(0, 'session_meta', { id: 'session-usage-fallback' }),
      row(1, 'token_usage_record', {
        turn_id: 'turn-1',
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      }),
      row(2, 'token_usage_record', {
        turn_id: 'turn-2',
        usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
      }),
    ])

    expect(projection.usage).toEqual({
      inputTokens: 30,
      outputTokens: 6,
      totalTokens: 36,
    })
  })

  it('keeps message timing separate from model-call usage and turn totals', () => {
    const turnId = 'turn-1'
    const rows: CodexEnvelope[] = [
      row(0, 'session_meta', {
        id: 'session-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp/work',
        model_provider: 'test-provider',
        cli_version: '1.2.3',
      }),
      row(1, 'event_msg', {
        type: 'task_started',
        turn_id: turnId,
        started_at_ms: 1_000,
      }),
      row(2, 'turn_context', {
        turn_id: turnId,
        model: 'test-model',
      }),
      row(4, 'response_item', {
        type: 'message',
        id: 'message-user',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }),
      row(8, 'response_item', {
        type: 'function_call',
        id: 'function-1',
        call_id: 'call-1',
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}',
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }),
      row(9, 'event_msg', {
        type: 'item_completed',
        turn_id: turnId,
        item: {
          type: 'CommandExecution',
          id: 'call-1',
          command: ['/bin/sh', '-lc', 'pwd'],
          status: 'completed',
          aggregated_output: '/tmp/work',
          exit_code: 0,
        },
        started_at_ms: 1_200,
        completed_at_ms: 1_300,
      }),
      row(10, 'response_item', {
        type: 'function_call_output',
        id: 'output-1',
        call_id: 'call-1',
        output: '/tmp/work',
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }),
      row(12, 'response_item', {
        type: 'message',
        id: 'message-assistant',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'done' }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }),
      row(13, 'event_msg', {
        type: 'item_completed',
        turn_id: turnId,
        item: {
          type: 'AgentMessage',
          id: 'message-assistant',
          phase: 'final_answer',
        },
        started_at_ms: 1_800,
        completed_at_ms: 1_900,
      }),
      row(14, 'token_usage_record', {
        turn_id: turnId,
        response_id: 'response-1',
        usage: {
          input_tokens: 20,
          output_tokens: 8,
          reasoning_output_tokens: 2,
          total_tokens: 30,
        },
        turn_token_usage: {
          input_tokens: 20,
          output_tokens: 8,
          reasoning_output_tokens: 2,
          total_tokens: 30,
        },
        thread_token_usage: {
          input_tokens: 20,
          output_tokens: 8,
          total_tokens: 30,
        },
      }),
      row(15, 'event_msg', {
        type: 'task_complete',
        turn_id: turnId,
        started_at_ms: 1_000,
        completed_at_ms: 2_000,
        duration_ms: 1_000,
        time_to_first_token_ms: 200,
      }),
    ]

    const projection = projectCodexTrajectory(rows)
    const tools = projection.records.filter(record => record.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      callId: 'call-1',
      title: 'exec_command',
      status: 'complete',
      startTime: 1_200,
      endTime: 1_300,
      input: { cmd: 'pwd' },
      output: '/tmp/work',
    })
    const assistant = projection.records.find(record => record.id === 'assistant:message-assistant')
    expect(assistant).toMatchObject({
      status: 'complete',
      startTime: 1_800,
      endTime: 1_900,
      model: 'test-model',
    })
    expect(assistant).not.toHaveProperty('usage')
    expect(assistant).not.toHaveProperty('metrics')
    expect(projection.records.find(record => record.id === 'model:response-1')).toMatchObject({
      kind: 'model',
      callId: 'response-1',
      startTime: Date.parse('2026-01-01T00:00:01.000Z'),
      endTime: Date.parse('2026-01-01T00:00:01.000Z'),
      usage: { inputTokens: 20, outputTokens: 8, reasoningTokens: 2, totalTokens: 30 },
      model: 'test-model',
    })
    expect(projection.turns).toEqual([expect.objectContaining({
      id: turnId,
      number: 1,
      startTime: 1_000,
      endTime: 2_000,
      status: 'complete',
      usage: { inputTokens: 20, outputTokens: 8, reasoningTokens: 2, totalTokens: 30 },
      metrics: { ttftMs: 200 },
    })])
    expect(projection.records.map(record => record.seq)).toEqual([4, 8, 12, 14])
    expect(projection.usage).toMatchObject({ totalTokens: 30 })
  })

  it('derives logical steps from model response boundaries and resets each turn', () => {
    const firstTurn = 'turn-steps-1'
    const secondTurn = 'turn-steps-2'
    const attributed = (turnId: string) => ({
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    })
    const usage = (turnId: string, responseId: string, ordinal: number) => row(
      ordinal,
      'token_usage_record',
      {
        turn_id: turnId,
        response_id: responseId,
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    )
    const projection = projectCodexTrajectory([
      row(0, 'session_meta', { id: 'session-steps' }),
      row(1, 'response_item', {
        type: 'message',
        id: 'user-1',
        role: 'user',
        content: [{ type: 'input_text', text: 'first turn' }],
        ...attributed(firstTurn),
      }),
      row(2, 'response_item', {
        type: 'reasoning',
        id: 'reasoning-1',
        summary: [{ type: 'summary_text', text: 'inspect first' }],
        ...attributed(firstTurn),
      }),
      row(3, 'response_item', {
        type: 'function_call',
        id: 'function-1',
        call_id: 'call-1',
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}',
        ...attributed(firstTurn),
      }),
      row(4, 'response_item', {
        type: 'function_call_output',
        id: 'output-1',
        call_id: 'call-1',
        output: '/workspace',
        ...attributed(firstTurn),
      }),
      usage(firstTurn, 'response-1', 5),
      row(6, 'response_item', {
        type: 'reasoning',
        id: 'reasoning-2',
        summary: [{ type: 'summary_text', text: 'finish next' }],
        ...attributed(firstTurn),
      }),
      row(7, 'response_item', {
        type: 'message',
        id: 'assistant-2',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'done' }],
        ...attributed(firstTurn),
      }),
      usage(firstTurn, 'response-2', 8),
      row(9, 'response_item', {
        type: 'message',
        id: 'user-2',
        role: 'user',
        content: [{ type: 'input_text', text: 'second turn' }],
        ...attributed(secondTurn),
      }),
      row(10, 'response_item', {
        type: 'message',
        id: 'assistant-3',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'second done' }],
        ...attributed(secondTurn),
      }),
      usage(secondTurn, 'response-3', 11),
    ])
    const byId = new Map(projection.records.map(record => [record.id, record]))

    expect(byId.get('user:user-1')?.step).toBe(0)
    expect(byId.get('reasoning:reasoning-1')?.step).toBe(1)
    expect(byId.get('tool:call-1')?.step).toBe(1)
    expect(byId.get('model:response-1')?.step).toBe(1)
    expect(byId.get('reasoning:reasoning-2')?.step).toBe(2)
    expect(byId.get('assistant:assistant-2')?.step).toBe(2)
    expect(byId.get('model:response-2')?.step).toBe(2)
    expect(byId.get('user:user-2')?.step).toBe(0)
    expect(byId.get('assistant:assistant-3')?.step).toBe(1)
    expect(byId.get('model:response-3')?.step).toBe(1)
  })

  it('derives write_stdin process failures from textual exit output', () => {
    const turnId = 'turn-write-stdin'
    const projection = projectCodexTrajectory([
      row(0, 'session_meta', { id: 'session-write-stdin' }),
      row(1, 'event_msg', { type: 'task_started', turn_id: turnId, started_at_ms: 1_000 }),
      row(2, 'response_item', {
        type: 'function_call',
        id: 'function-1',
        call_id: 'call-1',
        name: 'write_stdin',
        arguments: '{"session_id":42,"chars":""}',
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }),
      row(3, 'response_item', {
        type: 'function_call_output',
        id: 'output-1',
        call_id: 'call-1',
        output: 'Process exited with code 2\nFinal output:\nfailed',
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }),
    ])

    expect(projection.records.find(record => record.id === 'tool:call-1')).toMatchObject({
      status: 'error',
      fidelity: 'derived',
      error: {
        name: 'ToolError',
        code: '2',
      },
    })
  })

  it('keeps an aborted turn interrupted and does not expose encrypted reasoning', () => {
    const turnId = 'turn-aborted'
    const projection = projectCodexTrajectory([
      row(0, 'session_meta', { id: 'session-2' }),
      row(1, 'event_msg', { type: 'task_started', turn_id: turnId, started_at_ms: 1_000 }),
      row(2, 'response_item', {
        type: 'reasoning',
        id: 'reasoning-1',
        encrypted_content: 'ciphertext',
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }),
      row(3, 'response_item', {
        type: 'message',
        id: 'assistant-1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'partial' }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }),
      row(4, 'event_msg', {
        type: 'turn_aborted',
        turn_id: turnId,
        completed_at_ms: 1_500,
        duration_ms: 500,
        reason: 'interrupted',
      }),
    ])
    expect(projection.records.find(record => record.id === 'assistant:assistant-1')).toMatchObject({
      status: 'interrupted',
      endTime: Date.parse('2026-01-01T00:00:01.000Z'),
    })
    const reasoning = projection.records.find(record => record.id === 'reasoning:reasoning-1')
    expect(reasoning?.summary).toBe('加密推理内容')
    expect(JSON.stringify(reasoning?.raw)).not.toContain('ciphertext')
  })
})

describe('Codex source protocol detection', () => {
  it('blocks a well-formed rollout with an unknown header protocol', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-codex-protocol-'))
    const sessionsRoot = path.join(root, 'sessions')
    await fs.mkdir(sessionsRoot, { recursive: true })
    try {
      await fs.writeFile(
        path.join(sessionsRoot, 'rollout-future.jsonl'),
        `${JSON.stringify(row(0, 'session_header', {
          id: 'future-session',
          cli_version: '99.0.0',
        }))}\n`,
      )

      expect(await new CodexSource({
        sessionsRoot,
        sessionIndexFile: path.join(root, 'session_index.jsonl'),
      }).probe()).toMatchObject({
        availability: 'blocked',
        reason: 'unsupported_codex_protocol',
        protocol: {
          detected: 'codex-rollout-header:session_header',
          supported: ['codex-rollout-v1'],
          fingerprint: 'codex:rollout:session_header',
        },
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('keeps supported rollouts available when unknown headers are also present', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-codex-mixed-protocol-'))
    const sessionsRoot = path.join(root, 'sessions')
    await fs.mkdir(sessionsRoot, { recursive: true })
    try {
      await fs.writeFile(
        path.join(sessionsRoot, 'rollout-00-future.jsonl'),
        `${JSON.stringify(row(0, 'session_header', {
          id: 'future-session',
          cli_version: '99.0.0',
        }))}\n`,
      )
      await fs.writeFile(
        path.join(sessionsRoot, 'rollout-01-supported.jsonl'),
        `${JSON.stringify(row(0, 'session_meta', {
          id: 'supported-session',
          cli_version: '1.0.0',
        }))}\n`,
      )

      expect(await new CodexSource({
        sessionsRoot,
        sessionIndexFile: path.join(root, 'session_index.jsonl'),
      }).probe()).toMatchObject({
        availability: 'degraded',
        reason: 'additional_codex_protocols_ignored',
        protocol: {
          detected: 'codex-rollout-v1,codex-rollout-header:session_header',
          supported: ['codex-rollout-v1'],
          fingerprint: 'codex:rollout:session_meta,session_header',
        },
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('Codex source incremental loading', () => {
  it('rebuilds the least recently used session after the cache reaches its limit', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-codex-lru-'))
    const sessionsRoot = path.join(root, 'sessions')
    await fs.mkdir(sessionsRoot, { recursive: true })
    const writeSession = async (id: string) => {
      await fs.writeFile(
        path.join(sessionsRoot, `rollout-${id}.jsonl`),
        `${JSON.stringify(row(0, 'session_meta', {
          id,
          timestamp: '2026-01-01T00:00:00.000Z',
          cwd: `/tmp/${id}`,
        }))}\n`,
      )
    }
    try {
      await writeSession('session-first')
      await writeSession('session-second')
      const source = new CodexSource({
        sessionsRoot,
        sessionIndexFile: path.join(root, 'session_index.jsonl'),
        cacheEntries: 1,
      })
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

  it('combines continuation pages whose ordinals restart from zero', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-codex-pages-'))
    const sessionsRoot = path.join(root, 'sessions')
    const firstPage = path.join(sessionsRoot, '2026', '01', 'rollout-session.jsonl')
    const continuation = path.join(sessionsRoot, '2026', '01', 'rollout-session_2.jsonl')
    await fs.mkdir(path.dirname(firstPage), { recursive: true })
    const sessionMeta = (timestamp: string) => row(0, 'session_meta', {
      id: 'session-paged',
      timestamp,
      cwd: '/tmp/work',
    }, timestamp)
    const message = (id: string, text: string, timestamp: string) => row(1, 'response_item', {
      type: 'message',
      id,
      role: 'user',
      content: [{ type: 'input_text', text }],
    }, timestamp)
    try {
      await fs.writeFile(firstPage, [
        sessionMeta('2026-01-01T00:00:00.000Z'),
        message('user-first', 'first page', '2026-01-01T00:00:01.000Z'),
      ].map(value => JSON.stringify(value)).join('\n') + '\n')
      await fs.writeFile(continuation, [
        sessionMeta('2026-01-01T00:01:00.000Z'),
        message('user-second', 'second page', '2026-01-01T00:01:01.000Z'),
      ].map(value => JSON.stringify(value)).join('\n') + '\n')
      const source = new CodexSource({
        sessionsRoot,
        sessionIndexFile: path.join(root, 'session_index.jsonl'),
      })

      const refs = await source.list()
      expect(refs).toHaveLength(1)
      const detail = await source.load(refs[0]!)

      expect(detail.projection.records.map(record => record.summary))
        .toEqual(['first page', 'second page'])
      expect(detail.projection.records.map(record => record.seq))
        .toEqual([1, 3])
      expect(detail.projection.records.map(record => record.sourceEventIds.at(-1)))
        .toEqual([
          'page:0:line:2:ordinal:1',
          'page:1:line:2:ordinal:1',
        ])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('orders same-time continuation pages by numeric suffix', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-codex-page-order-'))
    const sessionsRoot = path.join(root, 'sessions')
    await fs.mkdir(sessionsRoot, { recursive: true })
    const sessionMeta = row(0, 'session_meta', {
      id: 'session-same-time-pages',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp/work',
    }, '2026-01-01T00:00:00.000Z')
    const page = (id: string, text: string) => [
      sessionMeta,
      row(1, 'response_item', {
        type: 'message',
        id,
        role: 'user',
        content: [{ type: 'input_text', text }],
      }),
    ].map(value => JSON.stringify(value)).join('\n') + '\n'
    try {
      await fs.writeFile(
        path.join(sessionsRoot, 'rollout-session_10.jsonl'),
        page('user-10', 'page 10'),
      )
      await fs.writeFile(
        path.join(sessionsRoot, 'rollout-session_2.jsonl'),
        page('user-2', 'page 2'),
      )
      const source = new CodexSource({
        sessionsRoot,
        sessionIndexFile: path.join(root, 'session_index.jsonl'),
      })

      const [ref] = await source.list()
      const detail = await source.load(ref!)

      expect(detail.projection.records.map(record => record.summary))
        .toEqual(['page 2', 'page 10'])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('keeps prior events and projects only newly appended JSONL rows', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-codex-source-'))
    const sessionsRoot = path.join(root, 'sessions')
    const file = path.join(sessionsRoot, '2026', '01', 'rollout-session.jsonl')
    await fs.mkdir(path.dirname(file), { recursive: true })
    const sessionMeta = row(0, 'session_meta', {
      id: 'session-incremental',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp/work',
    })
    const user = row(1, 'response_item', {
      type: 'message',
      id: 'user-1',
      role: 'user',
      content: [{ type: 'input_text', text: 'first' }],
    })
    const assistant = row(2, 'response_item', {
      type: 'message',
      id: 'assistant-1',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'second' }],
    })
    try {
      await fs.writeFile(file, `${JSON.stringify(sessionMeta)}\n${JSON.stringify(user)}\n`)
      const source = new CodexSource({
        sessionsRoot,
        sessionIndexFile: path.join(root, 'session_index.jsonl'),
      })
      const [ref] = await source.list()
      expect((await source.load(ref!)).projection.records.map(record => record.summary))
        .toEqual(['first'])

      await fs.appendFile(file, `${JSON.stringify(assistant)}\n`)

      expect((await source.load(ref!)).projection.records.map(record => record.summary))
        .toEqual(['first', 'second'])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('does not duplicate a valid final row when its newline is appended later', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-codex-valid-tail-'))
    const sessionsRoot = path.join(root, 'sessions')
    const file = path.join(sessionsRoot, 'rollout-session.jsonl')
    await fs.mkdir(sessionsRoot, { recursive: true })
    const sessionMeta = row(0, 'session_meta', {
      id: 'session-valid-tail',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp/work',
    })
    const user = row(1, 'response_item', {
      type: 'message',
      id: 'user-1',
      role: 'user',
      content: [{ type: 'input_text', text: 'first' }],
    })
    const assistant = row(2, 'response_item', {
      type: 'message',
      id: 'assistant-1',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'second' }],
    })
    try {
      await fs.writeFile(file, `${JSON.stringify(sessionMeta)}\n${JSON.stringify(user)}`)
      const source = new CodexSource({
        sessionsRoot,
        sessionIndexFile: path.join(root, 'session_index.jsonl'),
      })
      const [ref] = await source.list()
      expect((await source.load(ref!)).projection.records.map(record => record.summary))
        .toEqual(['first'])

      await fs.appendFile(file, `\n${JSON.stringify(assistant)}\n`)

      const updated = await source.load(ref!)
      expect(updated.projection.eventCount).toBe(3)
      expect(updated.projection.records.map(record => record.summary))
        .toEqual(['first', 'second'])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('recovers when a rollout file is rewritten with longer content', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-codex-rewrite-'))
    const sessionsRoot = path.join(root, 'sessions')
    const file = path.join(sessionsRoot, 'rollout-session.jsonl')
    await fs.mkdir(sessionsRoot, { recursive: true })
    const sessionMeta = (cwd: string) => row(0, 'session_meta', {
      id: 'session-rewritten',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd,
    })
    const message = (ordinal: number, id: string, text: string) => row(ordinal, 'response_item', {
      type: 'message',
      id,
      role: 'user',
      content: [{ type: 'input_text', text }],
    })
    try {
      await fs.writeFile(file, [
        sessionMeta('/tmp/old'),
        message(1, 'old-message', 'old'),
      ].map(value => JSON.stringify(value)).join('\n') + '\n')
      const source = new CodexSource({
        sessionsRoot,
        sessionIndexFile: path.join(root, 'session_index.jsonl'),
      })
      const [ref] = await source.list()
      expect((await source.load(ref!)).projection.records.map(record => record.summary))
        .toEqual(['old'])

      await fs.writeFile(file, [
        sessionMeta('/tmp/a-much-longer-rewritten-directory'),
        message(1, 'new-message', 'rewritten content replaces the old page'),
        message(2, 'new-message-2', 'new trailing message'),
      ].map(value => JSON.stringify(value)).join('\n') + '\n')

      expect((await source.load(ref!)).projection.records.map(record => record.summary))
        .toEqual(['rewritten content replaces the old page', 'new trailing message'])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('updates only the renamed session fingerprint and detail title', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-codex-index-'))
    const sessionsRoot = path.join(root, 'sessions')
    const sessionIndexFile = path.join(root, 'session_index.jsonl')
    await fs.mkdir(sessionsRoot, { recursive: true })
    const writeSession = async (id: string) => {
      const file = path.join(sessionsRoot, `rollout-${id}.jsonl`)
      await fs.writeFile(file, `${JSON.stringify(row(0, 'session_meta', {
        id,
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: `/tmp/${id}`,
      }))}\n`)
    }
    const writeIndex = async (firstTitle: string) => {
      await fs.writeFile(sessionIndexFile, [
        { id: 'session-first', thread_name: firstTitle, updated_at: '2026-01-01T00:01:00.000Z' },
        { id: 'session-second', thread_name: 'Second title', updated_at: '2026-01-01T00:01:00.000Z' },
      ].map(value => JSON.stringify(value)).join('\n') + '\n')
    }
    try {
      await writeSession('session-first')
      await writeSession('session-second')
      await writeIndex('First title')
      const source = new CodexSource({ sessionsRoot, sessionIndexFile })
      const refs = await source.list()
      const first = refs.find(ref => ref.sourceSessionId === 'session-first')!
      const second = refs.find(ref => ref.sourceSessionId === 'session-second')!
      const firstFingerprint = await source.fingerprint(first)
      const secondFingerprint = await source.fingerprint(second)

      await writeIndex('Renamed first title')

      expect(await source.fingerprint(first)).not.toBe(firstFingerprint)
      expect(await source.fingerprint(second)).toBe(secondFingerprint)
      expect((await source.load(first)).summary.title).toBe('Renamed first title')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('discovers a continuation page created after the session was opened', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-codex-live-page-'))
    const sessionsRoot = path.join(root, 'sessions')
    const firstPage = path.join(sessionsRoot, 'rollout-session.jsonl')
    const continuation = path.join(sessionsRoot, 'rollout-session_2.jsonl')
    await fs.mkdir(sessionsRoot, { recursive: true })
    const sessionMeta = (timestamp: string) => row(0, 'session_meta', {
      id: 'session-live-page',
      timestamp,
      cwd: '/tmp/work',
    }, timestamp)
    const message = (id: string, text: string, timestamp: string) => row(1, 'response_item', {
      type: 'message',
      id,
      role: 'user',
      content: [{ type: 'input_text', text }],
    }, timestamp)
    try {
      await fs.writeFile(firstPage, [
        sessionMeta('2026-01-01T00:00:00.000Z'),
        message('user-first', 'first page', '2026-01-01T00:00:01.000Z'),
      ].map(value => JSON.stringify(value)).join('\n') + '\n')
      const source = new CodexSource({
        sessionsRoot,
        sessionIndexFile: path.join(root, 'session_index.jsonl'),
      })
      const [ref] = await source.list()
      const originalFingerprint = await source.fingerprint(ref!)
      expect((await source.load(ref!)).projection.records.map(record => record.summary))
        .toEqual(['first page'])

      await fs.writeFile(continuation, [
        sessionMeta('2026-01-01T00:01:00.000Z'),
        message('user-second', 'second page', '2026-01-01T00:01:01.000Z'),
      ].map(value => JSON.stringify(value)).join('\n') + '\n')

      expect(await source.fingerprint(ref!)).not.toBe(originalFingerprint)
      expect((await source.load(ref!)).projection.records.map(record => record.summary))
        .toEqual(['first page', 'second page'])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('discovers a continuation page created in a later date directory', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-codex-live-date-'))
    const sessionsRoot = path.join(root, 'sessions')
    const firstPage = path.join(
      sessionsRoot,
      '2026',
      '01',
      '01',
      'rollout-session.jsonl',
    )
    const continuation = path.join(
      sessionsRoot,
      '2026',
      '01',
      '02',
      'rollout-session_2.jsonl',
    )
    const sessionMeta = (timestamp: string) => row(0, 'session_meta', {
      id: 'session-live-date',
      timestamp,
      cwd: '/tmp/work',
    }, timestamp)
    const message = (id: string, text: string, timestamp: string) => row(1, 'response_item', {
      type: 'message',
      id,
      role: 'user',
      content: [{ type: 'input_text', text }],
    }, timestamp)
    try {
      await fs.mkdir(path.dirname(firstPage), { recursive: true })
      await fs.writeFile(firstPage, [
        sessionMeta('2026-01-01T23:59:00.000Z'),
        message('user-first', 'first page', '2026-01-01T23:59:01.000Z'),
      ].map(value => JSON.stringify(value)).join('\n') + '\n')
      const source = new CodexSource({
        sessionsRoot,
        sessionIndexFile: path.join(root, 'session_index.jsonl'),
      })
      const [ref] = await source.list()
      const originalFingerprint = await source.fingerprint(ref!)
      expect((await source.load(ref!)).projection.records.map(record => record.summary))
        .toEqual(['first page'])

      await fs.mkdir(path.dirname(continuation), { recursive: true })
      await fs.writeFile(continuation, [
        sessionMeta('2026-01-02T00:01:00.000Z'),
        message('user-second', 'second page', '2026-01-02T00:01:01.000Z'),
      ].map(value => JSON.stringify(value)).join('\n') + '\n')

      expect(await source.fingerprint(ref!)).not.toBe(originalFingerprint)
      expect((await source.load(ref!)).projection.records.map(record => record.summary))
        .toEqual(['first page', 'second page'])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('does not reopen indexed rollout headers during stable fingerprint polls', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-codex-poll-'))
    const sessionsRoot = path.join(root, 'sessions')
    const sessionIndexFile = path.join(root, 'session_index.jsonl')
    const sessionFile = path.join(sessionsRoot, 'rollout-session.jsonl')
    const unrelatedFile = path.join(sessionsRoot, 'rollout-unrelated.jsonl')
    await fs.mkdir(sessionsRoot, { recursive: true })
    try {
      await fs.writeFile(sessionFile, `${JSON.stringify(row(0, 'session_meta', {
        id: 'session-poll',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp/work',
      }))}\n`)
      await fs.writeFile(unrelatedFile, `${JSON.stringify(row(0, 'session_meta', {
        id: 'session-unrelated',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp/unrelated',
      }))}\n`)
      await fs.writeFile(sessionIndexFile, `${JSON.stringify({
        id: 'session-poll',
        thread_name: 'Polled session',
        updated_at: '2026-01-01T00:00:01.000Z',
      })}\n`)
      const source = new CodexSource({
        sessionsRoot,
        sessionIndexFile,
      })
      const refs = await source.list()
      const ref = refs.find(candidate => candidate.sourceSessionId === 'session-poll')!
      const open = vi.spyOn(fs, 'open')
      const readFile = vi.spyOn(fs, 'readFile')

      await source.fingerprint(ref)
      await source.fingerprint(ref)

      expect(open).not.toHaveBeenCalled()
      expect(readFile).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('retries a continuation whose header was initially incomplete', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-codex-torn-header-'))
    const sessionsRoot = path.join(root, 'sessions')
    const firstPage = path.join(sessionsRoot, '2026', '01', '01', 'rollout-session.jsonl')
    const continuation = path.join(sessionsRoot, '2026', '01', '02', 'rollout-session_2.jsonl')
    const sessionMeta = (timestamp: string) => row(0, 'session_meta', {
      id: 'session-torn-header',
      timestamp,
      cwd: '/tmp/work',
    }, timestamp)
    const message = (id: string, text: string, timestamp: string) => row(1, 'response_item', {
      type: 'message',
      id,
      role: 'user',
      content: [{ type: 'input_text', text }],
    }, timestamp)
    try {
      await fs.mkdir(path.dirname(firstPage), { recursive: true })
      await fs.writeFile(firstPage, [
        sessionMeta('2026-01-01T23:59:00.000Z'),
        message('user-first', 'first page', '2026-01-01T23:59:01.000Z'),
      ].map(value => JSON.stringify(value)).join('\n') + '\n')
      const source = new CodexSource({
        sessionsRoot,
        sessionIndexFile: path.join(root, 'session_index.jsonl'),
      })
      const [ref] = await source.list()
      const originalFingerprint = await source.fingerprint(ref!)

      await fs.mkdir(path.dirname(continuation), { recursive: true })
      await fs.writeFile(continuation, '{"ordinal":0')
      expect(await source.fingerprint(ref!)).toBe(originalFingerprint)

      await fs.writeFile(continuation, [
        sessionMeta('2026-01-02T00:01:00.000Z'),
        message('user-second', 'second page', '2026-01-02T00:01:01.000Z'),
      ].map(value => JSON.stringify(value)).join('\n') + '\n')

      expect(await source.fingerprint(ref!)).not.toBe(originalFingerprint)
      expect((await source.load(ref!)).projection.records.map(record => record.summary))
        .toEqual(['first page', 'second page'])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
