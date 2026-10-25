import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  auditCalibrationCandidates,
  compareHumanAnnotations,
  createAnnotationTemplate,
  loadAdjudicatedDataset,
  loadCandidateManifest,
  loadHumanAnnotations,
  parseAdjudication,
  prepareCalibrationCandidates,
  sanitizeCalibrationDetail,
  type CalibrationSource,
} from '../server/evaluation/calibration'
import { runEvaluationDataset } from '../server/evaluation/runner'
import { capabilities, sessionKey } from '../server/sources/types'
import type {
  EvaluationAdjudication,
  HumanEvaluationAnnotations,
} from '../src/evaluation-types'
import type {
  SessionDetail,
  SessionSummary,
  SourceId,
  SourceStatus,
  TrajectoryRecord,
} from '../src/types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

function record(
  source: SourceId,
  id: string,
  overrides: Partial<TrajectoryRecord> = {},
): TrajectoryRecord {
  return {
    id,
    source,
    sourceEventIds: [`source-${id}`],
    fidelity: 'exact',
    seq: 1,
    turn: 1,
    step: 1,
    kind: 'tool',
    title: 'exec_command',
    summary: `Inspect /Users/private-user/project and token=private-token-${id}`,
    startTime: 1_000,
    endTime: 2_000,
    status: 'complete',
    depth: 0,
    callId: `call-${id}`,
    traceId: `trace-${id}`,
    spanId: `span-${id}`,
    input: {
      cmd: 'pwd',
      cwd: '/Users/private-user/project',
      authorization: `Bearer private-token-${id}`,
    },
    output: [
      '/Users/private-user/project',
      '/users/${injected-user}/workspace',
      'examples: `/Users/x` and `/home/y`',
    ].join('\n'),
    raw: [{ authorization: `Bearer raw-private-${id}` }],
    searchText: `private search ${id}`,
    ...overrides,
  }
}

function detail(source: SourceId, sourceSessionId: string): SessionDetail {
  const summary: SessionSummary = {
    id: sessionKey(source, sourceSessionId),
    source,
    sourceSessionId,
    format: 'private-test',
    capabilities: capabilities('messages', 'tools', 'timing', 'usage', 'trace'),
    cwd: '/Users/private-user/project',
    title: `Private session ${sourceSessionId}`,
    createdAt: 1_000,
    updatedAt: 3_000,
    size: 2,
  }
  const user = record(source, `${sourceSessionId}-user`, {
    seq: 1,
    step: 0,
    kind: 'user',
    title: '用户',
    summary: '修复并验证私有项目',
    input: [{ type: 'text', text: '修复并验证 /Users/private-user/project' }],
    output: undefined,
    callId: undefined,
  })
  const tool = record(source, `${sourceSessionId}-tool`, { seq: 2 })
  return {
    summary,
    projection: {
      header: {
        source,
        format: summary.format,
        id: sourceSessionId,
        createdAt: summary.createdAt,
        cwd: summary.cwd,
        traceId: `session-trace-${sourceSessionId}`,
      },
      records: [user, tool],
      turns: [{
        id: 'turn-1',
        number: 1,
        startTime: 1_000,
        endTime: 3_000,
        status: 'complete',
      }],
      lanes: [],
      startTime: 1_000,
      endTime: 3_000,
      eventCount: 2,
      eventTypeCounts: { user: 1, tool: 1 },
      unknownEventTypes: [],
      relations: [{
        type: 'derived-from',
        from: tool.id,
        to: user.id,
        fidelity: 'exact',
        sourceEventIds: ['private-relation-event'],
      }],
      transcriptRecordIds: [user.id],
      modelContextRecordIds: [user.id, tool.id],
      turnEnds: { 1: { time: 3_000, reason: 'complete' } },
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    },
  }
}

