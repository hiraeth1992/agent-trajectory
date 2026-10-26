import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleApi, sendError, type ApiRegistry } from '../server/api'
import {
  AnnotationWorkspaceStore,
} from '../server/evaluation/annotation-workspace'
import {
  prepareCalibrationCandidates,
  type CalibrationSource,
} from '../server/evaluation/calibration'
import { capabilities, sessionKey } from '../server/sources/types'
import type {
  AnnotationCaseWorkspace,
  AnnotationWorkspaceOverview,
} from '../src/annotation-types'
import type {
  SessionDetail,
  SourceId,
  SourceStatus,
  TrajectoryRecord,
} from '../src/types'

const roots: string[] = []
const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server =>
    new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

function detail(source: SourceId, id: string): SessionDetail {
  const summary = {
    id: sessionKey(source, id),
    source,
    sourceSessionId: id,
    format: 'annotation-api-test',
    capabilities: capabilities('messages', 'tools'),
    cwd: '/workspace',
    title: `Private ${source}`,
    createdAt: 1,
    updatedAt: 3,
    size: 2,
  }
  const base: Omit<TrajectoryRecord, 'id' | 'kind' | 'title' | 'summary' | 'searchText'> = {
    source,
    sourceEventIds: ['event'],
    fidelity: 'exact',
    seq: 1,
    turn: 1,
    step: 1,
    startTime: 1,
    endTime: 2,
    status: 'complete',
    depth: 0,
  }
  return {
    summary,
    projection: {
      header: {
        source,
        format: summary.format,
        id,
        createdAt: 1,
      },
      records: [{
        ...base,
        id: 'user-source',
        kind: 'user',
        title: '用户',
        summary: '修复并验证',
        input: [{ type: 'text', text: '修复并验证' }],
        searchText: '修复并验证',
      }, {
        ...base,
        id: 'tool-source',
        seq: 2,
        kind: 'tool',
        title: 'exec_command',
        summary: '测试通过',
        input: { cmd: 'npm test' },
        output: 'Tests passed',
        searchText: '测试通过',
      }],
      turns: [{
        id: 'turn-1',
        number: 1,
        startTime: 1,
        endTime: 2,
        status: 'complete',
      }],
      lanes: [],
      startTime: 1,
      endTime: 2,
      eventCount: 2,
      eventTypeCounts: {},
      unknownEventTypes: [],
      turnEnds: { 1: { time: 2, reason: 'complete' } },
    },
  }
}

function source(): CalibrationSource {
  const details = new Map<SourceId, SessionDetail>([
    ['dsh', detail('dsh', 'dsh-private')],
    ['codex', detail('codex', 'codex-private')],
    ['zcode', detail('zcode', 'zcode-private')],
  ])
  const status = (source: SourceId): SourceStatus => ({
    source,
    availability: 'available',
    label: source,
    colorToken: source === 'dsh' ? 'blue' : source === 'codex' ? 'green' : 'amber',
    iconToken: source === 'dsh' ? 'agent' : source === 'codex' ? 'code' : 'terminal',
    sessionCount: 1,
    capabilities: capabilities('messages', 'tools'),
  })
  return {
    listSources: async () => [...details.keys()].map(status),
    listSessions: async () => [...details.values()].map(value => value.summary),
    fingerprint: async (selected, id) => `${selected}:${id}:fingerprint`,
    load: async selected => structuredClone(details.get(selected)),
  }
}

const registry: ApiRegistry = {
  listSources: async () => [],
  listSessions: async () => [],
  load: async () => undefined,
  fingerprint: async () => undefined,
}

async function start(
  annotations: AnnotationWorkspaceStore,
  selectedRegistry: ApiRegistry = registry,
): Promise<string> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (!await handleApi(request, response, url, {
        annotations,
        registry: selectedRegistry,
      })) {
        response.writeHead(404).end()
      }
    })().catch(error => sendError(response, 500, error))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

