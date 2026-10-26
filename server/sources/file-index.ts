import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SourceListFailure } from './types'

export interface FileWalkResult {
  files: string[]
  failures: SourceListFailure[]
}

export function fileStatSignature(
  stat: Awaited<ReturnType<typeof fs.stat>>,
): string {
  return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
}

export async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('concurrency limit must be a positive integer')
  }
  const results: PromiseSettledResult<R>[] = new Array(values.length)
  let next = 0
  const worker = async () => {
    while (true) {
      const index = next++
      if (index >= values.length) return
      try {
        results[index] = {
          status: 'fulfilled',
          value: await operation(values[index]!, index),
        }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  )
  return results
}

export async function walkFiles(
  root: string,
  accept: (file: string, name: string) => boolean,
): Promise<FileWalkResult> {
  const files: string[] = []
  const failures: SourceListFailure[] = []
  const pending = [path.resolve(root)]
  while (pending.length > 0) {
    const directory = pending.shift()!
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      failures.push({
        locator: directory,
        reason: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) pending.push(absolute)
      else if (entry.isFile() && accept(absolute, entry.name)) files.push(absolute)
    }
  }
  files.sort()
  return { files, failures }
}
