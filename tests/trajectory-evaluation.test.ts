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
  buildRequirementResults,
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
      factsSchemaVersion: 3,
      target,
      factsQuality: {
        schemaVersion: 3,
        coveragePolicyVersion: 2,
        ready: true,
      },
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

  it('blocks only dependent criteria for folded and required raw-only coverage gaps', () => {
    const value = detail([
      record('user-1', {
        kind: 'user',
        title: '用户',
        summary: '交付并验证结果',
        input: [{ type: 'text', text: '交付并验证结果' }],
        output: undefined,
      }),
      record('test-1', { seq: 2 }),
    ])
    value.projection.coverage = [{
      type: 'goal/change',
      total: 2,
      consumed: 1,
      disposition: 'folded-state',
      reason: '1 event failed semantic validation and remains audit-only',
    }, {
      type: 'deliverables/presented',
      total: 1,
      consumed: 0,
      disposition: 'raw-only',
      reason: 'known event is retained for audit but has no semantic projector',
    }]
    value.projection.coverageSummary = { total: 3, consumed: 1, gap: 2 }

    const evaluation = evaluateTrajectory(value, analyzeTrajectory(value), {
      target,
      sourceStatus: status,
    })
    expect(evaluation.factsQuality).toMatchObject({
      ready: false,
      coveragePolicyVersion: 2,
      stats: {
        coverageTotal: 3,
        coverageConsumed: 1,
        coverageGap: 2,
      },
      issues: expect.arrayContaining([
        expect.objectContaining({
          id: 'coverage-gap:goal/change',
          severity: 'blocking',
          affectedCriterionIds: ['outcome', 'reliability'],
        }),
        expect.objectContaining({
          id: 'coverage-gap:deliverables/presented',
          severity: 'blocking',
          affectedCriterionIds: ['outcome'],
        }),
      ]),
    })
    expect(evaluation.results.find(result => result.criterionId === 'outcome'))
      .toMatchObject({
        verdict: 'insufficient_evidence',
        blockedBy: expect.arrayContaining([
          'coverage-gap:goal/change',
          'coverage-gap:deliverables/presented',
        ]),
      })
    expect(evaluation.results.find(result => result.criterionId === 'efficiency'))
      .not.toMatchObject({ blockedBy: expect.arrayContaining(['coverage-gap:goal/change']) })
  })

  it('keeps unrelated raw-only gaps advisory but fails closed on unsupported events', () => {
    const advisory = detail([record('tool-1')])
    advisory.projection.coverage = [{
      type: 'session/title-llm-request',
      total: 1,
      consumed: 0,
      disposition: 'raw-only',
    }]
    advisory.projection.coverageSummary = { total: 1, consumed: 0, gap: 1 }
    const advisoryReport = buildFactsQualityReport(advisory, {
      target,
      sourceStatus: status,
    })
    expect(advisoryReport.ready).toBe(true)
    expect(advisoryReport.issues).toContainEqual(expect.objectContaining({
      id: 'coverage-gap:session/title-llm-request',
      severity: 'warning',
    }))

    const unsupported = structuredClone(advisory)
    unsupported.projection.coverage = [{
      type: 'future/required',
      total: 1,
      consumed: 0,
      disposition: 'unsupported',
    }]
    const unsupportedReport = buildFactsQualityReport(unsupported, {
      target,
      sourceStatus: status,
    })
    expect(unsupportedReport.ready).toBe(false)
    expect(unsupportedReport.issues).toContainEqual(expect.objectContaining({
      id: 'coverage-gap:future/required',
      severity: 'blocking',
      affectedCriterionIds: expect.arrayContaining(['outcome', 'observability']),
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

  it('extracts atomic typed requirements and preserves unrelated constraints on replacement', () => {
    const value = detail([
      record('user-1', {
        seq: 1,
        turn: 1,
        kind: 'user',
        title: '用户',
        summary: '实现导出，同时保留现有 API；测试必须通过；不要写入外部系统',
        input: [{
          type: 'text',
          text: '实现导出，同时保留现有 API；测试必须通过；不要写入外部系统',
        }],
        output: undefined,
      }),
      record('user-2', {
        seq: 2,
        turn: 2,
        kind: 'steering',
        title: '用户补充',
        summary: '导出改为 CSV',
        input: [{ type: 'text', text: '导出改为 CSV' }],
        output: undefined,
      }),
    ])
    const analysis = analyzeTrajectory(value)
    const quality = buildFactsQualityReport(value, { target, sourceStatus: status })
    const requirements = buildRequirementResults(value, analysis, quality)

    expect(requirements).toHaveLength(5)
    expect(requirements.map(item => item.kind)).toEqual([
      'deliverable',
      'constraint',
      'acceptance',
      'prohibition',
      'deliverable',
    ])
    expect(requirements[0]).toMatchObject({
      id: 'requirement:user-1:01',
      introducedTurn: 1,
      sourceRecordId: 'user-1',
      state: 'superseded',
      supersededBy: 'requirement:user-2:01',
    })
    expect(requirements[1]).toMatchObject({
      kind: 'constraint',
      required: true,
      state: 'insufficient_evidence',
    })
    expect(requirements[2]).toMatchObject({
      kind: 'acceptance',
      dependsOn: ['requirement:user-1:01'],
    })
    expect(requirements[3]).toMatchObject({
      kind: 'prohibition',
      required: true,
    })
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
      continuity: 'insufficient_evidence',
      transitions: [{
        fromTurn: 1,
        toTurn: 2,
        continuity: 'insufficient_evidence',
        carryover: {
          input: 'normal',
          action: 'insufficient_evidence',
          result: 'insufficient_evidence',
        },
      }],
    })

    const acted = structuredClone(continued)
    acted.projection.records.push(record('action-1', {
      seq: 3,
      turn: 2,
      step: 1,
      kind: 'tool',
      title: 'apply_patch',
    }))
    expect(buildChainResult(acted, [{
      id: 'requirement:user-1:01',
      text: '先设计方案',
      kind: 'deliverable',
      introducedTurn: 1,
      sourceRecordId: 'user-1',
      required: true,
      state: 'insufficient_evidence',
      dependsOn: [],
      evidenceRecordIds: ['user-1'],
      reason: '待验证',
    }])).toMatchObject({
      continuity: 'normal',
      transitions: [{
        fromTurn: 1,
        toTurn: 2,
        continuity: 'normal',
        requirementIds: ['requirement:user-1:01'],
        carryover: { input: 'normal', action: 'normal', result: 'normal' },
      }],
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
