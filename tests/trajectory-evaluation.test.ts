import { describe, expect, it } from 'vitest'
import { capabilities, sessionKey } from '../server/sources/types'
import type {
  EvaluationTargetRef,
} from '../src/evaluation-types'
import { analyzeTrajectory } from '../src/trajectory-analysis'
import {
  aggregateEvaluationResults,
  buildChainResult,
  buildFactsQualityReport,
  evaluateTrajectory,
} from '../src/trajectory-evaluation'
import type {
  SessionDetail,
  SessionSummary,
  SourceStatus,
  TrajectoryRecord,
} from '../src/types'

function summary(): SessionSummary {
  return {
    id: sessionKey('zcode', 'evaluation-session'),
    source: 'zcode',
    sourceSessionId: 'evaluation-session',
    format: 'test',
    capabilities: capabilities('messages', 'tools', 'timing', 'usage', 'trace'),
    cwd: '/workspace',
    title: 'Evaluation session',
    createdAt: 1_000,
    updatedAt: 7_000,
    size: 1,
  }
}

function record(
  id: string,
  overrides: Partial<TrajectoryRecord> = {},
): TrajectoryRecord {
  return {
    id,
    source: 'zcode',
    sourceEventIds: [id],
    fidelity: 'exact',
    seq: 1,
    turn: 1,
    step: 1,
    kind: 'tool',
    title: 'exec_command',
    summary: id,
    startTime: 1_000,
    endTime: 2_000,
    status: 'complete',
    depth: 0,
    input: { cmd: 'npm test' },
    output: 'Tests 2 passed',
    searchText: id,
    ...overrides,
  }
}

function detail(records: TrajectoryRecord[]): SessionDetail {
  const value = summary()
  const turnNumbers = [...new Set(records.map(item => item.turn))].sort((a, b) => a - b)
  return {
    summary: value,
    projection: {
      header: {
        source: value.source,
        format: value.format,
        id: value.sourceSessionId,
        createdAt: value.createdAt,
      },
      records,
      turns: turnNumbers.map(number => ({
        id: `turn-${number}`,
        number,
        startTime: number * 1_000,
        endTime: number * 1_000 + 500,
        status: 'complete',
      })),
      lanes: [],
      startTime: 1_000,
      endTime: 7_000,
      eventCount: records.length,
      eventTypeCounts: {},
      unknownEventTypes: [],
      turnEnds: Object.fromEntries(turnNumbers.map(number => [
        number,
        { time: number * 1_000 + 500, reason: 'complete' },
      ])),
    },
  }
}

const target: EvaluationTargetRef = {
  source: 'zcode',
  sourceSessionId: 'evaluation-session',
  mode: 'frozen',
  fingerprint: 'fixture-v1',
  snapshotId: 'snapshot-fixture-v1',
}

const status: SourceStatus = {
  source: 'zcode',
  availability: 'available',
  label: 'ZCode',
  colorToken: 'amber',
  iconToken: 'terminal',
  sessionCount: 1,
  capabilities: summary().capabilities,
  protocol: {
    detected: 'zcode-sqlite-v1',
    supported: ['zcode-sqlite-v1'],
    fingerprint: 'protocol-v1',
  },
}

