import { promises as fs } from 'node:fs'

export interface JsonlRow<T> {
  line: number
  value: T
}

export interface JsonlRead<T> {
  rows: JsonlRow<T>[]
  nextOffset: number
  nextLine: number
}

export function parseJsonlRows<T>(source: string): JsonlRow<T>[] {
  const lines = source.split(/\r?\n/)
  if (lines.at(-1)?.trim() === '') lines.pop()
  if (!/\r?\n$/.test(source) && lines.length > 0) {
    try {
      JSON.parse(lines.at(-1)!)
    } catch {
      lines.pop()
    }
  }
  return lines.flatMap((line, index) => {
    if (line.trim() === '') return []
    try {
      return [{ line: index + 1, value: JSON.parse(line) as T }]
    } catch (error) {
      throw new Error(`invalid JSON at line ${index + 1}: ${(error as Error).message}`)
    }
  })
}

export async function readJsonlRows<T>(file: string): Promise<JsonlRow<T>[]> {
  return parseJsonlRows<T>(await fs.readFile(file, 'utf8'))
}

export async function readJsonlRowsFrom<T>(
  file: string,
  offset = 0,
  startingLine = 1,
): Promise<JsonlRead<T>> {
  const handle = await fs.open(file, 'r')
  try {
    const stat = await handle.stat()
    if (offset < 0 || offset > stat.size) {
      throw new Error(`invalid JSONL byte offset: ${offset}`)
    }
    const buffer = Buffer.alloc(stat.size - offset)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    const available = buffer.subarray(0, bytesRead)
    const lastNewline = available.lastIndexOf(0x0a)
    const completeBytes = lastNewline + 1
    const complete = available.subarray(0, completeBytes).toString('utf8')
    const rows = complete === ''
      ? []
      : parseJsonlRows<T>(complete).map(row => ({
          ...row,
          line: row.line + startingLine - 1,
        }))
    const newlineCount = available.subarray(0, completeBytes)
      .reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0)
    return {
      rows,
      nextOffset: offset + completeBytes,
      nextLine: startingLine + newlineCount,
    }
  } finally {
    await handle.close()
  }
}
