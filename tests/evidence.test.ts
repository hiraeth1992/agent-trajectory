import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseJsonlRows } from '../server/parsers/jsonl'
import { projectCodexTrajectory, type CodexEnvelope } from '../server/projectors/codex'
import {
  projectZcodeTrajectory,
  type ZcodeProjectionInput,
} from '../server/projectors/zcode'
import { parseDshJsonl } from '../server/sources/dsh'
import {
  buildVerification,
  parseVerificationArguments,
  writeVerification,
} from '../scripts/verify-real-sources'
import { projectTrajectory } from '../src/projector'
import type { SourceId, TrajectoryProjection } from '../src/types'

const fixturesRoot = path.resolve('tests/fixtures')

describe('real-source verification evidence', () => {
  it('requires all source ids when reproducible session selection is requested', () => {
    expect(parseVerificationArguments([])).toEqual({
      selectionMode: 'latest',
      sessions: {},
    })
    expect(parseVerificationArguments([
      '--dsh-session', 'dsh-1',
      '--codex-session', 'codex-1',
      '--zcode-session', 'zcode-1',
      '--output', 'evidence.json',
    ])).toEqual({
      selectionMode: 'explicit',
      sessions: {
        dsh: 'dsh-1',
        codex: 'codex-1',
        zcode: 'zcode-1',
      },
      output: path.resolve('evidence.json'),
    })
    expect(() => parseVerificationArguments([
      '--dsh-session', 'dsh-1',
    ])).toThrow(/all three source session ids/i)
  })

  it('rejects DSH and ZCode projections that lose evidenced turns', () => {
    const projection = (
      source: SourceId,
      eventTypeCounts: Record<string, number>,
    ): TrajectoryProjection => ({
      header: {
        source,
        format: 'test',
        id: `${source}-test`,
        createdAt: 1,
      },
      records: [],
      turns: [],
      lanes: [],
      startTime: 1,
      endTime: 1,
      eventCount: 1,
      eventTypeCounts,
      unknownEventTypes: [],
      turnEnds: {},
    })
    const input = (source: SourceId, eventTypeCounts: Record<string, number>) => ({
      source,
      sourceSessionId: `${source}-test`,
      digestInput: source,
      projection: projection(source, eventTypeCounts),
    })
    const codex = input('codex', {})

    expect(() => buildVerification([
      input('dsh', { 'turn/start': 1 }),
      codex,
      input('zcode', {}),
    ])).toThrow('dsh projection has turn evidence but no turns')
    expect(() => buildVerification([
      input('dsh', {}),
      codex,
      input('zcode', { 'turn_usage/completed': 1 }),
    ])).toThrow('zcode projection has turn evidence but no turns')
  })

  it('keeps an overwritten evidence file private', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'trajectory-evidence-'))
    const output = path.join(directory, 'verification.json')
    try {
      await fs.writeFile(output, 'old evidence\n', { mode: 0o644 })
      await writeVerification(output, '{"selectionMode":"explicit"}\n')

      expect((await fs.stat(output)).mode & 0o777).toBe(0o600)
      expect(await fs.readFile(output, 'utf8')).toBe('{"selectionMode":"explicit"}\n')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('summarizes anonymous fixtures as counts and fixed SHA-256 digests only', async () => {
    const [dshText, codexText, zcodeText] = await Promise.all([
      fs.readFile(path.join(fixturesRoot, 'dsh-session-v4.jsonl'), 'utf8'),
      fs.readFile(path.join(fixturesRoot, 'codex-rollout.jsonl'), 'utf8'),
      fs.readFile(path.join(fixturesRoot, 'zcode-session.json'), 'utf8'),
    ])
    const dsh = parseDshJsonl(dshText)
    const verification = buildVerification([
      {
        source: 'dsh',
        sourceSessionId: 'fixture-dsh',
        digestInput: dshText,
        projection: projectTrajectory(dsh.header, dsh.events),
      },
      {
        source: 'codex',
        sourceSessionId: 'fixture-codex',
        digestInput: codexText,
        projection: projectCodexTrajectory(
          parseJsonlRows<CodexEnvelope>(codexText).map(row => row.value),
        ),
      },
      {
        source: 'zcode',
        sourceSessionId: 'fixture-zcode',
        digestInput: zcodeText,
        projection: projectZcodeTrajectory(JSON.parse(zcodeText) as ZcodeProjectionInput),
      },
    ], new Date('2026-10-21T00:00:00.000Z'), 'explicit')

    expect(verification).toEqual({
      generatedAt: '2026-10-21T00:00:00.000Z',
      contentPolicy: 'counts-and-sha256-only',
      selectionMode: 'explicit',
      dsh: {
        sourceSessionSha256: 'ca2478ff98ecaf328c73313ea25848f4ecc0136e1db0e2bfcb2ac99f16f5875a',
        sha256: 'd809afb986311a4c573410813ab97098b324ee55bf2900ac7cd07ac7c05cbc31',
        events: 8,
        records: 3,
        kinds: { user: 1, assistant: 1, tool: 1 },
        turns: 1,
        completedTurns: 1,
        tools: 1,
        nestedTools: 0,
        usagePresent: true,
        unknownEventTypes: 0,
      },
      codex: {
        sourceSessionSha256: 'ba1511b445d26ef8c772b2cc76bf8af97415c66ac9f874030c1ffb1c24d961f5',
        sha256: '9ecd6332af7e10885b375240ed23804ecdb0e56a643108f45c79d865e78c401a',
        events: 9,
        records: 3,
        kinds: { user: 1, assistant: 1, tool: 1 },
        turns: 1,
        completedTurns: 1,
        tools: 1,
        nestedTools: 0,
        usagePresent: true,
        unknownEventTypes: 0,
      },
      zcode: {
        sourceSessionSha256: '8f65bbd2eb5f53f37f24a558f9f8b9c198c6110c1261a7e15ddc509c63863ffe',
        sha256: 'dfd70a5a2be299039d82988010a1dff0ce269ddc21c1f0741f12dbf5310fb4f1',
        events: 6,
        records: 2,
        kinds: { user: 1, assistant: 1 },
        turns: 1,
        completedTurns: 1,
        tools: 0,
        nestedTools: 0,
        usagePresent: true,
        unknownEventTypes: 0,
      },
    })
    const serialized = JSON.stringify(verification)
    expect(serialized).not.toMatch(
      /sample inspection|\/workspace|\/Users\/|\/home\/|credentials|authorization|cookie|api[_-]?key/i,
    )
  })
})
