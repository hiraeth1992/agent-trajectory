import { createReadStream, promises as fs } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import type { ViteDevServer } from 'vite'
import { handleApi, sendError, sendJson } from './api'
import { projectionWorker } from './projection-worker-client'
import { assertLoopbackListenHost, hasAllowedLocalRequest } from './security'
import { sourceRegistry } from './sources/registry'
import { zcodeSource } from './sources/zcode'

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join('; ')

export interface AgentTrajectoryServerOptions {
  development?: boolean
  host?: string
  port?: number
  root: string
  staticRoot?: string
}

export interface AgentTrajectoryServer {
  close(): Promise<void>
  host: string
  port: number
  server: Server
  url: string
}

function selectedPort(port: number | undefined): number {
  const value = port ?? 4317
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`PORT must be an integer from 0 to 65535, received ${value}`)
  }
  return value
}

async function serveBuilt(
  response: ServerResponse,
  pathname: string,
  staticRoot: string,
): Promise<void> {
  const root = path.resolve(staticRoot)
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  let file = path.resolve(root, relative)
  if (!file.startsWith(`${root}${path.sep}`)) {
    sendJson(response, 403, { error: 'forbidden' })
    return
  }
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) throw new Error('not a file')
  } catch {
    file = path.join(root, 'index.html')
  }
  response.writeHead(200, {
    'Content-Security-Policy': contentSecurityPolicy,
    'Content-Type': mimeTypes[path.extname(file)] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  })
  createReadStream(file).pipe(response)
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('local server did not expose a TCP address'))
        return
      }
      resolve(address.port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => error === undefined ? resolve() : reject(error))
  })
}

export async function startAgentTrajectoryServer(
  options: AgentTrajectoryServerOptions,
): Promise<AgentTrajectoryServer> {
  const host = assertLoopbackListenHost(options.host)
  const development = options.development ?? false
  const staticRoot = options.staticRoot ?? path.join(options.root, 'dist')
  let vite: ViteDevServer | undefined
  if (development) {
    const { createServer: createViteServer } = await import('vite')
    vite = await createViteServer({
      root: options.root,
      server: { middlewareMode: true },
      appType: 'spa',
    })
  }

  const server = createServer((request, response) => {
    void (async () => {
      if (!hasAllowedLocalRequest(request)) {
        sendJson(response, 403, { error: 'forbidden local request' })
        return
      }
      const address = server.address()
      const fallbackPort = address !== null && typeof address !== 'string'
        ? address.port
        : selectedPort(options.port)
      const url = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? `${host}:${fallbackPort}`}`,
      )
      if (await handleApi(request, response, url, { registry: sourceRegistry })) return
      if (vite !== undefined) {
        vite.middlewares(request, response, () => {
          sendJson(response, 404, { error: 'not found' })
        })
        return
      }
      await serveBuilt(response, url.pathname, staticRoot)
    })().catch(error => sendError(response, 500, error))
  })

  try {
    const port = await listen(server, selectedPort(options.port), host)
    let closed = false
    return {
      host,
      port,
      server,
      url: `http://${host}:${port}`,
      async close() {
        if (closed) return
        closed = true
        await Promise.allSettled([
          closeHttpServer(server),
          vite?.close() ?? Promise.resolve(),
          zcodeSource.close(),
          projectionWorker.close(),
        ])
      },
    }
  } catch (error) {
    await vite?.close()
    throw error
  }
}
