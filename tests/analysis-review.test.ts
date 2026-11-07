import { describe, expect, it } from 'vitest'
import { buildReviewSteps } from '../src/analysis-review'
import { buildTrajectoryStory } from '../src/trajectory-story'
import { analyzeTrajectory, type TrajectoryAnalysis } from '../src/trajectory-analysis'
import { capabilities } from '../server/sources/types'
import type { SessionDetail, TrajectoryRecord } from '../src/types'

function record(id: string, step: number, extra: Partial<TrajectoryRecord> = {}): TrajectoryRecord {
  return { id, source: 'zcode', sourceEventIds: [id], fidelity: 'exact',
    seq: step, turn: 1, step, kind: 'tool', title: 'exec_command', summary: id,
    startTime: step * 1_000, endTime: step * 1_000 + 100, status: 'complete', depth: 0,
    input: { cmd: 'npm test' }, output: 'Tests 1 passed', searchText: id, ...extra }
}

function detail(records: TrajectoryRecord[]): SessionDetail {
  return {
    summary: { id: 'zcode:test', source: 'zcode', sourceSessionId: 'test', format: 'test',
      capabilities: capabilities('messages', 'tools', 'timing', 'usage'), cwd: '/workspace',
      title: 'Verify the fix', createdAt: 1_000, updatedAt: 5_000, size: 1 },
    projection: { header: { source: 'zcode', format: 'test', id: 'test', createdAt: 1_000 },
      records, turns: [{ id: 'turn-1', number: 1, startTime: 1_000, endTime: 5_000, status: 'complete' }],
      lanes: [], startTime: 1_000, endTime: 5_000, eventCount: records.length,
      eventTypeCounts: {}, unknownEventTypes: [], turnEnds: {} },
  }
}

