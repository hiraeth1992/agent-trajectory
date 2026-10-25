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
  sources: { dsh: 10, codex: 10, zcode: 10 },
  splits: { calibration: 15, regression: 6, independent: 9 },
  privacyAuditPassed: true,
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

  it('shows the evaluation workflow and independent reviewer progress', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/annotations/datasets') return response([dataset])
      if (url === '/api/annotations/datasets/private-v1/reviewer-a') {
        return response(overview('reviewer-a', 4))
      }
      if (url === '/api/annotations/datasets/private-v1/reviewer-b') {
        return response(overview('reviewer-b', 0))
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
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/annotations/datasets') return response([dataset])
      if (url === '/api/annotations/datasets/private-v1/reviewer-a') {
        return response(overview('reviewer-a', 0))
      }
      if (url === '/api/annotations/datasets/private-v1/reviewer-b') {
        return response(overview('reviewer-b', 0))
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
})
