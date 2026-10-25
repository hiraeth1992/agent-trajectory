import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface RuntimeState {
  hookToken: string
  pid: number
  startedAt: string
  url: string
}

export function runtimeStateFile(dataRoot: string): string {
  return path.join(dataRoot, 'runtime.json')
}

export function runtimeLockFile(dataRoot: string): string {
  return path.join(dataRoot, 'runtime.lock')
}

interface RuntimeLockOwner {
  pid: number
  token: string
  startedAt: string
}

export interface RuntimeLock {
  release(): Promise<void>
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function lockOwner(value: unknown): RuntimeLockOwner | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  return typeof source.pid === 'number'
    && Number.isInteger(source.pid)
    && source.pid > 0
    && typeof source.token === 'string'
    && source.token !== ''
    && typeof source.startedAt === 'string'
    ? {
        pid: source.pid,
        token: source.token,
        startedAt: source.startedAt,
      }
    : undefined
}

async function existingLockIsStale(file: string): Promise<boolean> {
  try {
    const [contents, stat] = await Promise.all([
      fs.readFile(file, 'utf8'),
      fs.stat(file),
    ])
    const owner = lockOwner(JSON.parse(contents))
    if (owner !== undefined) return !processExists(owner.pid)
    return Date.now() - stat.mtimeMs > 10_000
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    if (error instanceof SyntaxError) {
      const stat = await fs.stat(file).catch(() => undefined)
      return stat === undefined || Date.now() - stat.mtimeMs > 10_000
    }
    throw error
  }
}

export async function acquireRuntimeLock(
  dataRoot: string,
): Promise<RuntimeLock | undefined> {
  const file = runtimeLockFile(dataRoot)
  await fs.mkdir(path.dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = randomBytes(24).toString('base64url')
    let handle
    try {
      handle = await fs.open(file, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify({
        pid: process.pid,
        token,
        startedAt: new Date().toISOString(),
      }, null, 2)}\n`)
      await handle.close()
      handle = undefined
      let released = false
      return {
        async release() {
          if (released) return
          released = true
          try {
            const owner = lockOwner(JSON.parse(await fs.readFile(file, 'utf8')))
            if (owner?.token === token) await fs.rm(file, { force: true })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        },
      }
    } catch (error) {
      await handle?.close().catch(() => {})
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!await existingLockIsStale(file)) return undefined
      await fs.rm(file, { force: true })
    }
  }
  return undefined
}

function validState(value: unknown): RuntimeState | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  if (typeof source.pid !== 'number'
    || !Number.isInteger(source.pid)
    || source.pid <= 0
    || typeof source.url !== 'string'
    || typeof source.hookToken !== 'string'
    || typeof source.startedAt !== 'string') return undefined
  let url: URL
  try {
    url = new URL(source.url)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:'
    || (url.hostname !== '127.0.0.1'
      && url.hostname !== 'localhost'
      && url.hostname !== '[::1]')) return undefined
  return {
    pid: source.pid,
    url: url.origin,
    hookToken: source.hookToken,
    startedAt: source.startedAt,
  }
}

export async function readRuntimeState(dataRoot: string): Promise<RuntimeState | undefined> {
  try {
    return validState(JSON.parse(
      await fs.readFile(runtimeStateFile(dataRoot), 'utf8'),
    ))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT'
      || error instanceof SyntaxError) return undefined
    throw error
  }
}

export async function writeRuntimeState(
  dataRoot: string,
  state: RuntimeState,
): Promise<void> {
  const file = runtimeStateFile(dataRoot)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  })
  await fs.rename(temporary, file)
}

export async function removeRuntimeState(
  dataRoot: string,
  pid: number,
): Promise<void> {
  const current = await readRuntimeState(dataRoot)
  if (current?.pid !== pid) return
  await fs.rm(runtimeStateFile(dataRoot), { force: true })
}

export async function requestRuntime(
  state: RuntimeState,
  pathname:
    | '/api/integrations/ping'
    | '/api/integrations/session-start'
    | '/api/integrations/show',
  body?: unknown,
  source?: string,
): Promise<Response> {
  return fetch(new URL(pathname, state.url), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${state.hookToken}`,
      'Content-Type': 'application/json',
      ...(source === undefined
        ? {}
        : { 'X-Agent-Trajectory-Source': source }),
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(2_000),
  })
}
