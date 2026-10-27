import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  assertLoopbackListenHost,
  hasAllowedBrowserMutation,
  hasAllowedLocalRequest,
} from '../server/security'

function request(
  host: string,
  localPort: number,
  remoteAddress: string,
): IncomingMessage {
  return {
    headers: { host },
    socket: { localPort, remoteAddress },
  } as IncomingMessage
}

describe('local HTTP boundary', () => {
  it('accepts only explicit loopback listen hosts', () => {
    expect(assertLoopbackListenHost(undefined)).toBe('127.0.0.1')
    expect(assertLoopbackListenHost('127.0.0.1')).toBe('127.0.0.1')
    expect(assertLoopbackListenHost('::1')).toBe('::1')
    expect(() => assertLoopbackListenHost('0.0.0.0')).toThrow(/loopback/i)
    expect(() => assertLoopbackListenHost('192.168.1.20')).toThrow(/loopback/i)
  })

  it('requires both a local Host header and a loopback peer', () => {
    expect(hasAllowedLocalRequest(request('localhost:4317', 4317, '127.0.0.1')))
      .toBe(true)
    expect(hasAllowedLocalRequest(request('127.0.0.1:4317', 4317, '::ffff:127.0.0.1')))
      .toBe(true)
    expect(hasAllowedLocalRequest(request('[::1]:4317', 4317, '::1')))
      .toBe(true)
    expect(hasAllowedLocalRequest(request('127.0.0.1:4317', 4317, '192.168.1.20')))
      .toBe(false)
    expect(hasAllowedLocalRequest(request('evil.example:4317', 4317, '127.0.0.1')))
      .toBe(false)
  })

  it('rejects cross-origin browser mutations even without a browser session', () => {
    const mutation = {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
    } as IncomingMessage
    expect(hasAllowedBrowserMutation(
      mutation,
      'http://127.0.0.1:4317',
    )).toBe(false)
    expect(hasAllowedBrowserMutation({
      ...mutation,
      headers: {
        origin: 'http://127.0.0.1:4317',
        'sec-fetch-site': 'same-origin',
      },
    } as IncomingMessage, 'http://127.0.0.1:4317')).toBe(true)
  })
})
