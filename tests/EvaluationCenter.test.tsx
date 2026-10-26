// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvaluationCenter } from '../src/components/EvaluationCenter'
import type {
  AnnotationDatasetSummary,
  AnnotationWorkspaceOverview,
  EvaluationRunDetails,
  EvaluationRunResult,
  EvaluationWorkflowStatus,
} from '../src/annotation-types'

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const dataset: AnnotationDatasetSummary = {
  directoryId: 'private-v1',
  datasetId: 'private-real',
  datasetVersion: '1',
  datasetHash: 'a'.repeat(64),
  description: 'Private real dataset',
  cases: 30,
  requestedCases: 30,
  skippedCases: 0,
  allowPartial: false,
  sources: {
    dsh: 10,
    codex: 10,
    zcode: 10,
    claude: 0,
    'doubao-work': 0,
    workbuddy: 0,
    qoder: 0,
    opencode: 0,
  },
  splits: { calibration: 15, regression: 6, independent: 9 },
  privacyAuditPassed: true,
}

const workflow: EvaluationWorkflowStatus = {
  datasetHash: dataset.datasetHash,
  reviewersComplete: false,
  adjudication: { exists: false, complete: false },
  runs: [],
  diffs: [],
  casebook: { total: 0, open: 0, resolved: 0, accepted: 0, retested: 0 },
}