describe('problem and resource review', () => {
  it('keeps failure evidence and the later fix and validation together without adding their tokens', () => {
    const source = detail([
      record('failed', 1, { status: 'error', error: { code: '1', reason: 'assertion failed' }, usage: { totalTokens: 10 } }),
      record('fix', 2, { title: 'apply_patch', input: '*** Update File: test.ts', output: 'patched' }),
      record('verified', 3, { usage: { totalTokens: 20 } }),
    ])
    const analysis = analyzeTrajectory(source)
    const reviewed = buildReviewSteps(analysis, source.projection.records, source.projection.turns)
    const failed = reviewed.find(item => item.tags.includes('failed'))!
    expect(failed.recordIds).toContain('failed')
    expect(failed.recordIds).toContain('fix')
    expect(failed.recordIds).toContain('verified')
    expect(failed.recovery).toContain('原问题验证通过')
    expect(failed.tags).not.toContain('unresolved')
    expect(failed.tokens).toBe(10)
    expect(analysis.steps.find(step => step.recordId === 'failed')?.usage?.totalTokens).toBe(10)
  })

  it('keeps a failure unconfirmed when only an unrelated later command succeeds', () => {
    const source = detail([
      record('failed', 1, { status: 'error', input: { cmd: 'git ls-remote origin' }, error: { code: '1' } }),
      record('read', 2, { input: { cmd: 'cat README.md' }, output: 'documentation' }),
    ])
    const analysis = analyzeTrajectory(source)
    const failed = buildReviewSteps(analysis, source.projection.records).find(step => step.tags.includes('failed'))!
    expect(failed.tags).toContain('unresolved')
    expect(failed.recovery).toContain('后续执行成功，原问题未验证')
    expect(analysis.stats.recovered).toBe(0)
    expect(analysis.evaluations.find(item => item.id === 'recovery')?.grade).not.toBe('good')
  })

  it('does not claim a completed retry recovered without a recorded result', () => {
    const source = detail([record('retried', 1, { retry: { count: 1 }, output: undefined })])
    const analysis = analyzeTrajectory(source)
    expect(analysis.corrections[0]?.status).toBe('unresolved')
    expect(analysis.stats.recovered).toBe(0)
  })

  it('does not claim retry recovery when its recorded validation output still fails', () => {
    const source = detail([record('retried', 1, { retry: { count: 1 }, output: 'Tests 1 failed' })])
    const analysis = analyzeTrajectory(source)
    expect(analysis.corrections[0]?.status).toBe('unresolved')
    expect(analysis.stats.recovered).toBe(0)
  })

  it('recognizes matching validation inside the same logical step', () => {
    const source = detail([
      record('failed', 1, { seq: 1, status: 'error', error: { code: '1' } }),
      record('verified', 1, { seq: 2 }),
    ])
    const analysis = analyzeTrajectory(source)
    expect(analysis.corrections[0]).toMatchObject({ status: 'recovered', recoveryEvidence: 'validation' })
    expect(buildReviewSteps(analysis, source.projection.records)[0]?.recovery).toContain('原问题验证通过')
  })

  it('does not apply a neighboring failure’s validation to this step', () => {
    const source = detail([
      record('first', 1, { status: 'error', error: { code: '1' }, input: { cmd: 'npm test -- first.test.ts' } }),
      record('second', 2, { status: 'error', error: { code: '1' }, input: { cmd: 'npm test -- second.test.ts' } }),
      record('verified-first', 3, { input: { cmd: 'npm test -- first.test.ts' } }),
    ])
    const reviewed = buildReviewSteps(analyzeTrajectory(source), source.projection.records)
    expect(reviewed.find(step => step.step === 1)?.recovery).toContain('原问题验证通过')
    expect(reviewed.find(step => step.step === 2)?.recovery).not.toContain('原问题验证通过')
    expect(reviewed.find(step => step.step === 2)?.tags).toContain('unresolved')
  })

  it.each([
    ['another test target', { cmd: 'npm test -- other.test.ts' }, 'Tests 1 passed', 1],
    ['another directory', { cmd: 'npm test', workdir: '/other' }, 'Tests 1 passed', 1],
    ['missing output', { cmd: 'npm test' }, undefined, 1],
    ['another turn', { cmd: 'npm test' }, 'Tests 1 passed', 2],
  ] as const)('does not verify the original failure using %s', (_name, input, output, turn) => {
    const source = detail([
      record('failed', 1, { status: 'error', error: { code: '1' } }),
      record('later', 2, { input, output, turn }),
    ])
    const analysis = analyzeTrajectory(source)
    const failed = buildReviewSteps(analysis, source.projection.records).find(step => step.tags.includes('failed'))!
    expect(failed.tags).toContain('unresolved')
    expect(failed.recovery).not.toContain('原问题验证通过')
    expect(analysis.stats.recovered).toBe(0)
  })

  it('keeps cancellation apart from failures, including exit 130 in an explicitly interrupted turn', () => {
    const records = [record('canceled', 1, { status: 'interrupted' }),
      record('exit130', 2, { status: 'error', error: { code: '130' } })]
    const source = detail(records)
    source.projection.turns[0]!.status = 'interrupted'
    const reviewed = buildReviewSteps(analyzeTrajectory(source), records, source.projection.turns)
    expect(reviewed.every(item => !item.tags.includes('failed') && !item.tags.includes('unresolved'))).toBe(true)
    expect(reviewed.filter(item => item.tags.includes('interrupted'))).toHaveLength(2)
    expect(reviewed[0]?.description).toContain('未作为执行失败')
    const story = buildTrajectoryStory(analyzeTrajectory(source), 8, { records, reviewSteps: reviewed })
    expect(story.stages.reduce((total, stage) => total + stage.errorCount, 0)).toBe(0)
    expect(story.stages.reduce((total, stage) => total + stage.interruptedCount, 0)).toBe(2)
    expect(story.stages.every(stage => stage.outcome.includes('中断记录'))).toBe(true)
    const withoutTurnEvidence = buildReviewSteps(analyzeTrajectory(source), records)
    expect(withoutTurnEvidence.find(item => item.recordIds.includes('exit130'))?.tags).toContain('failed')
  })

  it('does not count a source/context error as an execution failure or fill missing timing and usage', () => {
    const records = [record('source-error', 0, { kind: 'context', status: 'error' }),
      record('no-output', 1, { output: undefined, usage: {} })]
    const source = detail(records)
    const reviewed = buildReviewSteps(analyzeTrajectory(source), records, [], capabilities('tools'))
    expect(reviewed).toHaveLength(1)
    expect(reviewed[0]).toMatchObject({ tags: [], durationMs: null })
    expect(reviewed[0]?.tokens).toBeUndefined()
    expect(reviewed[0]?.result).toContain('来源缺少部分工具输出')
    const withTiming = buildReviewSteps(analyzeTrajectory(source), records)
    expect(withTiming).toHaveLength(1)
    expect(withTiming[0]?.description).toContain('来源缺少部分工具输出')
    expect(withTiming[0]?.tokens).toBeUndefined()
    expect(withTiming[0]?.tags).not.toContain('failed')
  })

  it('uses existing retry evidence for repeated failures instead of linking adjacent matching error codes', () => {
    const records = [record('one', 1, { status: 'error', error: { code: '1' } }),
      record('two', 2, { status: 'error', error: { code: '1' } })]
    const analysis = analyzeTrajectory(detail(records))
    analysis.optimizations = []
    expect(buildReviewSteps(analysis, records).every(item => !item.tags.includes('repeated'))).toBe(true)
    analysis.optimizations = [{ id: 'retry', category: 'retry', title: 'Repeated call',
      confidence: 'medium', priority: 'medium', measures: ['workflow'], effort: 'low',
      observation: 'same call failed', cause: 'unknown', action: 'inspect', target: 'tool',
      expectedBenefit: 'fewer failures', verification: 'test', limitation: 'inferred',
      executionActions: [], occurrences: 2,
      evidence: [{ recordId: 'one', turn: 1, step: 1 }, { recordId: 'two', turn: 1, step: 2 }] }]
    expect(buildReviewSteps(analysis, records).filter(item => item.tags.includes('repeated'))).toHaveLength(2)
  })

  it('ranks only positive known values and leaves the outcome and overlapping step totals unchanged', () => {
    const source = detail(Array.from({ length: 7 }, (_, index) => record(`r${index}`, index + 1, {
      usage: { totalTokens: index * 10 }, endTime: (index + 1) * 1_000 + index,
    })))
    const analysis: TrajectoryAnalysis = analyzeTrajectory(source)
    const before = structuredClone(analysis)
    const reviewed = buildReviewSteps(analysis, source.projection.records)
    expect(reviewed.filter(item => item.tags.includes('tokens')).map(item => item.step)).toEqual([3, 4, 5, 6, 7])
    expect(reviewed.filter(item => item.tags.includes('time')).map(item => item.step)).toEqual([3, 4, 5, 6, 7])
    expect(analysis).toEqual(before)
  })
})
