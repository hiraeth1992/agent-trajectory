import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export class SerialTransaction {
  private tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

const sharedTransactions = new Map<string, SerialTransaction>()

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function staleLock(file: string): Promise<boolean> {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as {
      pid?: unknown
    }
    return typeof value.pid !== 'number'
      || !Number.isInteger(value.pid)
      || value.pid <= 0
      || !processExists(value.pid)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    if (error instanceof SyntaxError) {
      const stat = await fs.stat(file).catch(() => undefined)
      return stat === undefined || Date.now() - stat.mtimeMs > 10_000
    }
    throw error
  }
}

async function withCrossProcessLock<T>(
  target: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = `${target}.lock`
  await fs.mkdir(path.dirname(lock), { recursive: true })
  const token = randomUUID()
  for (let attempt = 0; attempt < 480; attempt++) {
    let handle
    try {
      handle = await fs.open(lock, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify({
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
      })}\n`)
      await handle.close()
      handle = undefined
      try {
        return await operation()
      } finally {
        try {
          const owner = JSON.parse(await fs.readFile(lock, 'utf8')) as {
            token?: unknown
          }
          if (owner.token === token) await fs.rm(lock, { force: true })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    } catch (error) {
      await handle?.close().catch(() => {})
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await staleLock(lock)) {
        await fs.rm(lock, { force: true })
        continue
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  throw new Error(`timed out acquiring file transaction: ${target}`)
}

export function runFileTransaction<T>(
  file: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(file)
  let transaction = sharedTransactions.get(key)
  if (transaction === undefined) {
    transaction = new SerialTransaction()
    sharedTransactions.set(key, transaction)
  }
  return transaction.run(() => withCrossProcessLock(key, operation))
}

export async function writePrivateJson(
  file: string,
  value: unknown,
): Promise<void> {
  await writePrivateText(file, `${JSON.stringify(value, null, 2)}\n`)
}

export async function writePrivateText(
  file: string,
  value: string,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, value, {
      mode: 0o600,
    })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
}

export async function writePrivateJsonExclusive(
  file: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
}
