import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexAppServerAdapter } from '../server/summary/adapters/codex-app-server'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

async function executable(source: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-codex-adapter-'))
  roots.push(root)
  const file = path.join(root, 'mock-codex')
  await fs.writeFile(file, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 })
  return file
}

const validDraft = {
  outcome: {
    headline: '执行已完成',
    summary: '完成检查并确认调用链路可用',
    verification: '已有验证证据',
    unresolved: [],
    evidenceRecordIds: [],
  },
  evidenceRequests: [],
}

describe('CodexAppServerAdapter', () => {
  it('waits for the final turn after a retryable error notification', async () => {
    const binary = await executable(`
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
input.on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n')
  } else if (message.method === 'thread/start') {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: { thread: { id: 'thread-test' } },
    }) + '\\n')
  } else if (message.method === 'turn/start') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n')
    process.stdout.write(JSON.stringify({
      method: 'error',
      params: {
        willRetry: true,
        error: { message: 'temporary bridge failure' },
      },
    }) + '\\n')
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        method: 'item/completed',
        params: {
          item: {
            type: 'agentMessage',
            text: ${JSON.stringify(JSON.stringify(validDraft))},
          },
        },
      }) + '\\n')
      process.stdout.write(JSON.stringify({
        method: 'turn/completed',
        params: { turn: { status: 'completed' } },
      }) + '\\n')
    }, 10)
  }
})
`)
    const adapter = new CodexAppServerAdapter(binary)

    const result = await adapter.complete({
      model: 'summary-model',
      prompt: 'summarize',
      modules: ['outcome'],
      outputSchema: {
        type: 'object',
        required: ['outcome', 'evidenceRequests'],
      },
    })

    expect(result.draft).toEqual(validDraft)
  })

  it('rejects server-initiated requests and continues the client request', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-codex-rejection-'))
    roots.push(root)
    const log = path.join(root, 'response.json')
    const binary = await executable(`
const fs = require('node:fs')
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
let initializeId
input.on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    initializeId = message.id
    process.stdout.write(JSON.stringify({
      id: 'server-request',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'should-not-run' },
    }) + '\\n')
  } else if (message.id === 'server-request') {
    fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(message))
    process.stdout.write(JSON.stringify({ id: initializeId, result: {} }) + '\\n')
  } else if (message.method === 'model/list') {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: {
        data: [{
          id: 'summary-model',
          displayName: 'Summary Model',
          isDefault: true,
        }],
      },
    }) + '\\n')
  }
})
`)
    const adapter = new CodexAppServerAdapter(binary)

    const models = await adapter.listModels()
    const response = JSON.parse(await fs.readFile(log, 'utf8')) as {
      id: string
      error: { code: number; message: string }
    }

    expect(models).toEqual([expect.objectContaining({
      id: 'summary-model',
      label: 'Summary Model',
    })])
    expect(response).toEqual({
      id: 'server-request',
      error: {
        code: -32601,
        message: 'AI summary client does not allow server-initiated requests',
      },
    })
  })

  it('fails quickly when the Codex child process cannot be spawned', async () => {
    const adapter = new CodexAppServerAdapter(
      path.join(tmpdir(), 'agent-trajectory-missing-codex-binary'),
    )

    const result = await Promise.race([
      adapter.listModels().then(
        () => ({ state: 'resolved' as const }),
        error => ({ state: 'rejected' as const, error }),
      ),
      new Promise<{ state: 'timed-out' }>(resolve => {
        setTimeout(() => resolve({ state: 'timed-out' }), 1_000)
      }),
    ])

    expect(result.state).toBe('rejected')
    if (result.state === 'rejected') {
      expect(String(result.error)).toMatch(/ENOENT|spawn/)
    }
  })
})
