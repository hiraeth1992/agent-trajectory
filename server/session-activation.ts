import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSourceId, type SourceId } from '../src/types'

const MAX_HOOK_BYTES = 64 * 1024

export interface SessionActivation {
  source: SourceId
  sessionId: string
  event: 'session-start'
  cwd?: string
  startSource?: string
  timestamp: number
}

export interface HookPayload {
  cwd?: unknown
  hook_event_name?: unknown
  session_id?: unknown
  session_start_source?: unknown
  source?: unknown
  transcript_path?: unknown
}

function sourceId(value: unknown): SourceId | undefined {
  return isSourceId(value) ? value : undefined
}

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim()
  return cleaned !== '' && cleaned.length <= maxLength ? cleaned : undefined
}

function sameToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes)
}

function bearer(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization
  return authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : undefined
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_HOOK_BYTES) {
        reject(new Error('hook payload too large'))
        request.destroy()
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    request.once('end', () => {
      try {
        resolve(chunks.length === 0
          ? {}
          : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid hook JSON'))
      }
    })
    request.once('error', reject)
  })
}

export function normalizeHookPayload(
  configuredSource: SourceId | undefined,
  value: unknown,
): SessionActivation | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const payload = value as HookPayload
  if (payload.hook_event_name !== undefined
    && payload.hook_event_name !== 'SessionStart') return undefined
  const startSource = text(
    payload.session_start_source ?? payload.source,
    64,
  )
  if (startSource === 'compact' || startSource === 'clear') return undefined
  const source = configuredSource ?? sourceId(payload.source)
  const sessionId = text(payload.session_id, 500)
  if (source === undefined || sessionId === undefined) return undefined
  return {
    source,
    sessionId,
    event: 'session-start',
    cwd: text(payload.cwd, 4_096),
    startSource,
    timestamp: Date.now(),
  }
}

export class SessionActivationHub {
  private readonly listeners = new Set<ServerResponse>()
  private readonly recent = new Map<string, number>()
  private onShow?: (activation?: SessionActivation) => void

  constructor(private readonly hookToken: string) {}

  setShowHandler(handler: (activation?: SessionActivation) => void): void {
    this.onShow = handler
  }

  publish(activation: SessionActivation): boolean {
    const key = `${activation.source}:${activation.sessionId}:${activation.startSource ?? ''}`
    const now = Date.now()
    const previous = this.recent.get(key)
    if (previous !== undefined && now - previous < 2_000) return false
    this.recent.set(key, now)
    for (const [candidate, timestamp] of this.recent) {
      if (now - timestamp > 60_000) this.recent.delete(candidate)
    }
    const message = `event: activation\ndata: ${JSON.stringify(activation)}\n\n`
    for (const listener of this.listeners) listener.write(message)
    if (this.listeners.size === 0) this.onShow?.(activation)
    return true
  }

  async handleHook(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (url.pathname !== '/api/integrations/session-start'
      && url.pathname !== '/api/integrations/show'
      && url.pathname !== '/api/integrations/ping') return false
    if (request.method !== 'POST') {
      response.writeHead(405, { 'Content-Type': 'application/json' })
      response.end('{"error":"method not allowed"}')
      return true
    }
    const supplied = bearer(request)
    if (supplied === undefined || !sameToken(supplied, this.hookToken)) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end('{"error":"unauthorized"}')
      return true
    }
    if (url.pathname === '/api/integrations/ping') {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      })
      response.end('{"ok":true}')
      return true
    }
    if (url.pathname === '/api/integrations/show') {
      this.onShow?.()
      response.writeHead(202, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      })
      response.end('{"ok":true}')
      return true
    }
    const source = sourceId(request.headers['x-agent-trajectory-source'])
    const activation = normalizeHookPayload(source, await readJson(request))
    if (activation === undefined) {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end('{"error":"invalid session-start payload"}')
      return true
    }
    const published = this.publish(activation)
    response.writeHead(202, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    })
    response.end(JSON.stringify({ ok: true, published }))
    return true
  }

  subscribe(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    response.write('retry: 1500\n\n')
    this.listeners.add(response)
    const close = () => this.listeners.delete(response)
    request.once('close', close)
    response.once('close', close)
  }

  close(): void {
    for (const listener of this.listeners) listener.end()
    this.listeners.clear()
  }
}
