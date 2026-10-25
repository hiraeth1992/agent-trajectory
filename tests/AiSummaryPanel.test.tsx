// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiSummaryPanel } from '../src/components/AiSummaryPanel'
import type { AiSummaryGenerationEvent } from '../src/ai-summary-types'
import type { TrajectoryAnalysis } from '../src/trajectory-analysis'

const analysis: TrajectoryAnalysis = {
  objective: 'synthetic',
  objectiveLabel: '会话目标',
  outcome: {
    label: 'synthetic',
    summary: 'synthetic',
    tone: 'neutral',
    confidence: 'low',
    evidenceRecordIds: [],
  },
  stats: {
    durationMs: 0,
    turns: 0,
    steps: 0,
    errors: 0,
    retries: 0,
    recovered: 0,
  },
  steps: [],
  costSteps: [],
  corrections: [],
  evaluations: [],
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  })
}

function options(id = 'A') {
  return {
    source: 'codex',
    sourceSessionId: id,
    selected: { adapterId: 'fake', model: `model-${id}` },
    selectedModules: ['outcome'],
    moduleStatus: { outcome: 'missing' },
    adapters: [{
      id: 'fake',
      label: 'Fake',
      type: 'openai-compatible',
      available: true,
      models: [{
        id: `model-${id}`,
        adapterId: 'fake',
        adapterType: 'openai-compatible',
        label: `model-${id}`,
      }],
    }],
  }
}

function preview() {
  return {
    modules: ['outcome'],
    factStepCount: 0,
    estimatedInputTokens: 0,
    facts: {},
    factsHashes: { outcome: 'A' },
  }
}

function cached(id: string) {
  return {
    modules: {
      outcome: {
        value: {
          headline: `result-${id}`,
          summary: id,
          verification: id,
          unresolved: [],
          evidenceRecordIds: [],
        },
        generatedAt: 1,
        factsHash: id,
        adapterId: 'fake',
        model: `model-${id}`,
        promptVersion: 4,
      },
    },
    lastRun: {
      modules: ['outcome'],
      model: `model-${id}`,
      generatedAt: 1,
      adapterId: 'fake',
      promptVersion: 4,
    },
    durationMs: 1,
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AiSummaryPanel request lifecycle', () => {
  it('selects the recalculation scope in a dialog and remembers it immediately', async () => {
    let savedSettings: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/preview')) return json(preview())
      if (url === '/api/summary/settings') {
        if (init?.method === 'PUT') {
          savedSettings = JSON.parse(String(init.body)) as Record<string, unknown>
          return json(savedSettings)
        }
        return json({
          mappings: [],
          openAiCompatible: [],
          lastModules: ['outcome'],
        })
      }
      return json(options())
    }))
    render(
      <AiSummaryPanel
        analysis={analysis}
        source="codex"
        sourceSessionId="A"
      />,
    )
    await screen.findByLabelText('选择增强模型')

    fireEvent.click(screen.getByRole('button', { name: /重算范围/ }))
    const dialog = await screen.findByRole('dialog', { name: '选择重算范围' })
    fireEvent.click(within(dialog).getByRole('button', { name: '会话目标' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '执行结论' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '确认重算范围' }))

    await waitFor(() => expect(savedSettings?.lastModules).toEqual(['objective']))
    expect(screen.queryByRole('dialog', { name: '选择重算范围' })).toBeNull()
    expect(screen.getByRole('button', { name: /重算范围/ }).textContent)
      .toContain('会话目标')
  })

  it('shows live generation stages and lets the user cancel', async () => {
    const encoder = new TextEncoder()
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
    })
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/preview')) return json(preview())
      if (url.endsWith('/generate-stream')) {
        init?.signal?.addEventListener('abort', () => streamController.close())
        return new Response(stream, {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      }
      return json(options())
    })
    vi.stubGlobal('fetch', fetchMock)
    render(
      <AiSummaryPanel
        analysis={analysis}
        source="codex"
        sourceSessionId="A"
      />,
    )
    await screen.findByLabelText('选择增强模型')

    fireEvent.click(screen.getByRole('button', { name: '重算 1 个模块' }))
    await act(async () => {
      const event: AiSummaryGenerationEvent = {
        type: 'progress',
        stage: 'preparing',
        message: '正在准备脱敏事实包',
      }
      streamController.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
    })
    expect(await screen.findByText('正在准备脱敏事实包')).toBeTruthy()

    await act(async () => {
      const event: AiSummaryGenerationEvent = {
        type: 'progress',
        stage: 'generating',
        message: '正在请求增强模型',
      }
      streamController.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
    })
    expect(await screen.findByText('正在请求增强模型')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '取消 AI 增强' }))
    await waitFor(() => expect(
      screen.queryByRole('button', { name: '取消 AI 增强' }),
    ).toBeNull())
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/generate-stream'),
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('ignores a completed generation from the previous session', async () => {
    let completeA!: (response: Response) => void
    const pendingA = new Promise<Response>(resolve => {
      completeA = resolve
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/A/') && url.endsWith('/generate')) return pendingA
      const id = url.includes('/A/') ? 'A' : 'B'
      if (url.includes('/preview')) {
        return json({
          modules: ['outcome'],
          factStepCount: 0,
          estimatedInputTokens: 0,
          facts: {},
          factsHashes: { outcome: id },
        })
      }
      return json({
        ...options(id),
        moduleStatus: { outcome: 'current' },
        cached: id === 'B' ? cached(id) : undefined,
      })
    }))
    const onSummaryChange = vi.fn()
    const view = render(
      <AiSummaryPanel
        analysis={analysis}
        source="codex"
        sourceSessionId="A"
        onSummaryChange={onSummaryChange}
      />,
    )
    await waitFor(() => expect(
      (screen.getByLabelText('选择增强模型') as HTMLSelectElement).value,
    ).toContain('model-A'))
    fireEvent.click(screen.getByRole('button', { name: '重算 1 个模块' }))

    view.rerender(
      <AiSummaryPanel
        analysis={analysis}
        source="codex"
        sourceSessionId="B"
        onSummaryChange={onSummaryChange}
      />,
    )
    await waitFor(() => expect(
      (screen.getByLabelText('选择增强模型') as HTMLSelectElement).value,
    ).toContain('model-B'))

    await act(async () => {
      completeA(json(cached('A')))
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect((screen.getByLabelText('选择增强模型') as HTMLSelectElement).value)
      .toContain('model-B')
    expect(onSummaryChange.mock.calls.at(-1)?.[0]?.modules.outcome.value.headline)
      .toBe('result-B')
  })
})
