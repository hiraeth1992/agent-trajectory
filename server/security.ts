import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) {
    return normalized.slice('::ffff:'.length).startsWith('127.')
  }
  return isIP(normalized) === 4 && normalized.startsWith('127.')
}

export function assertLoopbackListenHost(host: string | undefined): string {
  const selected = host ?? '127.0.0.1'
  if (selected === 'localhost' || isLoopbackAddress(selected)) return selected
  throw new Error(`HOST must be a loopback address, received ${selected}`)
}

export function hasAllowedLocalRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  const host = request.headers.host
  const localPort = request.socket.localPort
  if (host === undefined || localPort === undefined) return false
  let parsed: URL
  try {
    parsed = new URL(`http://${host}`)
  } catch {
    return false
  }
  const requestedPort = parsed.port === '' ? 80 : Number(parsed.port)
  if (requestedPort !== localPort) return false
  return parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]'
}

export function hasAllowedBrowserMutation(
  request: IncomingMessage,
  expectedOrigin: string,
): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return true
  const origin = request.headers.origin
  const fetchSite = request.headers['sec-fetch-site']
  if (origin === undefined && fetchSite === undefined) return true
  return origin === expectedOrigin
    && (fetchSite === undefined || fetchSite === 'same-origin')
}