function status(source: SourceId): SourceStatus {
  return {
    source,
    availability: 'available',
    label: source.toUpperCase(),
    colorToken: source === 'dsh' ? 'blue' : source === 'codex' ? 'green' : 'amber',
    iconToken: source === 'dsh' ? 'agent' : source === 'codex' ? 'code' : 'terminal',
    sessionCount: 1,
    capabilities: capabilities('messages', 'tools', 'timing', 'usage'),
    protocol: {
      detected: `${source}-test`,
      supported: [`${source}-test`],
      fingerprint: `private-protocol-${source}`,
    },
  }
}

function source(): CalibrationSource {
  const details = new Map<SourceId, SessionDetail>([
    ['dsh', detail('dsh', 'private-dsh-session')],
    ['codex', detail('codex', 'private-codex-session')],
    ['zcode', detail('zcode', 'private-zcode-session')],
  ])
  return {
    listSources: async () => [...details.keys()].map(status),
    listSessions: async () => [...details.values()].map(item => item.summary),
    fingerprint: async (sourceId, sourceSessionId) =>
      `private-fingerprint-${sourceId}-${sourceSessionId}`,
    load: async sourceId => structuredClone(details.get(sourceId)),
  }
}

function completeAnnotations(
  template: HumanEvaluationAnnotations,
  verdict: 'pass' | 'warning' = 'pass',
): HumanEvaluationAnnotations {
  return {
    ...structuredClone(template),
    cases: template.cases.map(testCase => ({
      ...testCase,
      criteria: testCase.criteria.map(criterion => ({
        ...criterion,
        verdict,
        attribution: 'agent',
        evidenceRecordIds: ['record-002'],
        notes: '人工复核轨迹证据。',
      })),
      requirements: [{
        id: 'requirement:record-001',
        text: '修复并验证私有项目',
        required: true,
        state: verdict === 'pass' ? 'implemented' : 'insufficient_evidence',
        evidenceRecordIds: ['record-001', 'record-002'],
        notes: '人工逐项验收。',
      }],
      chain: {
        continuity: 'not_applicable',
        evidenceRecordIds: ['record-001'],
        notes: '只有一个用户轮次。',
      },
      notes: '完成。',
    })),
  }
}

