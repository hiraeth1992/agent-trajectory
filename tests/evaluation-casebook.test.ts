import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EvaluationCasebookStore } from '../server/evaluation/casebook'
import { MINIMAL_GOLD_DATASET } from '../server/evaluation/gold-dataset'
import { runEvaluationDataset } from '../server/evaluation/runner'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

describe('evaluation badcase casebook', () => {
  it('deduplicates observations, records decisions, and resolves fixed cases', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'trajectory-casebook-'))
    roots.push(root)
    const store = new EvaluationCasebookStore(path.join(root, 'casebook.json'))
    const baseline = runEvaluationDataset(MINIMAL_GOLD_DATASET, {
      createdAt: '2026-10-25T00:00:00.000Z',
    })
    const failing = structuredClone(baseline)
    const selected = failing.cases[0]!
    selected.assertions[0]!.passed = false
    selected.assertionsPassed--
    selected.mismatches = [{
      criterionId: selected.assertions[0]!.subject,
      expected: selected.assertions[0]!.expected,
      actual: 'fail',
    }]
    failing.runId = 'failing-run'
    failing.createdAt = '2026-10-25T00:01:00.000Z'

    const first = await store.syncRun(failing)
    expect(first.entries).toHaveLength(1)
    const entry = first.entries[0]!
    expect(entry).toMatchObject({
      caseId: selected.caseId,
      subject: selected.assertions[0]!.subject,
      status: 'open',
      observations: 1,
      firstSeenRunId: 'failing-run',
      lastSeenRunId: 'failing-run',
    })
    expect(JSON.stringify(first)).not.toContain(selected.results[0]!.summary)

    const repeated = structuredClone(failing)
    repeated.runId = 'failing-run-2'
    repeated.createdAt = '2026-10-25T00:02:00.000Z'
    const second = await store.syncRun(repeated)
    expect(second.entries).toHaveLength(1)
    expect(second.entries[0]).toMatchObject({
      observations: 2,
      lastSeenRunId: 'failing-run-2',
    })

    const decided = await store.decide(
      entry.id,
      'accepted',
      'Apply the evaluator correction.',
      '2026-10-25T00:03:00.000Z',
    )
    expect(decided.entries[0]?.decision).toEqual({
      value: 'accepted',
      decidedAt: '2026-10-25T00:03:00.000Z',
      note: 'Apply the evaluator correction.',
    })

    const fixed = structuredClone(baseline)
    fixed.runId = 'fixed-run'
    fixed.createdAt = '2026-10-25T00:04:00.000Z'
    const resolved = await store.recordRetest(entry.id, fixed)
    expect(resolved.entries[0]).toMatchObject({
      status: 'resolved',
      retests: [{ runId: 'fixed-run', outcome: 'fixed' }],
    })

    const incompatible = structuredClone(fixed)
    incompatible.runId = 'incompatible-run'
    incompatible.datasetHash = '0'.repeat(64)
    const inconclusive = await store.recordRetest(entry.id, incompatible)
    expect(inconclusive.entries[0]?.retests).toContainEqual(expect.objectContaining({
      runId: 'incompatible-run',
      outcome: 'inconclusive',
    }))
  })

  it('automatically resolves previously open subjects when a later run passes', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'trajectory-casebook-'))
    roots.push(root)
    const store = new EvaluationCasebookStore(path.join(root, 'casebook.json'))
    const passing = runEvaluationDataset(MINIMAL_GOLD_DATASET, {
      createdAt: '2026-10-25T00:00:00.000Z',
    })
    const failing = structuredClone(passing)
    failing.runId = 'failing-run'
    failing.cases[0]!.mismatches = [{
      criterionId: 'outcome',
      expected: 'pass',
      actual: 'fail',
    }]
    await store.syncRun(failing)

    const crashed = structuredClone(passing)
    crashed.runId = 'crashed-run'
    crashed.createdAt = '2026-10-25T00:05:00.000Z'
    crashed.cases[0]!.error = 'evaluator crashed'
    crashed.cases[0]!.mismatches = []
    crashed.cases[0]!.results = [{
      ...crashed.cases[0]!.results[0]!,
      criterionId: 'evaluation-run',
      verdict: 'evaluator_error',
    }]
    const afterCrash = await store.syncRun(crashed)
    expect(afterCrash.entries.find(entry => entry.subject === 'outcome'))
      .toMatchObject({ status: 'open' })

    const resolved = await store.syncRun({
      ...passing,
      runId: 'passing-run',
      createdAt: '2026-10-25T00:10:00.000Z',
    })
    expect(resolved.entries[0]).toMatchObject({
      status: 'resolved',
      lastSeenRunId: 'passing-run',
    })
  })
})
