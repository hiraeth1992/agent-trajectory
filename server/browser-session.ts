import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

const LAUNCH_PARAMETER = 'launch'
const COOKIE_NAME = 'agent_trajectory'

function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

function sameToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes)
}

function cookieValue(request: IncomingMessage): string | undefined {
  const cookies = request.headers.cookie?.split(';') ?? []
  for (const cookie of cookies) {
    const [name, ...value] = cookie.trim().split('=')
    if (name === COOKIE_NAME) return value.join('=')
  }
  return undefined
}

export class BrowserSession {
  private readonly sessionToken = randomToken()
  private readonly launchTokens = new Set<string>()

  createLaunchUrl(baseUrl: string, pathname = '/'): string {
    const url = new URL(pathname, baseUrl)
    const token = randomToken()
    this.launchTokens.add(token)
    if (this.launchTokens.size > 64) {
      this.launchTokens.delete(this.launchTokens.values().next().value!)
    }
    url.searchParams.set(LAUNCH_PARAMETER, token)
    return url.href
  }

  authorize(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): 'allowed' | 'handled' | 'rejected' {
    const launchToken = url.searchParams.get(LAUNCH_PARAMETER)
    if (request.method === 'GET' && url.pathname === '/' && launchToken !== null) {
      if (!this.launchTokens.delete(launchToken)) return 'rejected'
      url.searchParams.delete(LAUNCH_PARAMETER)
      response.writeHead(302, {
        Location: `${url.pathname}${url.search}${url.hash}`,
        'Cache-Control': 'no-store',
        'Set-Cookie': [
          `${COOKIE_NAME}=${this.sessionToken}`,
          'HttpOnly',
          'SameSite=Strict',
          'Path=/',
        ].join('; '),
      })
      response.end()
      return 'handled'
    }
    const cookie = cookieValue(request)
    return cookie !== undefined && sameToken(cookie, this.sessionToken)
      ? 'allowed'
      : 'rejected'
  }

  allowsMutation(request: IncomingMessage, expectedOrigin: string): boolean {
    if (request.method === 'GET' || request.method === 'HEAD') return true
    const origin = request.headers.origin
    const fetchSite = request.headers['sec-fetch-site']
    return origin === expectedOrigin
      && (fetchSite === undefined || fetchSite === 'same-origin')
  }
}
