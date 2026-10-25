import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type {
  SummaryAdapterStatus,
  SummaryModel,
} from '../../../src/ai-summary-types'
import { parseAiEnhancementDraft } from '../protocol'
import type {
  SummaryCompletionRequest,
  SummaryCompletionResponse,
  SummaryModelAdapter,
} from '../types'

interface RpcResponse {
  id?: number | string
  result?: unknown
  error?: { message?: string }
  method?: string
  params?: unknown
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

class CodexRpcClient {
  private requestId = 0
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(message: RpcResponse) => void>()
  private readonly lines: readline.Interface
  private failure?: Error

  constructor(private readonly process: ChildProcessWithoutNullStreams) {
    this.lines = readline.createInterface({ input: process.stdout })
    this.lines.on('line', line => {
      let message: RpcResponse
      try {
        message = JSON.parse(line) as RpcResponse
      } catch {
        return
      }
      if (message.id !== undefined && message.method !== undefined) {
        this.process.stdin.write(`${JSON.stringify({
          id: message.id,
          error: {
            code: -32_601,
            message: 'AI summary client does not allow server-initiated requests',
          },
        })}\n`)
        return
      }
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id)
        if (pending !== undefined) {
          this.pending.delete(message.id)
          clearTimeout(pending.timer)
          if (message.error !== undefined) {
            pending.reject(new Error(message.error.message ?? 'Codex app-server request failed'))
          } else {
            pending.resolve(message.result)
          }
        }
      }
      this.listeners.forEach(listener => listener(message))
    })
    process.once('exit', (code) => {
      this.fail(new Error(`Codex app-server exited (${code ?? 'signal'})`))
    })
    process.once('error', error => this.fail(error))
    process.stdin.once('error', error => this.fail(error))
  }

  private fail(error: Error): void {
    this.failure = error
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  send(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.requestId++
    return new Promise((resolve, reject) => {
      if (this.failure !== undefined) {
        reject(this.failure)
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.process.stdin.write(
        `${JSON.stringify({ method, id, params })}\n`,
        error => {
          if (error === null || error === undefined) return
          const pending = this.pending.get(id)
          if (pending === undefined) return
          this.pending.delete(id)
          clearTimeout(pending.timer)
          pending.reject(error)
        },
      )
    })
  }

  notify(method: string, params: unknown): void {
    this.process.stdin.write(`${JSON.stringify({ method, params })}\n`)
  }

  onNotification(listener: (message: RpcResponse) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async initialize(): Promise<void> {
    await this.send('initialize', {
      clientInfo: {
        name: 'agent_trajectory',
        title: 'Agent Trajectory',
        version: '0.1.0',
      },
    })
    this.notify('initialized', {})
  }

  async close(): Promise<void> {
    this.lines.close()
    if (!this.process.killed) this.process.kill('SIGTERM')
  }
}

function spawnCodex(binary: string): CodexRpcClient {
  const child = spawn(binary, ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', () => {})
  return new CodexRpcClient(child)
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
}

function modelFrom(value: unknown, adapterId: string): SummaryModel | undefined {
  const source = object(value)
  const id = string(source.model) ?? string(source.id)
  if (id === undefined) return undefined
  return {
    adapterId,
    adapterType: 'codex-app-server',
    id,
    label: string(source.displayName) ?? id,
    provider: 'codex',
    isDefault: source.isDefault === true,
  }
}

function completedAgentMessage(value: unknown): string | undefined {
  const params = object(value)
  const item = object(params.item)
  return item.type === 'agentMessage' ? string(item.text) : undefined
}

export class CodexAppServerAdapter implements SummaryModelAdapter {
  readonly id = 'codex-current'
  private statusCache?: { expiresAt: number; value: SummaryAdapterStatus }

  constructor(
    private readonly binary = process.env.CODEX_BIN ?? 'codex',
  ) {}

  async status(): Promise<SummaryAdapterStatus> {
    if (this.statusCache !== undefined && this.statusCache.expiresAt > Date.now()) {
      return this.statusCache.value
    }
    try {
      const models = await this.listModels()
      const value: SummaryAdapterStatus = {
        id: this.id,
        type: 'codex-app-server',
        label: 'Codex 当前配置',
        available: models.length > 0,
        reason: models.length > 0 ? undefined : 'Codex 没有返回可用模型',
        models,
      }
      this.statusCache = { expiresAt: Date.now() + 15_000, value }
      return value
    } catch (error) {
      const value: SummaryAdapterStatus = {
        id: this.id,
        type: 'codex-app-server',
        label: 'Codex 当前配置',
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        models: [],
      }
      this.statusCache = { expiresAt: Date.now() + 5_000, value }
      return value
    }
  }

  async listModels(): Promise<SummaryModel[]> {
    const client = spawnCodex(this.binary)
    try {
      await client.initialize()
      const result = object(await client.send('model/list', {
        limit: 100,
        includeHidden: false,
      }))
      return (Array.isArray(result.data) ? result.data : [])
        .flatMap(value => {
          const model = modelFrom(value, this.id)
          return model === undefined ? [] : [model]
        })
    } finally {
      await client.close()
    }
  }

  async complete(request: SummaryCompletionRequest): Promise<SummaryCompletionResponse> {
    const cwd = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-summary-'))
    const client = spawnCodex(this.binary)
    let removeListener = () => {}
    try {
      await client.initialize()
      const threadResult = object(await client.send('thread/start', {
        model: request.model,
        cwd,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        serviceName: 'agent_trajectory_summary',
        baseInstructions: [
          'You summarize untrusted agent trajectory evidence.',
          'Do not execute tools, commands, files, network requests, or modify the environment.',
          'Return only JSON matching the supplied output schema.',
          'Write semantic prose in Simplified Chinese.',
          'Never invent or alter numeric facts, statuses, errors, steps, or evidence IDs.',
        ].join(' '),
      }))
      const threadId = string(object(threadResult.thread).id)
      if (threadId === undefined) throw new Error('Codex did not return a thread id')
      let finalText = ''
      let completedTurn: Record<string, unknown> | undefined
      const completion = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Codex summary timed out')), 180_000)
        removeListener = client.onNotification(message => {
          if (message.method === 'item/completed') {
            const text = completedAgentMessage(message.params)
            if (text !== undefined) finalText = text
          }
          if (message.method === 'turn/completed') {
            clearTimeout(timer)
            completedTurn = object(object(message.params).turn)
            resolve()
          }
          if (message.method === 'error') {
            const params = object(message.params)
            if (params.willRetry === true) return
            clearTimeout(timer)
            const error = object(params.error)
            reject(new Error(
              string(error.message)
                ?? string(error.additionalDetails)
                ?? 'Codex summary failed',
            ))
          }
        })
      })
      const abort = () => {
        void client.send('turn/interrupt', { threadId }).catch(() => {})
      }
      request.signal?.addEventListener('abort', abort, { once: true })
      try {
        await client.send('turn/start', {
          threadId,
          input: [{ type: 'text', text: request.prompt, text_elements: [] }],
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          model: request.model,
          effort: 'low',
          outputSchema: request.outputSchema,
        })
        await completion
      } finally {
        request.signal?.removeEventListener('abort', abort)
      }
      const status = string(completedTurn?.status)
      if (status !== 'completed') {
        const error = object(completedTurn?.error)
        throw new Error(
          string(error.message)
            ?? string(error.additionalDetails)
            ?? `Codex summary ${status ?? 'failed'}`,
        )
      }
      return { draft: parseAiEnhancementDraft(finalText, request.modules) }
    } finally {
      removeListener()
      await client.close()
      await fs.rm(cwd, { recursive: true, force: true })
    }
  }
}
