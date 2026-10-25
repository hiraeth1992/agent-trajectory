import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SummaryCache } from '../server/summary/cache'
import type { ValidatedAiSummary } from '../src/ai-summary-types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

function summary(model: string): ValidatedAiSummary {
  return {
    modules: {},
    lastRun: {
      modules: [],
      generatedAt: 1,
      adapterId: 'fake',
      model,
      promptVersion: 4,
    },
    durationMs: 1,
  }
}

describe('SummaryCache', () => {
  it('preserves concurrent session updates in memory and on disk', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-cache-race-'))
    roots.push(root)
    const file = path.join(root, 'cache.json')
    const cache = new SummaryCache(file)

    await Promise.all([
      cache.set('codex', 'first', summary('model-a')),
      cache.set('codex', 'second', summary('model-b')),
    ])

    expect((await cache.get('codex', 'first'))?.lastRun.model).toBe('model-a')
    expect((await cache.get('codex', 'second'))?.lastRun.model).toBe('model-b')
    const restored = new SummaryCache(file)
    expect((await restored.get('codex', 'first'))?.lastRun.model).toBe('model-a')
    expect((await restored.get('codex', 'second'))?.lastRun.model).toBe('model-b')
  })
})
