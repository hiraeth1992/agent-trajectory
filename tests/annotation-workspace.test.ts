import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AnnotationSaveRequest } from '../src/annotation-types'
import type {
  HumanCaseAnnotation,
  HumanEvaluationAnnotations,
} from '../src/evaluation-types'
import type {
  SessionDetail,
  SessionSummary,
  SourceId,
  SourceStatus,
  TrajectoryRecord,
} from '../src/types'
import {
  AnnotationConflictError,
  AnnotationWorkspaceStore,
} from '../server/evaluation/annotation-workspace'
import {
  prepareCalibrationCandidates,
  type CalibrationSource,
} from '../server/evaluation/calibration'
import { capabilities, sessionKey } from '../server/sources/types'

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
    sourceEventIds: [id],
    fidelity: 'exact',
    seq: 1,
    turn: 1,
    step: 1,
    kind: 'tool',
    title: 'exec_command',
    summary: '运行测试',
    startTime: 1_000,
    endTime: 2_000,
    status: 'complete',
    depth: 0,
    input: { cmd: 'npm test' },
    output: 'Tests 2 passed',
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    searchText: id,
    ...overrides,
  }
}

function detail(source: SourceId, sourceSessionId: string): SessionDetail {
  const summary: SessionSummary = {
    id: sessionKey(source, sourceSessionId),
    source,
    sourceSessionId,
    format: 'annotation-test',
    capabilities: capabilities('messages', 'tools', 'timing', 'usage'),
    cwd: '/workspace/private',
    title: `Private ${source}`,
    createdAt: 1_000,
    updatedAt: 3_000,
    size: 2,
  }
  return {
    summary,
    projection: {
      header: {
        source,
        format: summary.format,
        id: sourceSessionId,
        createdAt: 1_000,
      },
      records: [
        record(source, `${sourceSessionId}-user`, {
          seq: 1,
          step: 0,
          kind: 'user',
          title: '用户',
          summary: '修复并验证',
          input: [{ type: 'text', text: '修复并验证' }],
          output: undefined,
          usage: undefined,
        }),
        record(source, `${sourceSessionId}-tool`, { seq: 2 }),
      ],
      turns: [{
        id: 'turn-1',
        number: 1,
        startTime: 1_000,
        endTime: 2_000,
        status: 'complete',
      }],
      lanes: [],
      startTime: 1_000,
      endTime: 2_000,
      eventCount: 2,
      eventTypeCounts: {},
      unknownEventTypes: [],
      turnEnds: { 1: { time: 2_000, reason: 'complete' } },
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
  }
}

function calibrationSource(): CalibrationSource {
  const details = new Map<SourceId, SessionDetail>([
    ['dsh', detail('dsh', 'dsh-private')],
    ['codex', detail('codex', 'codex-private')],
    ['zcode', detail('zcode', 'zcode-private')],
  ])
  return {
    listSources: async () => [...details.keys()].map(status),
    listSessions: async () => [...details.values()].map(item => item.summary),
    fingerprint: async (source, id) => `fingerprint:${source}:${id}`,
    load: async source => structuredClone(details.get(source)),
  }
}

function completeCase(annotation: HumanCaseAnnotation): HumanCaseAnnotation {
  return {
    ...structuredClone(annotation),
    criteria: annotation.criteria.map(criterion => ({
      ...criterion,
      verdict: criterion.criterionId === 'recovery' ? 'not_applicable' : 'pass',
      attribution: criterion.criterionId === 'recovery'
        ? 'not_applicable'
        : 'agent',
      evidenceRecordIds: ['record-002'],
      notes: '人工标注。',
    })),
    requirements: [{
      id: 'requirement-001',
      text: '修复并验证',
      required: true,
      state: 'implemented',
      evidenceRecordIds: ['record-001', 'record-002'],
      notes: '要求和验证证据齐全。',
    }],
    chain: {
      continuity: 'not_applicable',
      evidenceRecordIds: ['record-001'],
      notes: '只有一个用户轮次。',
    },
    notes: '完成。',
  }
}

describe('annotation workspace store', () => {
  it('isolates reviewers, lazy-loads record details, and saves with revision locking', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'annotation-workspace-'))
    roots.push(root)
    const calibrationRoot = path.join(root, 'calibration')
    const datasetRoot = path.join(calibrationRoot, 'private-v1')
    const prepared = await prepareCalibrationCandidates(
      calibrationSource(),
      datasetRoot,
      {
        count: 3,
        datasetId: 'private-workspace-test',
        datasetVersion: '1',
        createdAt: '2026-10-25T00:00:00.000Z',
      },
    )
    const reviewerB = JSON.parse(
      await fs.readFile(prepared.reviewerBTemplate, 'utf8'),
    ) as HumanEvaluationAnnotations
    reviewerB.cases[0]!.notes = 'REVIEWER_B_PRIVATE_MARKER'
    await fs.writeFile(prepared.reviewerBTemplate, JSON.stringify(reviewerB))

    const store = new AnnotationWorkspaceStore(calibrationRoot)
    expect(await store.listDatasets()).toEqual([
      expect.objectContaining({
        directoryId: 'private-v1',
        cases: 3,
        privacyAuditPassed: true,
      }),
    ])

    const overview = await store.overview('private-v1', 'reviewer-a')
    expect(overview.progress).toEqual({ complete: 0, total: 3 })
    expect(JSON.stringify(overview)).not.toContain('REVIEWER_B_PRIVATE_MARKER')

    const first = overview.cases[0]!
    const workspace = await store.case('private-v1', 'reviewer-a', first.id)
    expect(workspace.requirementSuggestions).toEqual([expect.objectContaining({
      id: 'requirement-001',
      recordId: 'record-001',
      text: '修复并验证',
    })])
    expect(workspace.records[1]).toMatchObject({
      id: 'record-002',
      hasInput: true,
      hasOutput: true,
    })
    expect(workspace.records[1]).not.toHaveProperty('input')
    expect(workspace.records[1]).not.toHaveProperty('output')
    expect(JSON.stringify(workspace)).not.toContain('REVIEWER_B_PRIVATE_MARKER')

    const fullRecord = await store.record(
      'private-v1',
      first.id,
      'record-002',
    )
    expect(fullRecord).toMatchObject({
      id: 'record-002',
      input: { cmd: 'npm test' },
      output: 'Tests 2 passed',
    })

    const annotation = completeCase(workspace.annotation)
    const request: AnnotationSaveRequest = {
      datasetHash: workspace.datasetHash,
      revision: workspace.revision,
      annotation,
    }
    const saved = await store.saveCase(
      'private-v1',
      'reviewer-a',
      first.id,
      request,
    )
    expect(saved).toMatchObject({
      progress: { complete: 1, total: 3 },
      case: { id: first.id, complete: true },
    })
    expect(saved.revision).not.toBe(workspace.revision)
    const storedA = JSON.parse(
      await fs.readFile(prepared.reviewerATemplate, 'utf8'),
    ) as HumanEvaluationAnnotations
    expect(storedA.cases[0]).toEqual(annotation)
    const storedBAfter = JSON.parse(
      await fs.readFile(prepared.reviewerBTemplate, 'utf8'),
    ) as HumanEvaluationAnnotations
    expect(storedBAfter.cases[0]!.notes).toBe('REVIEWER_B_PRIVATE_MARKER')

    await expect(store.saveCase(
      'private-v1',
      'reviewer-a',
      first.id,
      request,
    )).rejects.toBeInstanceOf(AnnotationConflictError)
  })

  it('rejects traversal, symlink datasets, and dangling evidence references', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'annotation-workspace-'))
    roots.push(root)
    const calibrationRoot = path.join(root, 'calibration')
    const datasetRoot = path.join(calibrationRoot, 'private-v1')
    await prepareCalibrationCandidates(calibrationSource(), datasetRoot, {
      count: 3,
      datasetId: 'private-workspace-test',
      datasetVersion: '1',
    })
    const store = new AnnotationWorkspaceStore(calibrationRoot)

    await expect(store.overview('../private-v1', 'reviewer-a'))
      .rejects.toThrow(/invalid annotation dataset id/)
    await fs.symlink(datasetRoot, path.join(calibrationRoot, 'linked-v1'))
    expect(await store.listDatasets()).toHaveLength(1)

    const overview = await store.overview('private-v1', 'reviewer-a')
    const selected = overview.cases[0]!
    const workspace = await store.case('private-v1', 'reviewer-a', selected.id)
    const invalid = completeCase(workspace.annotation)
    invalid.criteria[0]!.evidenceRecordIds = ['record-999']
    await expect(store.saveCase(
      'private-v1',
      'reviewer-a',
      selected.id,
      {
        datasetHash: workspace.datasetHash,
        revision: workspace.revision,
        annotation: invalid,
      },
    )).rejects.toThrow(/references missing records/)
  })
})
