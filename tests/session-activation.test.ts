import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { BrowserSession } from '../server/browser-session'
import {
  normalizeHookPayload,
  SessionActivationHub,
} from '../server/session-activation'

function request(
  method = 'GET',
  headers: Record<string, string> = {},
): IncomingMessage {
  return { method, headers } as IncomingMessage
}

function response() {
  const state: {
    body?: string
    headers?: Record<string, string>
    status?: number
  } = {}
  return {
    state,
    value: {
      writeHead(status: number, headers: Record<string, string>) {
        state.status = status
        state.headers = headers
      },
      end(body?: string) {
        state.body = body
      },
    } as unknown as ServerResponse,
  }
}

describe('browser session authorization', () => {
  it('exchanges a one-time launch token for a strict HTTP-only cookie', () => {
    const session = new BrowserSession()
    const launch = new URL(session.createLaunchUrl(
      'http://127.0.0.1:4317',
      '/?source=codex&session=thread-1',
    ))
    const first = response()

    expect(session.authorize(
      request(),
      first.value,
      launch,
    )).toBe('handled')
    expect(first.state).toMatchObject({
      status: 302,
      headers: {
        Location: '/?source=codex&session=thread-1',
      },
    })
    expect(first.state.headers?.['Set-Cookie']).toMatch(
      /HttpOnly; SameSite=Strict; Path=\//,
    )

    const replay = response()
    expect(session.authorize(request(), replay.value, launch)).toBe('rejected')
    const cookie = first.state.headers?.['Set-Cookie']?.split(';')[0]
    expect(session.authorize(
      request('GET', { cookie: cookie! }),
      response().value,
      new URL('http://127.0.0.1:4317/'),
    )).toBe('allowed')
  })

  it('requires same-origin evidence for browser mutations', () => {
    const session = new BrowserSession()
    expect(session.allowsMutation(
      request('POST', {
        origin: 'http://127.0.0.1:4317',
        'sec-fetch-site': 'same-origin',
      }),
      'http://127.0.0.1:4317',
    )).toBe(true)
    expect(session.allowsMutation(
      request('POST', {
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      }),
      'http://127.0.0.1:4317',
    )).toBe(false)
  })
})

describe('session activation normalization', () => {
  it('accepts top-level SessionStart data and drops prompt-like extra fields', () => {
    expect(normalizeHookPayload('codex', {
      hook_event_name: 'SessionStart',
      session_id: 'thread-1',
      cwd: '/workspace',
      source: 'startup',
      prompt: 'must not cross the relay',
    })).toMatchObject({
      source: 'codex',
      sessionId: 'thread-1',
      cwd: '/workspace',
      startSource: 'startup',
      event: 'session-start',
    })
  })

  it('ignores compaction and malformed session events', () => {
    expect(normalizeHookPayload('codex', {
      hook_event_name: 'SessionStart',
      session_id: 'thread-1',
      source: 'compact',
    })).toBeUndefined()
    expect(normalizeHookPayload('zcode', {
      hook_event_name: 'Stop',
      session_id: 'thread-1',
    })).toBeUndefined()
  })

  it('deduplicates repeated activations and opens only when no page observes them', () => {
    const hub = new SessionActivationHub('hook-token')
    const show = vi.fn()
    hub.setShowHandler(show)
    const activation = {
      source: 'dsh' as const,
      sessionId: 'session-1',
      event: 'session-start' as const,
      timestamp: Date.now(),
    }

    expect(hub.publish(activation)).toBe(true)
    expect(hub.publish(activation)).toBe(false)
    expect(show).toHaveBeenCalledOnce()
  })
})