describe('annotation workspace API', () => {
  it('prepares datasets only inside the configured calibration root', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'annotation-api-prepare-'))
    roots.push(root)
    const calibrationRoot = path.join(root, 'calibration')
    const calibrationSource = source()
    const selectedRegistry: ApiRegistry = {
      listSources: calibrationSource.listSources,
      listSessions: calibrationSource.listSessions,
      load: calibrationSource.load,
      fingerprint: calibrationSource.fingerprint,
    }
    const store = new AnnotationWorkspaceStore(
      calibrationRoot,
      path.join(root, 'evaluations'),
      selectedRegistry,
    )
    const base = await start(store, selectedRegistry)

    const preparedResponse = await fetch(`${base}/api/annotations/datasets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directoryId: 'real-v1',
        datasetId: 'private-api-prepared',
        datasetVersion: '1',
        count: 3,
        allowPartial: false,
      }),
    })
    expect(preparedResponse.status).toBe(201)
    expect(await preparedResponse.json()).toMatchObject({
      dataset: {
        directoryId: 'real-v1',
        datasetId: 'private-api-prepared',
        cases: 3,
        allowPartial: false,
        privacyAuditPassed: true,
      },
      skipped: 0,
    })
    expect(await fs.readdir(path.join(calibrationRoot, 'real-v1'))).toEqual(
      expect.arrayContaining([
        'manifest.json',
        'privacy-audit.json',
        'reviewer-a.json',
        'reviewer-b.json',
      ]),
    )

    const duplicate = await fetch(`${base}/api/annotations/datasets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directoryId: 'real-v1',
        datasetId: 'private-api-prepared',
        datasetVersion: '2',
        count: 3,
        allowPartial: false,
      }),
    })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toMatchObject({
      code: 'annotation_conflict',
      error: expect.stringMatching(/already exists/),
    })

    const invalidPath = await fetch(`${base}/api/annotations/datasets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directoryId: '../outside',
        datasetId: 'private-api-invalid',
        datasetVersion: '1',
        count: 3,
        allowPartial: false,
      }),
    })
    expect(invalidPath.status).toBe(400)
    expect(await invalidPath.json()).toMatchObject({
      code: 'invalid_annotation',
    })
    expect(await fs.access(path.join(root, 'outside')).then(
      () => true,
      () => false,
    )).toBe(false)
  })

  it('deduplicates identical preparation requests and rejects conflicting ones', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'annotation-api-prepare-'))
    roots.push(root)
    const calibrationRoot = path.join(root, 'calibration')
    const delegate = source()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let sourceReads = 0
    const delayed: CalibrationSource = {
      ...delegate,
      listSources: async () => {
        sourceReads++
        await gate
        return delegate.listSources()
      },
    }
    const store = new AnnotationWorkspaceStore(
      calibrationRoot,
      path.join(root, 'evaluations'),
      delayed,
    )
    const request = {
      directoryId: 'real-v1',
      datasetId: 'private-api-concurrent',
      datasetVersion: '1',
      count: 3,
      allowPartial: false,
    }
    const first = store.prepareDataset(request)
    const duplicate = store.prepareDataset(request)
    await expect(store.prepareDataset({
      ...request,
      datasetVersion: '2',
    })).rejects.toThrow(/already running/)
    release()

    const [firstResult, duplicateResult] = await Promise.all([first, duplicate])
    expect(firstResult.dataset.datasetHash).toBe(duplicateResult.dataset.datasetHash)
    expect(sourceReads).toBe(1)
  })

  it('quarantines a failed preparation so the requested directory can be retried', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'annotation-api-prepare-'))
    roots.push(root)
    const calibrationRoot = path.join(root, 'calibration')
    const failedRoot = path.join(calibrationRoot, 'real-v2')
    await fs.mkdir(failedRoot, { recursive: true })
    await fs.writeFile(
      path.join(failedRoot, 'PRIVACY-AUDIT-FAILED.json'),
      '{"passed":false}\n',
    )
    const store = new AnnotationWorkspaceStore(
      calibrationRoot,
      path.join(root, 'evaluations'),
      source(),
    )

    const result = await store.prepareDataset({
      directoryId: 'real-v2',
      datasetId: 'private-api-retry',
      datasetVersion: '2',
      count: 3,
      allowPartial: false,
    })

    expect(result.dataset).toMatchObject({
      directoryId: 'real-v2',
      datasetId: 'private-api-retry',
      datasetVersion: '2',
    })
    expect(await fs.access(path.join(failedRoot, 'privacy-audit.json')).then(
      () => true,
      () => false,
    )).toBe(true)
    const entries = await fs.readdir(calibrationRoot)
    expect(entries.some(entry =>
      entry.startsWith('.quarantine-real-v2-'))).toBe(true)
    expect(entries.some(entry => entry.endsWith('.preparing'))).toBe(false)
  })

  it('lists a valid dataset created by the supported historical sampling policy', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'annotation-api-historical-'))
    roots.push(root)
    const calibrationRoot = path.join(root, 'calibration')
    const datasetRoot = path.join(calibrationRoot, 'real-v1')
    await prepareCalibrationCandidates(source(), datasetRoot, {
      count: 3,
      datasetId: 'private-api-historical',
      datasetVersion: '1',
    })
    const manifestFile = path.join(datasetRoot, 'manifest.json')
    const manifest = JSON.parse(
      await fs.readFile(manifestFile, 'utf8'),
    ) as Record<string, unknown> & {
      contentHash: string
      preparation: Record<string, unknown>
    }
    manifest.preparation.samplingPolicyVersion = 2
    manifest.preparation.seed = 'private-api-historical@1:sampling-v2'
    const hashable = {
      schemaVersion: manifest.schemaVersion,
      kind: manifest.kind,
      id: manifest.id,
      version: manifest.version,
      description: manifest.description,
      preparation: manifest.preparation,
      cases: manifest.cases,
    }
    manifest.contentHash = createHash('sha256')
      .update(JSON.stringify(hashable))
      .digest('hex')
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    const auditFile = path.join(datasetRoot, 'privacy-audit.json')
    const audit = JSON.parse(
      await fs.readFile(auditFile, 'utf8'),
    ) as Record<string, unknown>
    audit.manifestHash = manifest.contentHash
    await fs.writeFile(auditFile, `${JSON.stringify(audit, null, 2)}\n`)

    const store = new AnnotationWorkspaceStore(calibrationRoot)

    await expect(store.listDatasets()).resolves.toEqual([
      expect.objectContaining({
        directoryId: 'real-v1',
        datasetId: 'private-api-historical',
        datasetVersion: '1',
        privacyAuditPassed: true,
      }),
    ])
  })

  it('lists, loads, lazy-reads, saves, and rejects stale revisions', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'annotation-api-'))
    roots.push(root)
    const calibrationRoot = path.join(root, 'calibration')
    await prepareCalibrationCandidates(
      source(),
      path.join(calibrationRoot, 'private-v1'),
      {
        count: 3,
        datasetId: 'private-api-test',
        datasetVersion: '1',
      },
    )
    const store = new AnnotationWorkspaceStore(calibrationRoot)
    const base = await start(store)

    const datasets = await (
      await fetch(`${base}/api/annotations/datasets`)
    ).json() as Array<{ directoryId: string }>
    expect(datasets).toEqual([expect.objectContaining({ directoryId: 'private-v1' })])

    const workflowResponse = await fetch(
      `${base}/api/annotations/datasets/private-v1/workflow`,
    )
    expect(workflowResponse.status).toBe(200)
    expect(await workflowResponse.json()).toMatchObject({
      reviewersComplete: false,
      adjudication: { exists: false, complete: false },
      runs: [],
      diffs: [],
    })

    const overviewResponse = await fetch(
      `${base}/api/annotations/datasets/private-v1/reviewer-a`,
    )
    const overview = await overviewResponse.json() as AnnotationWorkspaceOverview
    expect(overviewResponse.status).toBe(200)
    expect(overview.progress).toEqual({ complete: 0, total: 3 })

    const selected = overview.cases[0]!
    const caseResponse = await fetch(
      `${base}/api/annotations/datasets/private-v1/reviewer-a/cases/${selected.id}`,
    )
    const workspace = await caseResponse.json() as AnnotationCaseWorkspace
    expect(caseResponse.status).toBe(200)
    expect(workspace.records[1]).not.toHaveProperty('output')

    const recordResponse = await fetch(
      `${base}/api/annotations/datasets/private-v1/reviewer-a/cases/${
        selected.id
      }/records/record-002`,
    )
    expect(recordResponse.status).toBe(200)
    expect(await recordResponse.json()).toMatchObject({
      id: 'record-002',
      output: 'Tests passed',
    })

    const annotation = structuredClone(workspace.annotation)
    annotation.criteria[0]!.verdict = 'pass'
    annotation.criteria[0]!.attribution = 'agent'
    annotation.criteria[0]!.evidenceRecordIds = ['record-002']
    const saveBody = {
      datasetHash: workspace.datasetHash,
      revision: workspace.revision,
      annotation,
    }
    const saveResponse = await fetch(
      `${base}/api/annotations/datasets/private-v1/reviewer-a/cases/${selected.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(saveBody),
      },
    )
    expect(saveResponse.status).toBe(200)
    expect(await saveResponse.json()).toMatchObject({
      case: { criteriaComplete: 1, complete: false },
    })

    const conflict = await fetch(
      `${base}/api/annotations/datasets/private-v1/reviewer-a/cases/${selected.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(saveBody),
      },
    )
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      error: expect.stringMatching(/changed in another window/),
    })

    const malformed = await fetch(
      `${base}/api/annotations/datasets/private-v1/reviewer-a/cases/${selected.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      },
    )
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({
      code: 'invalid_json',
      error: 'invalid JSON body',
    })

    const tooLarge = await fetch(
      `${base}/api/annotations/datasets/private-v1/reviewer-a/cases/${selected.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'x'.repeat(513 * 1024) }),
      },
    )
    expect(tooLarge.status).toBe(413)
    expect(await tooLarge.json()).toEqual({
      code: 'request_body_too_large',
      error: 'request body too large',
    })

    const missingCase = await fetch(
      `${base}/api/annotations/datasets/private-v1/reviewer-a/cases/missing-case`,
    )
    expect(missingCase.status).toBe(404)
    expect(await missingCase.json()).toMatchObject({
      code: 'annotation_not_found',
    })

    const invalidRecord = await fetch(
      `${base}/api/annotations/datasets/private-v1/reviewer-a/cases/${
        selected.id
      }/records/not-a-record`,
    )
    expect(invalidRecord.status).toBe(400)
    expect(await invalidRecord.json()).toMatchObject({
      code: 'invalid_annotation',
    })

    const invalidSaveShape = await fetch(
      `${base}/api/annotations/datasets/private-v1/reviewer-a/cases/${selected.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: 'null',
      },
    )
    expect(invalidSaveShape.status).toBe(400)
    expect(await invalidSaveShape.json()).toMatchObject({
      code: 'invalid_annotation_request',
    })

    const invalidRun = await fetch(
      `${base}/api/annotations/datasets/private-v1/workflow/run`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ split: 'unknown' }),
      },
    )
    expect(invalidRun.status).toBe(400)
    expect(await invalidRun.json()).toMatchObject({
      code: 'invalid_evaluation_request',
    })
    const invalidBaselineRun = await fetch(
      `${base}/api/annotations/datasets/private-v1/workflow/run`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          split: 'calibration',
          baselineRunId: '../not-a-run',
        }),
      },
    )
    expect(invalidBaselineRun.status).toBe(400)
    expect(await invalidBaselineRun.json()).toMatchObject({
      code: 'invalid_evaluation_request',
    })

    const missingRun = await fetch(
      `${base}/api/annotations/datasets/private-v1/workflow/runs/${'x'.repeat(24)}`,
    )
    expect(missingRun.status).toBe(404)
    expect(await missingRun.json()).toMatchObject({
      code: 'annotation_not_found',
    })

    const invalidRunId = await fetch(
      `${base}/api/annotations/datasets/private-v1/workflow/runs/bad%2Fid`,
    )
    expect(invalidRunId.status).toBe(400)
    expect(await invalidRunId.json()).toMatchObject({
      code: 'invalid_annotation',
    })

    store.evaluationRunDetails = async () => ({
      run: {
        runId: 'r'.repeat(24),
        createdAt: '2026-10-25T00:00:00.000Z',
        split: 'calibration',
        assertionAgreement: 1,
        evaluatorError: 0,
        cases: [{
          caseId: 'case-1',
          assertionsPassed: 1,
          assertionsTotal: 1,
          criteria: [{
            criterionId: 'outcome',
            verdict: 'pass',
            attribution: 'agent',
            evidenceRecordIds: ['record-002'],
          }],
          mismatches: [],
        }],
      },
      diffs: [],
    })
    const runDetails = await fetch(
      `${base}/api/annotations/datasets/private-v1/workflow/runs/${'r'.repeat(24)}`,
    )
    expect(runDetails.status).toBe(200)
    expect(await runDetails.json()).toMatchObject({
      run: {
        runId: 'r'.repeat(24),
        cases: [{
          caseId: 'case-1',
          criteria: [{ criterionId: 'outcome', verdict: 'pass' }],
        }],
      },
      diffs: [],
    })
  })
})