describe('trajectory evaluation contract', () => {
  it('maps local analysis into versioned verdicts with isolated denominators', () => {
    const value = detail([
      record('user-1', {
        seq: 1,
        kind: 'user',
        title: '用户',
        summary: '修复测试并验证',
        input: [{ type: 'text', text: '修复测试并验证' }],
        output: undefined,
      }),
      record('test-1', { seq: 2 }),
    ])
    value.projection.usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
    const evaluation = evaluateTrajectory(value, analyzeTrajectory(value), {
      target,
      sourceStatus: status,
    })

    expect(evaluation).toMatchObject({
      schemaVersion: 1,
      evaluatorId: 'local-trajectory',
      evaluatorVersion: '1',
      factsSchemaVersion: 1,
      target,
      factsQuality: { ready: true },
    })
    expect(evaluation.results.find(result => result.criterionId === 'outcome'))
      .toMatchObject({
        verdict: 'pass',
        denominatorEligible: true,
        attribution: 'agent',
        evidenceRecordIds: ['test-1'],
      })
    expect(evaluation.results.find(result => result.criterionId === 'recovery'))
      .toMatchObject({
        verdict: 'not_applicable',
        denominatorEligible: false,
        attribution: 'not_applicable',
      })
    expect(aggregateEvaluationResults(evaluation.results)).toMatchObject({
      total: 5,
      pass: 2,
      notApplicable: 1,
      denominatorEligible: 3,
    })
  })

  it('short-circuits affected criteria when facts are truncated or tools lack results', () => {
    const value = detail([
      record('user-1', {
        kind: 'user',
        title: '用户',
        summary: '检查结果',
        input: [{ type: 'text', text: '检查结果' }],
        output: undefined,
      }),
      record('tool-1', {
        seq: 2,
        output: undefined,
      }),
      record('tool-2', {
        seq: 3,
        input: {
          truncated: true,
          originalBytes: 100_000,
          preview: 'partial',
        },
      }),
    ])
    const evaluation = evaluateTrajectory(value, analyzeTrajectory(value), {
      target,
      sourceStatus: status,
    })
    const outcome = evaluation.results.find(result => result.criterionId === 'outcome')

    expect(evaluation.factsQuality).toMatchObject({
      ready: false,
      stats: {
        truncatedRecords: 1,
        toolRecordsMissingOutput: 1,
      },
      blockedCriterionIds: expect.arrayContaining(['outcome', 'reliability', 'recovery']),
    })
    expect(outcome).toMatchObject({
      verdict: 'insufficient_evidence',
      denominatorEligible: false,
      attribution: 'source',
      blockedBy: expect.arrayContaining([
        'truncated-record-values',
        'tool-result-missing',
      ]),
    })
    expect(aggregateEvaluationResults(evaluation.results).fail).toBe(0)
  })

  it('changes the facts hash when a source quality boundary changes', () => {
    const value = detail([
      record('user-1', {
        kind: 'user',
        title: '用户',
        summary: '运行测试',
        input: [{ type: 'text', text: '运行测试' }],
        output: undefined,
      }),
      record('test-1', { seq: 2 }),
    ])
    const analysis = analyzeTrajectory(value)
    const available = evaluateTrajectory(value, analysis, {
      target,
      sourceStatus: status,
    })
    const degraded = evaluateTrajectory(value, analysis, {
      target,
      sourceStatus: {
        ...status,
        availability: 'degraded',
        reason: 'protocol-fields-partial',
      },
    })

    expect(degraded.factsHash).not.toBe(available.factsHash)
    expect(degraded.factsQuality.issues).toContainEqual(expect.objectContaining({
      id: 'source-protocol-degraded',
    }))
  })

  it('does not infer per-requirement completion from one overall outcome', () => {
    const value = detail([
      record('user-1', {
        seq: 1,
        kind: 'user',
        title: '用户',
        summary: '实现导出',
        input: [{ type: 'text', text: '实现导出' }],
        output: undefined,
      }),
      record('user-2', {
        seq: 2,
        kind: 'steering',
        title: '用户补充',
        summary: '增加权限检查',
        input: [{ type: 'text', text: '增加权限检查' }],
        output: undefined,
      }),
      record('test-1', { seq: 3 }),
    ])
    const evaluation = evaluateTrajectory(value, analyzeTrajectory(value), {
      target,
      sourceStatus: status,
    })

    expect(evaluation.requirements).toHaveLength(2)
    expect(evaluation.requirements.every(result =>
      result.state === 'insufficient_evidence')).toBe(true)
    expect(evaluation.requirements[0]?.reason).toContain('逐项验收证据')
  })

  it('separates single-turn N/A, explicit continuity, and reported information loss', () => {
    const single = detail([
      record('user-1', {
        kind: 'user',
        title: '用户',
        summary: '实现导出',
        input: [{ type: 'text', text: '实现导出' }],
        output: undefined,
      }),
    ])
    expect(buildChainResult(single).continuity).toBe('not_applicable')

    const continued = detail([
      record('user-1', {
        seq: 1,
        turn: 1,
        kind: 'user',
        title: '用户',
        summary: '先设计方案',
        input: [{ type: 'text', text: '先设计方案' }],
        output: undefined,
      }),
      record('user-2', {
        seq: 2,
        turn: 2,
        kind: 'steering',
        title: '用户补充',
        summary: '按已确认方案继续开发',
        input: [{ type: 'text', text: '按已确认方案继续开发' }],
        output: undefined,
      }),
    ])
    expect(buildChainResult(continued)).toMatchObject({
      continuity: 'normal',
      transitions: [{ fromTurn: 1, toTurn: 2, continuity: 'normal' }],
    })

    const lost = structuredClone(continued)
    lost.projection.records[1]!.summary = '你忘了前面的权限要求'
    lost.projection.records[1]!.input = [{
      type: 'text',
      text: '你忘了前面的权限要求',
    }]
    expect(buildChainResult(lost)).toMatchObject({
      continuity: 'missing',
      failedTransition: { fromTurn: 1, toTurn: 2 },
    })
  })

  it('reports source protocol blocks as facts quality, not agent failure', () => {
    const value = detail([record('tool-1')])
    const report = buildFactsQualityReport(value, {
      target,
      sourceStatus: {
        ...status,
        availability: 'blocked',
        reason: 'unsupported-protocol',
      },
    })

    expect(report.ready).toBe(false)
    expect(report.issues).toContainEqual(expect.objectContaining({
      id: 'source-protocol-blocked',
      severity: 'blocking',
      category: 'protocol',
    }))
    expect(report.blockedCriterionIds).toEqual(expect.arrayContaining([
      'outcome',
      'reliability',
      'recovery',
      'efficiency',
      'observability',
    ]))
  })
})