function overview(
  reviewer: 'reviewer-a' | 'reviewer-b',
  complete: number,
): AnnotationWorkspaceOverview {
  return {
    dataset,
    reviewer,
    revision: `${reviewer}-revision`,
    progress: { complete, total: 30 },
    cases: Array.from({ length: 30 }, (_, index) => ({
      id: `case-${index + 1}`,
      source: index % 3 === 0 ? 'dsh' : index % 3 === 1 ? 'codex' : 'zcode',
      split: index < 15 ? 'calibration' : index < 21 ? 'regression' : 'independent',
      traits: [],
      complete: index < complete,
      criteriaComplete: index < complete ? 5 : 0,
      criteriaTotal: 5,
      requirementCount: index < complete ? 1 : 0,
      chainComplete: index < complete,
    })),
  }
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('EvaluationCenter', () => {
  it('distinguishes an outdated backend from an empty evaluation dataset', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      response({ error: 'not found' }, 404)))

    render(<EvaluationCenter onWorkspaceChange={vi.fn()} />)

    expect(await screen.findByText('评测中心不可用')).toBeTruthy()
    expect(screen.getByText(/本地服务仍是旧版本/)).toBeTruthy()
    expect(screen.queryByText('尚未准备评测数据集')).toBeNull()
  })

  it('prepares a private dataset from the empty state after explicit confirmation', async () => {
    let prepared = false
    const requests: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input)
      if (url === '/api/annotations/datasets' && init?.method === 'POST') {
        requests.push(JSON.parse(String(init.body)))
        prepared = true
        return response({ dataset, skipped: 0 }, 201)
      }
      if (url === '/api/annotations/datasets') {
        return response(prepared ? [dataset] : [])
      }
      if (url === '/api/annotations/datasets/private-v1/reviewer-a') {
        return response(overview('reviewer-a', 0))
      }
      if (url === '/api/annotations/datasets/private-v1/reviewer-b') {
        return response(overview('reviewer-b', 0))
      }
      if (url === '/api/annotations/datasets/private-v1/workflow') {
        return response(workflow)
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<EvaluationCenter onWorkspaceChange={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '准备数据集' }))

    expect(screen.getByRole('dialog', {
      name: '准备真实轨迹评测数据集',
    })).toBeTruthy()
    expect(screen.getByText(/读取本机 DSH、Codex 和 ZCode/)).toBeTruthy()
    expect(screen.getByText(/原始会话保持只读/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('目录标识'), {
      target: { value: 'private-v1' },
    })
    fireEvent.change(screen.getByLabelText('数据集 ID'), {
      target: { value: 'private-real' },
    })
    fireEvent.change(screen.getByLabelText('样本数'), {
      target: { value: '30' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认并开始准备' }))

    expect(await screen.findByRole('heading', { name: 'private-real' })).toBeTruthy()
    expect(requests).toEqual([{
      directoryId: 'private-v1',
      datasetId: 'private-real',
      datasetVersion: '1',
      count: 30,
      allowPartial: false,
    }])
    expect(localStorage.getItem('trajectory.evaluationDataset')).toBe('private-v1')
  })

  it('keeps the preparation dialog open when strict sampling cannot finish', async () => {
    vi.stubGlobal('fetch', vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input)
      if (url === '/api/annotations/datasets' && init?.method === 'POST') {
        return response({
          code: 'annotation_conflict',
          error: 'not enough stable source sessions: requested 30, produced 3',
        }, 409)
      }
      if (url === '/api/annotations/datasets') return response([])
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<EvaluationCenter onWorkspaceChange={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '准备数据集' }))
    fireEvent.click(screen.getByRole('button', { name: '确认并开始准备' }))

    expect((await screen.findByRole('alert')).textContent)
      .toContain('not enough stable source sessions')
    expect(screen.getByRole('dialog', {
      name: '准备真实轨迹评测数据集',
    })).toBeTruthy()
  })

  it('enters an existing matching dataset when preparation reports a conflict', async () => {
    let listed = false
    vi.stubGlobal('fetch', vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input)
      if (url === '/api/annotations/datasets' && init?.method === 'POST') {
        listed = true
        return response({
          code: 'annotation_conflict',
          error: 'evaluation dataset directory already exists: private-v1',
        }, 409)
      }
      if (url === '/api/annotations/datasets') {
        return response(listed ? [dataset] : [])
      }
      if (url.endsWith('/reviewer-a')) return response(overview('reviewer-a', 0))
      if (url.endsWith('/reviewer-b')) return response(overview('reviewer-b', 0))
      if (url.endsWith('/workflow')) return response(workflow)
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<EvaluationCenter onWorkspaceChange={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '准备数据集' }))
    fireEvent.change(screen.getByLabelText('目录标识'), {
      target: { value: 'private-v1' },
    })
    fireEvent.change(screen.getByLabelText('数据集 ID'), {
      target: { value: 'private-real' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认并开始准备' }))

    expect(await screen.findByRole('heading', { name: 'private-real' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(localStorage.getItem('trajectory.evaluationDataset')).toBe('private-v1')
  })

  it('prepares a new dataset version without replacing the current one', async () => {
    const regenerated: AnnotationDatasetSummary = {
      ...dataset,
      directoryId: 'private-v2',
      datasetVersion: '2',
      datasetHash: 'b'.repeat(64),
    }
    let datasets = [dataset]
    const requests: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input)
      if (url === '/api/annotations/datasets' && init?.method === 'POST') {
        requests.push(JSON.parse(String(init.body)))
        datasets = [dataset, regenerated]
        return response({ dataset: regenerated, skipped: 0 }, 201)
      }
      if (url === '/api/annotations/datasets') return response(datasets)
      if (url.endsWith('/reviewer-a')) return response(overview('reviewer-a', 0))
      if (url.endsWith('/reviewer-b')) return response(overview('reviewer-b', 0))
      if (url.endsWith('/workflow')) {
        return response({
          ...workflow,
          datasetHash: url.includes('private-v2')
            ? regenerated.datasetHash
            : dataset.datasetHash,
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<EvaluationCenter onWorkspaceChange={vi.fn()} />)
    await screen.findByRole('heading', { name: 'private-real' })
    fireEvent.click(screen.getByRole('button', { name: '重新准备' }))

    expect(screen.getByRole('dialog', {
      name: '重新准备真实轨迹评测数据集',
    })).toBeTruthy()
    expect((screen.getByLabelText('目录标识') as HTMLInputElement).value)
      .toBe('private-v2')
    expect((screen.getByLabelText('数据集 ID') as HTMLInputElement).value)
      .toBe('private-real')
    expect((screen.getByLabelText('版本') as HTMLInputElement).value).toBe('2')
    expect((screen.getByLabelText('样本数') as HTMLInputElement).value).toBe('30')
    expect(screen.getByText(/已有双标、裁决和 EvaluationRun 均会保留/)).toBeTruthy()
    expect(screen.getByText(/新版本不会继承旧标注/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '开始重新准备' }))

    await waitFor(() => {
      expect(localStorage.getItem('trajectory.evaluationDataset')).toBe('private-v2')
      expect((screen.getByLabelText('数据集') as HTMLSelectElement).value)
        .toBe('private-v2')
    })
    expect(requests).toEqual([{
      directoryId: 'private-v2',
      datasetId: 'private-real',
      datasetVersion: '2',
      count: 30,
      allowPartial: false,
    }])
    expect(datasets).toEqual([dataset, regenerated])
  })

  it('shows the evaluation workflow and independent reviewer progress', async () => {
    vi.stubGlobal('fetch', vi.fn(async (
      input: RequestInfo | URL,
    ) => {
      const url = String(input)
      if (url === '/api/annotations/datasets') return response([dataset])
      if (url === '/api/annotations/datasets/private-v1/reviewer-a') {
        return response(overview('reviewer-a', 4))
      }
      if (url === '/api/annotations/datasets/private-v1/reviewer-b') {
        return response(overview('reviewer-b', 0))
      }
      if (url === '/api/annotations/datasets/private-v1/workflow') {
        return response(workflow)
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<EvaluationCenter onWorkspaceChange={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'private-real' })).toBeTruthy()
    expect(screen.getByText('隐私审计已通过')).toBeTruthy()
    expect(screen.getByText('1. 样本准备')).toBeTruthy()
    expect(screen.getByText('2. 独立双标')).toBeTruthy()
    expect(screen.getByText('3. 分歧裁决')).toBeTruthy()
    expect(screen.getByText('4. 基线评测')).toBeTruthy()
    expect(screen.getByText('15')).toBeTruthy()
    expect(screen.getByText('6')).toBeTruthy()
    expect(screen.getByText('9')).toBeTruthy()
    await waitFor(() => {
      const reviewerCards = document.querySelectorAll('.evaluation-reviewer-card')
      expect(reviewerCards[0]?.textContent).toContain('4 / 30')
      expect(reviewerCards[1]?.textContent).toContain('0 / 30')
    })
    expect(screen.getByRole('button', { name: /继续标注/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /开始标注/ })).toBeTruthy()
  })

  it('enters one locked reviewer workspace and returns to the center', async () => {
    vi.stubGlobal('fetch', vi.fn(async (
      input: RequestInfo | URL,
    ) => {
      const url = String(input)
      if (url === '/api/annotations/datasets') return response([dataset])
      if (url === '/api/annotations/datasets/private-v1/reviewer-a') {
        return response(overview('reviewer-a', 0))
      }
      if (url === '/api/annotations/datasets/private-v1/reviewer-b') {
        return response(overview('reviewer-b', 0))
      }
      if (url === '/api/annotations/datasets/private-v1/workflow') {
        return response(workflow)
      }
      if (url === '/api/annotations/datasets/private-v1/reviewer-a/cases/case-1') {
        return response({
          datasetHash: dataset.datasetHash,
          reviewer: 'reviewer-a',
          revision: 'reviewer-a-revision',
          candidate: {
            id: 'case-1',
            source: 'dsh',
            split: 'calibration',
            traits: [],
            description: 'Private case',
          },
          annotation: {
            caseId: 'case-1',
            criteria: [
              'outcome',
              'reliability',
              'recovery',
              'efficiency',
              'observability',
            ].map(criterionId => ({
              criterionId,
              evidenceRecordIds: [],
              notes: '',
            })),
            requirements: [],
            chain: { evidenceRecordIds: [], notes: '' },
            notes: '',
          },
          records: [],
          requirementSuggestions: [],
          userTurns: [],
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<EvaluationCenter onWorkspaceChange={vi.fn()} />)
    await screen.findByRole('heading', { name: 'private-real' })
    const reviewerCards = document.querySelectorAll('.evaluation-reviewer-card')
    const reviewerAButton = reviewerCards[0]?.querySelector('button')
    expect(reviewerAButton).not.toBeNull()
    fireEvent.click(reviewerAButton!)

    expect(await screen.findByText('评测中心 / 人工双标 / Reviewer A')).toBeTruthy()
    expect(screen.queryByText('Reviewer B')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '返回评测中心' }))
    expect(await screen.findByRole('heading', { name: 'private-real' })).toBeTruthy()
  })

  it('advances workflow stages from agreement, adjudication, and matching runs', async () => {
    vi.stubGlobal('fetch', vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input)
      if (url === '/api/annotations/datasets') return response([dataset])
      if (url === '/api/annotations/datasets/private-v1/reviewer-a') {
        return response(overview('reviewer-a', 30))
      }
      if (url === '/api/annotations/datasets/private-v1/reviewer-b') {
        return response(overview('reviewer-b', 30))
      }
      if (url === '/api/annotations/datasets/private-v1/workflow') {
        return response({
          datasetHash: dataset.datasetHash,
          reviewersComplete: true,
          agreement: {
            completeCasesA: 30,
            completeCasesB: 30,
            totalCases: 30,
            criterionExactAgreement: 0.9,
            criterionKappa: 0.8,
            disagreements: 4,
          },
          adjudication: { exists: true, complete: true },
          runs: [{
            file: 'run.json',
            runId: 'run-1',
            createdAt: '2026-10-25T00:00:00.000Z',
            evaluatorId: 'local-trajectory',
            evaluatorBuildHash: 'build-1',
            split: 'calibration',
            assertionAgreement: 0.95,
            exactAgreement: 0.9,
            evaluatorError: 0,
          }],
          diffs: [],
          casebook: { total: 3, open: 1, resolved: 2, accepted: 1, retested: 2 },
        } satisfies EvaluationWorkflowStatus)
      }
      if (url === '/api/annotations/datasets/private-v1/workflow/runs/run-1') {
        return response({
          run: {
            runId: 'run-1',
            createdAt: '2026-10-25T00:00:00.000Z',
            split: 'calibration',
            assertionAgreement: 0.95,
            exactAgreement: 0.9,
            evaluatorError: 0,
            cases: [{
              caseId: 'case-1',
              assertionsPassed: 4,
              assertionsTotal: 5,
              exact: false,
              criteria: [{
                criterionId: 'outcome',
                verdict: 'warning',
                attribution: 'agent',
                evidenceRecordIds: ['record-baseline'],
              }],
              mismatches: [{
                criterionId: 'outcome',
                expected: 'pass',
                actual: 'warning',
              }],
            }],
          },
          diffs: [],
        } satisfies EvaluationRunDetails)
      }
      if (url === '/api/annotations/datasets/private-v1/workflow/run'
        && init?.method === 'POST') {
        return response({
          run: {
            runId: 'run-new',
            createdAt: '2026-10-25T00:01:00.000Z',
            split: 'calibration',
            assertionAgreement: 1,
            exactAgreement: 1,
            evaluatorError: 0,
            cases: [{
              caseId: 'case-1',
              assertionsPassed: 5,
              assertionsTotal: 5,
              exact: true,
              criteria: [{
                criterionId: 'outcome',
                verdict: 'pass',
                attribution: 'agent',
                evidenceRecordIds: ['record-001'],
              }],
              mismatches: [],
            }],
          },
          diff: {
            baselineRunId: 'run-1',
            candidateRunId: 'run-new',
            comparable: true,
            gateDecision: 'pass',
            gateReasons: [],
            improved: 0,
            regressed: 0,
            mixed: 0,
            inconclusive: 0,
            caseDirections: [{ caseId: 'case-1', direction: 'unchanged' }],
            changedCriteria: [],
          },
        } satisfies EvaluationRunResult)
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<EvaluationCenter onWorkspaceChange={vi.fn()} />)

    expect(await screen.findByText('双方标注已完成')).toBeTruthy()
    expect(screen.getByText('完整裁决已通过校验')).toBeTruthy()
    expect(screen.getByText('1 个 EvaluationRun')).toBeTruthy()
    expect(screen.getByText('90%')).toBeTruthy()
    expect(screen.getByText('0.800')).toBeTruthy()
    expect(screen.getByText('calibration · local-trajectory')).toBeTruthy()
    expect(screen.getByText('Badcase Casebook')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
    expect(await screen.findByText('warning · agent')).toBeTruthy()
    expect(document.querySelector('.evaluation-mismatch-list')?.textContent
      ?.replace(/\s+/g, ''))
      .toContain('outcome：期望pass，实际warning')
    fireEvent.click(screen.getByRole('button', { name: '运行 EvaluationRun' }))
    expect(await screen.findByText('calibration · 完成')).toBeTruthy()
    expect(screen.getByText(/assertion 100% · gate pass/)).toBeTruthy()
    expect(screen.getByText('Run 详情 · calibration')).toBeTruthy()
    expect(screen.getByText('baseline run-1 · gate pass')).toBeTruthy()
    expect(screen.getByText('case-1')).toBeTruthy()
    expect(screen.getByText('pass · agent')).toBeTruthy()
    expect(screen.getByText('证据 record-001')).toBeTruthy()
  })

  it('enters the gated adjudication workspace with reviewer comparison', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/annotations/datasets') return response([dataset])
      if (url === '/api/annotations/datasets/private-v1/reviewer-a') {
        return response(overview('reviewer-a', 30))
      }
      if (url === '/api/annotations/datasets/private-v1/reviewer-b') {
        return response(overview('reviewer-b', 30))
      }
      if (url === '/api/annotations/datasets/private-v1/workflow') {
        return response({
          datasetHash: dataset.datasetHash,
          reviewersComplete: true,
          agreement: {
            completeCasesA: 30,
            completeCasesB: 30,
            totalCases: 30,
            criterionExactAgreement: 0.9,
            disagreements: 1,
          },
          adjudication: { exists: true, complete: false },
          runs: [],
          diffs: [],
          casebook: { total: 0, open: 0, resolved: 0, accepted: 0, retested: 0 },
        } satisfies EvaluationWorkflowStatus)
      }
      if (url === '/api/annotations/datasets/private-v1/adjudicator') {
        return response({
          ...overview('reviewer-a', 0),
          reviewer: 'adjudicator',
        })
      }
      if (url === '/api/annotations/datasets/private-v1/adjudicator/cases/case-1') {
        return response({
          datasetHash: dataset.datasetHash,
          reviewer: 'adjudicator',
          revision: 'adjudicator-revision',
          candidate: {
            id: 'case-1',
            source: 'dsh',
            split: 'calibration',
            traits: [],
            description: 'Private case',
          },
          annotation: {
            caseId: 'case-1',
            criteria: [
              'outcome',
              'reliability',
              'recovery',
              'efficiency',
              'observability',
            ].map(criterionId => ({
              criterionId,
              evidenceRecordIds: [],
              notes: '',
            })),
            requirements: [],
            chain: { evidenceRecordIds: [], notes: '' },
            notes: '',
          },
          records: [],
          requirementSuggestions: [],
          userTurns: [],
          comparison: {
            criteria: [{
              criterionId: 'outcome',
              reviewerA: {
                verdict: 'pass',
                attribution: 'agent',
                evidenceRecordIds: ['record-001'],
              },
              reviewerB: {
                verdict: 'warning',
                attribution: 'agent',
                evidenceRecordIds: ['record-002'],
              },
            }],
            requirements: [],
            chain: {
              reviewerA: {
                continuity: 'normal',
                evidenceRecordIds: ['record-001'],
              },
              reviewerB: {
                continuity: 'missing',
                evidenceRecordIds: ['record-002'],
              },
            },
          },
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(<EvaluationCenter onWorkspaceChange={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /进入分歧裁决/ }))

    expect(await screen.findByText('Reviewer 分歧对照')).toBeTruthy()
    expect(screen.getByText(/A · pass \/agent · 证据 record-001/)).toBeTruthy()
    expect(screen.getByText(/B · warning \/agent · 证据 record-002/)).toBeTruthy()
    expect(screen.getByText(/A · normal · 证据 record-001/)).toBeTruthy()
    expect(screen.getByText(/B · missing · 证据 record-002/)).toBeTruthy()
  })
})
