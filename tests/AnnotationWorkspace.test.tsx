// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AnnotationWorkspace,
  annotationSourceLabel,
} from '../src/components/AnnotationWorkspace'
import type {
  AnnotationCaseWorkspace,
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
  cases: 1,
  requestedCases: 1,
  skippedCases: 0,
  allowPartial: false,
  sources: {
    dsh: 1,
    codex: 0,
    zcode: 0,
    claude: 0,
    'doubao-work': 0,
    workbuddy: 0,
    qoder: 0,
    opencode: 0,
  },
  splits: { calibration: 1, regression: 0, independent: 0 },
  privacyAuditPassed: true,
}

const overview: AnnotationWorkspaceOverview = {
  dataset,
  reviewer: 'reviewer-a',
  revision: 'revision-1',
  progress: { complete: 0, total: 1 },
  cases: [{
    id: 'real-dsh-case',
    source: 'dsh',
    split: 'calibration',
    traits: ['error-present'],
    complete: false,
    criteriaComplete: 0,
    criteriaTotal: 5,
    requirementCount: 0,
    chainComplete: false,
  }],
}

const workspace: AnnotationCaseWorkspace = {
  datasetHash: dataset.datasetHash,
  reviewer: 'reviewer-a',
  revision: overview.revision,
  candidate: {
    id: 'real-dsh-case',
    source: 'dsh',
    split: 'calibration',
    traits: ['error-present'],
    description: 'Private DSH trajectory',
  },
  annotation: {
    caseId: 'real-dsh-case',
    criteria: [
      'outcome',
      'reliability',
      'recovery',
      'efficiency',
      'observability',
    ].map(criterionId => ({
      criterionId: criterionId as 'outcome',
      evidenceRecordIds: [],
      notes: '',
    })),
    requirements: [],
    chain: {
      evidenceRecordIds: [],
      notes: '',
    },
    notes: '',
  },
  records: [{
    id: 'record-001',
    turn: 1,
    step: 0,
    kind: 'user',
    title: '用户',
    summary: '修复并验证',
    status: 'complete',
    startTime: 1,
    endTime: 1,
    hasInput: true,
    hasOutput: false,
    hasError: false,
  }, {
    id: 'record-002',
    turn: 1,
    step: 1,
    kind: 'tool',
    title: 'exec_command',
    summary: '测试通过',
    status: 'complete',
    startTime: 2,
    endTime: 3,
    hasInput: true,
    hasOutput: true,
    hasError: false,
  }],
  requirementSuggestions: [{
    id: 'requirement-001',
    text: '修复并验证',
    recordId: 'record-001',
    turn: 1,
  }],
  userTurns: [1],
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AnnotationWorkspace', () => {
  it('labels all supported sources without collapsing them to ZCode', () => {
    expect([
      annotationSourceLabel('dsh'),
      annotationSourceLabel('codex'),
      annotationSourceLabel('zcode'),
      annotationSourceLabel('claude'),
      annotationSourceLabel('doubao-work'),
      annotationSourceLabel('workbuddy'),
      annotationSourceLabel('qoder'),
      annotationSourceLabel('opencode'),
    ]).toEqual([
      'DSH',
      'Codex',
      'ZCode',
      'Claude Code',
      '豆包工作',
      'WorkBuddy',
      'Qoder',
      'OpenCode',
    ])
  })

  it('offers a focused cases, evidence, and form workflow on narrow screens', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/annotations/datasets/private-v1/reviewer-a') {
        return response(overview)
      }
      if (url === '/api/annotations/datasets/private-v1/reviewer-a/cases/real-dsh-case') {
        return response(workspace)
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(
      <AnnotationWorkspace
        dataset={dataset}
        reviewer="reviewer-a"
        onExit={vi.fn()}
      />,
    )

    const caseTab = await screen.findByRole('tab', { name: '1. 案例' })
    const evidenceTab = screen.getByRole('tab', { name: '2. 证据' })
    const formTab = screen.getByRole('tab', { name: '3. 标注' })
    expect(caseTab.getAttribute('aria-selected')).toBe('true')

    fireEvent.click(evidenceTab)
    expect(evidenceTab.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('.annotation-evidence-pane')?.className)
      .toContain('mobile-active')

    fireEvent.click(formTab)
    expect(formTab.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('.annotation-form-pane')?.className)
      .toContain('mobile-active')
  })

  it('uses Chinese controls and saves protocol-compatible English values', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (url === '/api/annotations/datasets/private-v1/reviewer-a') {
        return response(overview)
      }
      if (url === '/api/annotations/datasets/private-v1/reviewer-a/cases/real-dsh-case'
        && init?.method !== 'PUT') {
        return response(workspace)
      }
      if (url === '/api/annotations/datasets/private-v1/reviewer-a/cases/real-dsh-case'
        && init?.method === 'PUT') {
        return response({
          revision: 'revision-2',
          progress: { complete: 0, total: 1 },
          case: {
            ...overview.cases[0],
            criteriaComplete: 1,
          },
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(
      <AnnotationWorkspace
        dataset={dataset}
        reviewer="reviewer-a"
        onExit={vi.fn()}
      />,
    )

    expect(await screen.findByText('评测中心 / 人工双标 / Reviewer A')).toBeTruthy()
    expect(await screen.findByText('最终结果')).toBeTruthy()
    expect(screen.getAllByText('Reviewer A')).toHaveLength(2)
    expect(screen.queryByText('Reviewer B')).toBeNull()

    const selects = screen.getAllByRole('combobox')
    const outcomeVerdict = selects.find(select =>
      select.closest('.annotation-form-card')?.textContent?.includes('最终结果')
      && select.parentElement?.textContent?.includes('判定结果'))
    const outcomeAttribution = selects.find(select =>
      select.closest('.annotation-form-card')?.textContent?.includes('最终结果')
      && select.parentElement?.textContent?.includes('问题归因'))
    expect(outcomeVerdict).toBeDefined()
    expect(outcomeAttribution).toBeDefined()
    fireEvent.change(outcomeVerdict!, { target: { value: 'pass' } })
    fireEvent.change(outcomeAttribution!, { target: { value: 'agent' } })

    fireEvent.click(screen.getAllByRole('button', { name: /选择证据/ })[0]!)
    fireEvent.click(screen.getAllByTitle('加入或移除当前评测项的证据')[0]!)
    fireEvent.change(screen.getAllByPlaceholderText('写明你依据什么证据作出判断')[0]!, {
      target: { value: '测试结果证明要求已完成。' },
    })

    fireEvent.click(screen.getByRole('button', { name: /轮 1 · 修复并验证/ }))
    expect(screen.getByDisplayValue('修复并验证')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^保存$/ }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '已保存' })).toBeTruthy()
    })
    const saveRequest = requests.find(item => item.init?.method === 'PUT')
    expect(saveRequest).toBeDefined()
    const body = JSON.parse(String(saveRequest!.init!.body)) as {
      datasetHash: string
      revision: string
      annotation: AnnotationCaseWorkspace['annotation']
    }
    expect(body).toMatchObject({
      datasetHash: dataset.datasetHash,
      revision: 'revision-1',
      annotation: {
        caseId: 'real-dsh-case',
      },
    })
    expect(body.annotation.criteria[0]).toMatchObject({
      criterionId: 'outcome',
      verdict: 'pass',
      attribution: 'agent',
      evidenceRecordIds: ['record-001'],
      notes: '测试结果证明要求已完成。',
    })
    expect(body.annotation.requirements[0]).toMatchObject({
      id: 'requirement-001',
      text: '修复并验证',
      required: true,
      evidenceRecordIds: ['record-001'],
    })
  })

  it('loads record details only after the user opens one record', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/annotations/datasets/private-v1/reviewer-a') {
        return response(overview)
      }
      if (url === '/api/annotations/datasets/private-v1/reviewer-a/cases/real-dsh-case') {
        return response(workspace)
      }
      if (url.endsWith('/records/record-002')) {
        return response({
          ...workspace.records[1],
          input: { cmd: 'npm test' },
          output: 'Tests 2 passed',
        })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <AnnotationWorkspace
        dataset={dataset}
        reviewer="reviewer-a"
        onExit={vi.fn()}
      />,
    )
    fireEvent.change(await screen.findByRole('combobox', { name: '记录筛选' }), {
      target: { value: 'all' },
    })
    expect(await screen.findByText('测试通过')).toBeTruthy()
    expect(fetchMock.mock.calls.some(([input]) =>
      String(input).includes('/records/'))).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /测试通过/ }))
    expect(await screen.findByText(/Tests 2 passed/)).toBeTruthy()
    expect(fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/records/'))).toHaveLength(1)
  })

  it('ignores stale record responses when requests resolve out of order', async () => {
    let resolveFirst!: (value: Response) => void
    let resolveSecond!: (value: Response) => void
    const first = new Promise<Response>(resolve => {
      resolveFirst = resolve
    })
    const second = new Promise<Response>(resolve => {
      resolveSecond = resolve
    })
    const extendedWorkspace = {
      ...workspace,
      records: [
        ...workspace.records,
        {
          ...workspace.records[1]!,
          id: 'record-003',
          summary: '第二条测试记录',
        },
      ],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/annotations/datasets/private-v1/reviewer-a') {
        return response(overview)
      }
      if (url === '/api/annotations/datasets/private-v1/reviewer-a/cases/real-dsh-case') {
        return response(extendedWorkspace)
      }
      if (url.endsWith('/records/record-002')) return first
      if (url.endsWith('/records/record-003')) return second
      throw new Error(`unexpected request: ${url}`)
    }))

    render(
      <AnnotationWorkspace
        dataset={dataset}
        reviewer="reviewer-a"
        onExit={vi.fn()}
      />,
    )
    fireEvent.change(await screen.findByRole('combobox', { name: '记录筛选' }), {
      target: { value: 'all' },
    })
    await screen.findByText('第二条测试记录')
    fireEvent.click(screen.getByRole('button', { name: /测试通过/ }))
    fireEvent.click(screen.getByRole('button', { name: /第二条测试记录/ }))

    resolveSecond(response({
      ...extendedWorkspace.records[2],
      output: 'SECOND_RESPONSE',
    }))
    expect(await screen.findByText(/SECOND_RESPONSE/)).toBeTruthy()

    resolveFirst(response({
      ...extendedWorkspace.records[1],
      output: 'STALE_FIRST_RESPONSE',
    }))
    await waitFor(() => {
      expect(screen.queryByText(/STALE_FIRST_RESPONSE/)).toBeNull()
    })
    expect(screen.getByText(/SECOND_RESPONSE/)).toBeTruthy()
  })

  it('keeps case navigation disabled while a save lease is active', async () => {
    let resolveSave!: (value: Response) => void
    const saveResponse = new Promise<Response>(resolve => {
      resolveSave = resolve
    })
    const secondCase = {
      ...workspace,
      candidate: { ...workspace.candidate, id: 'real-dsh-case-2' },
      annotation: { ...workspace.annotation, caseId: 'real-dsh-case-2' },
    }
    const twoCases = {
      ...overview,
      progress: { complete: 0, total: 2 },
      cases: [
        overview.cases[0]!,
        { ...overview.cases[0]!, id: 'real-dsh-case-2' },
      ],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/annotations/datasets/private-v1/reviewer-a') {
        return response(twoCases)
      }
      if (url.endsWith('/cases/real-dsh-case') && init?.method !== 'PUT') {
        return response(workspace)
      }
      if (url.endsWith('/cases/real-dsh-case-2')) return response(secondCase)
      if (url.endsWith('/cases/real-dsh-case') && init?.method === 'PUT') {
        return saveResponse
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    render(
      <AnnotationWorkspace
        dataset={dataset}
        reviewer="reviewer-a"
        onExit={vi.fn()}
      />,
    )
    await screen.findByText('最终结果')
    fireEvent.click(screen.getByRole('button', { name: /^保存$/ }))
    expect(await screen.findByRole('button', { name: /保存中/ })).toBeTruthy()
    const nextCase = screen.getByRole('button', { name: /2\. DSH/ })
    expect(nextCase).toHaveProperty('disabled', true)
    fireEvent.click(nextCase)

    resolveSave(response({
      revision: 'revision-2',
      progress: { complete: 0, total: 2 },
      case: overview.cases[0],
    }))
    await waitFor(() => {
      expect(screen.getByText('real-dsh-case')).toBeTruthy()
      expect(screen.queryByText('real-dsh-case-2')).toBeNull()
    })
  })

  it('keeps edits made during an in-flight save marked as unsaved', async () => {
    let resolveSave!: (value: Response) => void
    const saveResponse = new Promise<Response>(resolve => {
      resolveSave = resolve
    })
    vi.stubGlobal('fetch', vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input)
      if (url === '/api/annotations/datasets/private-v1/reviewer-a') {
        return response(overview)
      }
      if (url.endsWith('/cases/real-dsh-case') && init?.method !== 'PUT') {
        return response(workspace)
      }
      if (url.endsWith('/cases/real-dsh-case') && init?.method === 'PUT') {
        return saveResponse
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const onExit = vi.fn()

    render(
      <AnnotationWorkspace
        dataset={dataset}
        reviewer="reviewer-a"
        onExit={onExit}
      />,
    )

    await screen.findByText('最终结果')
    const notes = screen.getAllByPlaceholderText(
      '写明你依据什么证据作出判断',
    )[0]!
    fireEvent.change(notes, { target: { value: '提交版本' } })
    fireEvent.click(screen.getByRole('button', { name: /^保存$/ }))
    await screen.findByRole('button', { name: /保存中/ })
    fireEvent.change(notes, { target: { value: '保存期间的新编辑' } })
    resolveSave(response({
      revision: 'revision-2',
      progress: { complete: 0, total: 1 },
      case: overview.cases[0],
    }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^保存$/ })).toBeTruthy()
    })
    expect(notes).toHaveProperty('value', '保存期间的新编辑')
    fireEvent.click(screen.getByRole('button', { name: '返回评测中心' }))
    expect(confirm).toHaveBeenCalledOnce()
    expect(onExit).not.toHaveBeenCalled()
  })
})