describe('private real-trajectory calibration', () => {
  it('pseudonymizes record, event, call, trace, session, path, and credential data', () => {
    const safe = sanitizeCalibrationDetail(
      detail('codex', 'private-codex-session'),
      'real-codex-anonymous',
    )
    const serialized = JSON.stringify(safe)

    expect(serialized).not.toMatch(
      /private-user|private-codex-session|private-token|raw-private|private search|source-private|call-private|trace-private|span-private/,
    )
    expect(safe.summary).toMatchObject({
      id: 'codex:real-codex-anonymous',
      sourceSessionId: 'real-codex-anonymous',
      cwd: '<workspace>',
      title: 'Private calibration real-codex-anonymous',
    })
    expect(safe.projection.records.map(item => item.id))
      .toEqual(['record-001', 'record-002'])
    expect(safe.projection.records[0]).not.toHaveProperty('raw')
    expect(safe.projection.records[0]).not.toHaveProperty('searchText')
    expect(safe.projection.records[1]).toMatchObject({
      sourceEventIds: ['event-002'],
      callId: 'call-001',
      traceId: 'trace-002',
      spanId: 'span-002',
    })
    expect(safe.projection.transcriptRecordIds).toEqual(['record-001'])
    expect(safe.projection.modelContextRecordIds)
      .toEqual(['record-001', 'record-002'])
    expect(safe.projection.relations).toEqual([expect.objectContaining({
      from: 'record-002',
      to: 'record-001',
      sourceEventIds: ['event-003'],
    })])
  })

  it('prepares balanced private candidates and blind reviewer templates', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'trajectory-calibration-'))
    roots.push(root)
    const prepared = await prepareCalibrationCandidates(source(), root, {
      count: 3,
      createdAt: '2026-10-25T00:00:00.000Z',
      datasetId: 'private-real-test',
      datasetVersion: '1',
    })

    expect(prepared.manifest.cases).toHaveLength(3)
    expect(new Set(prepared.manifest.cases.map(item => item.target.source)))
      .toEqual(new Set(['dsh', 'codex', 'zcode']))
    expect(prepared.manifest.cases.map(item => item.split))
      .toEqual(['calibration', 'calibration', 'independent'])
    const serialized = await Promise.all(
      prepared.manifest.cases.map(item =>
        fs.readFile(path.join(root, item.file), 'utf8')),
    )
    expect(serialized.join('\n')).not.toMatch(
      /private-user|private-token|private-(?:dsh|codex|zcode)-session|raw-private/,
    )
    const reviewerA = JSON.parse(
      await fs.readFile(prepared.reviewerATemplate, 'utf8'),
    ) as HumanEvaluationAnnotations
    expect(reviewerA.cases.every(testCase =>
      testCase.criteria.every(item =>
        item.verdict === undefined && item.attribution === undefined))).toBe(true)
    expect(JSON.stringify(reviewerA)).not.toContain('local-trajectory')
    expect(await auditCalibrationCandidates(root)).toMatchObject({
      cases: 3,
      hashesVerified: 3,
      forbiddenRecordFields: 0,
      homePathShapes: 0,
      credentialShapes: 0,
      identityMismatches: 0,
      passed: true,
    })
    expect(JSON.parse(
      await fs.readFile(path.join(root, 'privacy-audit.json'), 'utf8'),
    )).toMatchObject({ passed: true })
    if (process.platform !== 'win32') {
      expect((await fs.stat(root)).mode & 0o777).toBe(0o700)
      expect((await fs.stat(prepared.manifestFile)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(prepared.reviewerATemplate)).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects candidate tampering before loading adjudicated Gold', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'trajectory-calibration-'))
    roots.push(root)
    const prepared = await prepareCalibrationCandidates(source(), root, {
      count: 3,
      datasetId: 'private-real-test',
      datasetVersion: '1',
    })
    const template = createAnnotationTemplate(
      prepared.manifest,
      'adjudicator',
      '2026-10-25T00:00:00.000Z',
    )
    const complete = completeAnnotations(template)
    const adjudication: EvaluationAdjudication = {
      schemaVersion: 1,
      kind: 'evaluation-adjudication',
      datasetId: complete.datasetId,
      datasetVersion: complete.datasetVersion,
      datasetHash: complete.datasetHash,
      adjudicatorId: complete.reviewerId,
      createdAt: complete.createdAt,
      cases: complete.cases,
    }
    const adjudicationFile = path.join(root, 'adjudication.json')
    await fs.writeFile(adjudicationFile, JSON.stringify(adjudication))
    const selected = prepared.manifest.cases[0]!
    await fs.appendFile(path.join(root, selected.file), '\n')

    await expect(loadAdjudicatedDataset(root, adjudicationFile))
      .rejects.toThrow(/hash mismatch/)
  })

  it('binds manifests, reviewers, and adjudication to one immutable candidate set', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'trajectory-calibration-'))
    roots.push(root)
    const prepared = await prepareCalibrationCandidates(source(), root, {
      count: 3,
      datasetId: 'private-real-test',
      datasetVersion: '1',
    })
    const manifestFile = path.join(root, 'manifest.json')
    const tampered = structuredClone(prepared.manifest)
    tampered.cases[0]!.description = 'tampered description'
    await fs.writeFile(manifestFile, JSON.stringify(tampered))
    await expect(loadCandidateManifest(root))
      .rejects.toThrow(/content hash mismatch/)

    await fs.writeFile(manifestFile, JSON.stringify(prepared.manifest))
    const reviewer = createAnnotationTemplate(prepared.manifest, 'reviewer-a')
    reviewer.datasetHash = '0'.repeat(64)
    const reviewerFile = path.join(root, 'reviewer-tampered.json')
    await fs.writeFile(reviewerFile, JSON.stringify(reviewer))
    await expect(loadHumanAnnotations(
      reviewerFile,
      prepared.manifest,
      { complete: false },
    )).rejects.toThrow(/dataset hash mismatch/)
  })

  it('reports blind-review agreement and requires complete adjudication for Gold', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'trajectory-calibration-'))
    roots.push(root)
    await prepareCalibrationCandidates(source(), root, {
      count: 3,
      datasetId: 'private-real-test',
      datasetVersion: '1',
    })
    const manifest = await loadCandidateManifest(root)
    const left = completeAnnotations(createAnnotationTemplate(
      manifest,
      'reviewer-a',
      '2026-10-25T00:00:00.000Z',
    ))
    const right = completeAnnotations(createAnnotationTemplate(
      manifest,
      'reviewer-b',
      '2026-10-25T00:00:00.000Z',
    ))
    right.cases[0]!.criteria[0]!.verdict = 'warning'
    const report = compareHumanAnnotations(manifest, left, right)

    expect(report).toMatchObject({
      reviewerA: 'reviewer-a',
      reviewerB: 'reviewer-b',
      completeCasesA: 3,
      completeCasesB: 3,
      totalCases: 3,
      disagreements: [{
        caseId: manifest.cases[0]!.id,
        subject: 'criterion:outcome',
      }],
    })
    expect(report.criterionExactAgreement).toBeCloseTo(14 / 15)
    expect(report.criterionKappa).toBeLessThan(1)

    const incomplete = createAnnotationTemplate(manifest, 'adjudicator')
    expect(() => parseAdjudication({
      schemaVersion: 1,
      kind: 'evaluation-adjudication',
      datasetId: incomplete.datasetId,
      datasetVersion: incomplete.datasetVersion,
      datasetHash: incomplete.datasetHash,
      adjudicatorId: incomplete.reviewerId,
      createdAt: incomplete.createdAt,
      cases: incomplete.cases,
    }, manifest)).toThrow(/incomplete criteria/)

    const reviewerFile = path.join(root, 'reviewer-a-complete.json')
    await fs.writeFile(reviewerFile, JSON.stringify(left))
    expect((await loadHumanAnnotations(
      reviewerFile,
      manifest,
      { complete: true },
    )).reviewerId).toBe('reviewer-a')
  })

  it('runs only complete adjudicated Gold and rejects dangling evidence', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'trajectory-calibration-'))
    roots.push(root)
    const prepared = await prepareCalibrationCandidates(source(), root, {
      count: 3,
      datasetId: 'private-real-test',
      datasetVersion: '1',
    })
    const complete = completeAnnotations(createAnnotationTemplate(
      prepared.manifest,
      'adjudicator',
      '2026-10-25T00:00:00.000Z',
    ))
    const adjudication = {
      schemaVersion: 1 as const,
      kind: 'evaluation-adjudication' as const,
      datasetId: complete.datasetId,
      datasetVersion: complete.datasetVersion,
      datasetHash: complete.datasetHash,
      adjudicatorId: complete.reviewerId,
      createdAt: complete.createdAt,
      cases: complete.cases,
    }
    const adjudicationFile = path.join(root, 'adjudication.json')
    await fs.writeFile(adjudicationFile, JSON.stringify(adjudication))

    const dataset = await loadAdjudicatedDataset(root, adjudicationFile)
    const run = runEvaluationDataset(dataset, {
      createdAt: '2026-10-25T00:00:00.000Z',
    })
    expect(dataset.cases).toHaveLength(3)
    expect(run.cases).toHaveLength(3)
    expect(run.aggregate.evaluatorError).toBe(0)

    adjudication.cases[0]!.criteria[0]!.evidenceRecordIds = ['record-999']
    await fs.writeFile(adjudicationFile, JSON.stringify(adjudication))
    await expect(loadAdjudicatedDataset(root, adjudicationFile))
      .rejects.toThrow(/references missing records: record-999/)
  })
})
