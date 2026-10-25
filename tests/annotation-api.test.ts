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

async function start(annotations: AnnotationWorkspaceStore): Promise<string> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (!await handleApi(request, response, url, { annotations, registry })) {
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
    const base = await start(new AnnotationWorkspaceStore(calibrationRoot))

    const datasets = await (
      await fetch(`${base}/api/annotations/datasets`)
    ).json() as Array<{ directoryId: string }>
    expect(datasets).toEqual([expect.objectContaining({ directoryId: 'private-v1' })])

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
  })
})
