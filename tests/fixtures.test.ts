import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseJsonlRows } from '../server/parsers/jsonl'
import { projectCodexTrajectory, type CodexEnvelope } from '../server/projectors/codex'
import {
  projectZcodeTrajectory,
  type ZcodeProjectionInput,
} from '../server/projectors/zcode'
import { parseDshJsonl } from '../server/sources/dsh'
import { projectTrajectory } from '../src/projector'

const fixturesRoot = path.resolve('tests/fixtures')

describe('anonymous source fixtures', () => {
  it('projects representative DSH, Codex, and ZCode source shapes', async () => {
    const [dshText, codexText, zcodeText] = await Promise.all([
      fs.readFile(path.join(fixturesRoot, 'dsh-session-v4.jsonl'), 'utf8'),
      fs.readFile(path.join(fixturesRoot, 'codex-rollout.jsonl'), 'utf8'),
      fs.readFile(path.join(fixturesRoot, 'zcode-session.json'), 'utf8'),
    ])

    const dsh = parseDshJsonl(dshText)
    const projections = [
      projectTrajectory(dsh.header, dsh.events),
      projectCodexTrajectory(
        parseJsonlRows<CodexEnvelope>(codexText).map(row => row.value),
      ),
      projectZcodeTrajectory(JSON.parse(zcodeText) as ZcodeProjectionInput),
    ]

    expect(projections.map(projection => projection.header.source))
      .toEqual(['dsh', 'codex', 'zcode'])
    projections.forEach((projection) => {
      expect(projection.records.some(record => record.kind === 'user')).toBe(true)
      expect(projection.records.some(record => record.kind === 'assistant')).toBe(true)
      expect(projection.unknownEventTypes).toEqual([])
    })
    expect(projections[0].records.some(record => record.kind === 'tool')).toBe(true)
    expect(projections[1].records.some(record => record.kind === 'tool')).toBe(true)
  })

  it('contains no home-directory paths or credential-shaped values', async () => {
    const files = await fs.readdir(fixturesRoot)
    const contents = await Promise.all(files.map(file =>
      fs.readFile(path.join(fixturesRoot, file), 'utf8')))
    const combined = contents.join('\n')

    expect(combined).not.toMatch(/\/Users\/|\/home\/|credentials|authorization|cookie|api[_-]?key/i)
  })
})
