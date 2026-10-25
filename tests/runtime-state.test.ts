import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireRuntimeLock,
  runtimeLockFile,
} from '../server/runtime-state'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

describe('runtime instance lock', () => {
  it('allows only one owner and lets the owner release the lock', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-lock-'))
    roots.push(root)

    const first = await acquireRuntimeLock(root)
    const second = await acquireRuntimeLock(root)

    expect(first).toBeDefined()
    expect(second).toBeUndefined()
    await first!.release()
    expect(await acquireRuntimeLock(root)).toBeDefined()
  })

  it('recovers a lock whose owner process no longer exists', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-stale-lock-'))
    roots.push(root)
    await fs.writeFile(runtimeLockFile(root), `${JSON.stringify({
      pid: 2_147_483_647,
      token: 'stale-owner',
      startedAt: new Date(0).toISOString(),
    })}\n`)

    const lock = await acquireRuntimeLock(root)

    expect(lock).toBeDefined()
    await lock!.release()
  })
})
