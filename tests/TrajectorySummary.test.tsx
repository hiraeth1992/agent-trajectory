// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrajectorySummary } from '../src/components/TrajectorySummary'
import type { TrajectoryAnalysis } from '../src/trajectory-analysis'

function analysis(): TrajectoryAnalysis {
  const steps = [
    {
      id: 'step:slow',
      recordId: 'slow',
      recordIds: ['slow'],
      turn: 1,
      step: 3,
      kind: 'tool' as const,
      action: '慢速验证',
      detail: '耗时较高',
      reason: '测试耗时排序',
      reasonLevel: 'fact' as const,
      execution: '运行慢速验证',
      result: '验证通过',
      status: 'complete' as const,
      durationMs: 200,
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    },
    {
      id: 'step:large',
      recordId: 'large',
      recordIds: ['large'],
      turn: 1,
      step: 1,
      kind: 'model' as const,
      action: '大模型调用',
      detail: '100 Token',
      reason: '测试',
      reasonLevel: 'fact' as const,
      execution: '执行大模型调用',
      result: '完成',
      status: 'complete' as const,
      durationMs: 100,
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    },
    {
      id: 'step:small',
      recordId: 'small',
      recordIds: ['small'],
      turn: 1,
      step: 2,
      kind: 'model' as const,
      action: '小模型调用',
      detail: '50 Token',
      reason: '测试',
      reasonLevel: 'fact' as const,
      execution: '执行小模型调用',
      result: '完成',
      status: 'complete' as const,
      durationMs: 50,
      usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
    },
  ]
  return {
    objective: '检查 Token 图表',
    objectiveLabel: '会话目标',
    outcome: {
      label: '完成',
      summary: 'fixture',
      tone: 'positive',
      confidence: 'high',
      evidenceRecordIds: [],
    },
    stats: {
      durationMs: 20,
      turns: 1,
      steps: 2,
      errors: 0,
      retries: 0,
      recovered: 0,
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      allocatedTokens: 150,
      unallocatedTokens: 0,
      tokenAllocationCoverage: 1,
    },
    steps,
    costSteps: steps,
    corrections: [],
    evaluations: [],
  }
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    source: 'zcode',
    sourceSessionId: 'summary-test',
    adapters: [],
    selectedReason: 'unavailable',
    cacheStatus: 'missing',
    factsHash: 'facts',
    factStepCount: 3,
    estimatedInputTokens: 100,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TrajectorySummary cost chart', () => {
  it('keeps four equal compact metrics and gives the last Token metric more space', () => {
    const { container } = render(
      <TrajectorySummary
        analysis={analysis()}
        source="zcode"
        sourceSessionId="summary-test"
        sessionMeta={{
          eventCount: 10,
          recordCount: 4,
          eventTypeCount: 2,
          completedTurns: 1,
          createdAt: 1_000,
          updatedAt: 6_000,
        }}
        onOpenRecord={() => {}}
      />,
    )

    const metrics = [...container.querySelectorAll('.summary-stat')]
    expect(metrics.map(metric => metric.querySelector('span')?.textContent)).toEqual([
      '墙钟耗时 / 活跃耗时',
      '事件 / 记录',
      '轮次 / 步骤',
      '异常 / 已恢复',
      'Token',
    ])
    expect(metrics[0]?.querySelector('strong')?.textContent).toBe('5.00 s / 20 ms')
    expect(metrics.at(-1)?.className).toContain('summary-stat-token')
  })

  it('scales token bar length by the largest step instead of filling every row', () => {
    const { container } = render(
      <TrajectorySummary
        analysis={analysis()}
        source="zcode"
        sourceSessionId="summary-test"
        onOpenRecord={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Token' }))

    const bars = [...container.querySelectorAll<HTMLElement>('.token-segments')]
    expect(bars.map(bar => bar.style.width)).toEqual(['100%', '50%', '10%'])
  })

  it('shows additive cache reads instead of clipping them to input tokens', () => {
    const value = analysis()
    value.costSteps = [{
      ...value.costSteps[0]!,
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 90,
        totalTokens: 104,
      },
    }]
    value.steps = value.costSteps
    value.stats = {
      ...value.stats,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 90,
      totalTokens: 104,
      allocatedTokens: 104,
      unallocatedTokens: 0,
      tokenAllocationCoverage: 1,
    }
    const { container } = render(
      <TrajectorySummary
        analysis={value}
        source="dsh"
        sourceSessionId="summary-test"
        onOpenRecord={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Token' }))

    expect(container.querySelector<HTMLElement>(
      '.token-segments .token-cache-read',
    )?.style.width)
      .toBe(`${90 / 104 * 100}%`)
    expect(container.querySelector('.token-segments .token-other')).toBeNull()
  })

  it('uses projection bounds to keep wall time outside active time', () => {
    const { container } = render(
      <TrajectorySummary
        analysis={analysis()}
        source="zcode"
        sourceSessionId="summary-test"
        sessionMeta={{
          eventCount: 10,
          recordCount: 4,
          eventTypeCount: 2,
          completedTurns: 1,
          createdAt: 5_000,
          updatedAt: 5_021,
          projectionStartTime: 1_000,
          projectionEndTime: 5_000,
        }}
        onOpenRecord={() => {}}
      />,
    )

    const metric = container.querySelector('.summary-stat strong')
    expect(metric?.textContent).toBe('4.02 s / 20 ms')
  })

  it('shows token allocation coverage and the unallocated amount', () => {
    const value = analysis()
    value.stats = {
      ...value.stats,
      allocatedTokens: 100,
      unallocatedTokens: 50,
      overallocatedTokens: 0,
      tokenAllocationCoverage: 2 / 3,
    }

    render(
      <TrajectorySummary
        analysis={value}
        source="codex"
        sourceSessionId="summary-test"
        onOpenRecord={() => {}}
      />,
    )

    expect(screen.getByText(/步骤覆盖 67% · 未分配 50/)).toBeTruthy()
  })

  it('sorts logical steps descending by the selected cost metric without a sort selector', () => {
    const { container } = render(
      <TrajectorySummary
        analysis={analysis()}
        source="zcode"
        sourceSessionId="summary-test"
        onOpenRecord={() => {}}
      />,
    )
    expect(screen.getByText('全部轮次 · 按耗时从高到低，显示前 24 个逻辑步骤')).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: '排序成本步骤' })).toBeNull()
    const names = () => [...container.querySelectorAll('.cost-name strong')]
      .map(element => element.textContent)

    expect(names()).toEqual(['慢速验证', '大模型调用', '小模型调用'])

    fireEvent.click(screen.getByRole('button', { name: 'Token' }))

    expect(screen.getByText('全部轮次 · 按Token从高到低，显示前 24 个逻辑步骤')).toBeTruthy()
    expect(names()).toEqual(['大模型调用', '小模型调用', '慢速验证'])

    fireEvent.change(screen.getByRole('combobox', { name: '筛选成本轮次' }), {
      target: { value: '1' },
    })

    expect(screen.getByText('第 1 轮 · 按Token从高到低，显示前 24 个逻辑步骤')).toBeTruthy()
    expect(names()).toEqual(['大模型调用', '小模型调用', '慢速验证'])
  })

  it('filters token types and recalculates ranking, values, and bar proportions', () => {
    const value = analysis()
    value.costSteps = [
      {
        ...value.costSteps[0]!,
        id: 'mostly-input',
        recordId: 'mostly-input',
        action: '输入为主',
        usage: { inputTokens: 100, outputTokens: 1, totalTokens: 101 },
      },
      {
        ...value.costSteps[1]!,
        id: 'mostly-output',
        recordId: 'mostly-output',
        action: '输出为主',
        usage: { inputTokens: 10, outputTokens: 50, totalTokens: 60 },
      },
    ]
    value.steps = value.costSteps
    const { container } = render(
      <TrajectorySummary
        analysis={value}
        source="zcode"
        sourceSessionId="summary-test"
        onOpenRecord={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Token' }))

    for (const label of [
      '非缓存输入', '推理输出', '缓存读取', '缓存写入', '其他',
    ]) {
      fireEvent.click(screen.getByRole('button', { name: label }))
    }

    const names = [...container.querySelectorAll('.cost-name strong')]
      .map(element => element.textContent)
    const values = [...container.querySelectorAll('.cost-value')]
      .map(element => element.textContent)
    const bars = [...container.querySelectorAll<HTMLElement>('.token-segments')]
    expect(names).toEqual(['输出为主', '输入为主'])
    expect(values).toEqual(['50', '1'])
    expect(bars.map(bar => bar.style.width)).toEqual(['100%', '2%'])
    expect(bars[0]?.querySelector<HTMLElement>('.token-output')?.style.width)
      .toBe('100%')

    const output = screen.getByRole('button', { name: '输出' })
    fireEvent.click(output)
    expect(output.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: /^全部$/ }))
    expect(screen.getByRole('button', { name: '非缓存输入' })
      .getAttribute('aria-pressed')).toBe('true')
  })
})

describe('TrajectorySummary diagnosis entry', () => {
  it('replaces outcome evidence with one prompt-copy diagnosis trigger', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText },
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: 'prepared',
      protocol: 'trajectory-diagnosis-v1',
      snapshotId: 'snapshot-12345678901234567890',
      prompt: 'summary diagnosis prompt',
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const { container } = render(
      <TrajectorySummary
        analysis={analysis()}
        source="zcode"
        sourceSessionId="summary-test"
        onOpenRecord={() => {}}
      />,
    )

    const outcome = container.querySelector('.summary-outcome')
    const stats = container.querySelector('.summary-stat-strip')
    const story = container.querySelector('.trajectory-story-panel')
    expect(outcome).not.toBeNull()
    expect(stats).not.toBeNull()
    expect(story).not.toBeNull()
    expect(outcome!.compareDocumentPosition(stats!)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(stats!.compareDocumentPosition(story!)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelector('.trajectory-diagnosis-panel')).toBeNull()
    expect(screen.queryByText('查看结论证据')).toBeNull()
    const diagnosis = screen.getByRole('button', { name: '本地 Agent 诊断' })
    expect(outcome?.contains(diagnosis)).toBe(true)
    expect(diagnosis.querySelector('svg')).not.toBeNull()

    fireEvent.click(diagnosis)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/diagnosis/prompt',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: { source: 'zcode', sessionId: 'summary-test' },
        }),
      },
    ))
    expect(writeText).toHaveBeenCalledWith('summary diagnosis prompt')
    expect(await screen.findByRole('dialog', { name: '已复制 Prompt' })).toBeTruthy()
    expect(screen.getByText('打开新会话开启诊断')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe('TrajectorySummary optimization panel', () => {
  it('places recommendations below evaluation, expands details, and opens evidence', async () => {
    const value = analysis()
    value.optimizations = [{
      id: 'optimization:retry:slow',
      category: 'retry',
      title: '为参数错误增加重试前检查',
      priority: 'high',
      confidence: 'high',
      measures: ['code', 'hook'],
      effort: 'low',
      observation: '观察到相同参数错误重复出现。',
      cause: '缺少输入校验。',
      action: '参数错误必须调整输入后才能重试。',
      target: '工具封装',
      expectedBenefit: '减少确定性错误。',
      verification: '分别测试参数错误和网络超时。',
      limitation: '不自动安装或修改。',
      executionActions: [{
        kind: 'rule',
        title: '增加参数错误规则',
        target: '项目根目录 AGENTS.md',
        instruction: '加入参数错误重试限制。',
        content: '- 参数错误必须调整输入后重试。',
        verification: '确认相同参数不会原样重试。',
      }],
      occurrences: 2,
      evidence: [{ recordId: 'slow', turn: 1, step: 3 }],
    }]
    const opened: string[] = []
    const { container } = render(
      <TrajectorySummary
        analysis={value}
        source="zcode"
        sourceSessionId="summary-test"
        onOpenRecord={recordId => opened.push(recordId)}
      />,
    )

    expect(await screen.findByText('优化建议')).toBeTruthy()
    const column = container.querySelector('.summary-insight-column')
    const evaluation = column?.querySelector('.evaluation-panel')
    const optimization = column?.querySelector('.optimization-panel')
    expect(column).not.toBeNull()
    expect(evaluation).not.toBeNull()
    expect(optimization).not.toBeNull()
    expect(evaluation!.compareDocumentPosition(optimization!)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const item = screen.getByRole('button', { name: /为参数错误增加重试前检查/ })
    expect(item.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(item)
    expect(item.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('缺少输入校验。')).toBeTruthy()
    expect(screen.getByText('可执行动作')).toBeTruthy()
    expect(screen.getByText(/目标：项目根目录 AGENTS\.md/)).toBeTruthy()
    expect(screen.getByText(/参数错误必须调整输入后重试/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '复制建议' })).toBeNull()
    expect(screen.getByRole('button', { name: '复制动作' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看证据' }))
    expect(opened).toEqual(['slow'])
  })

  it('renders an honest empty state without inventing recommendations', async () => {
    render(
      <TrajectorySummary
        analysis={analysis()}
        source="zcode"
        sourceSessionId="summary-test"
        onOpenRecord={() => {}}
      />,
    )
    expect(await screen.findByText('暂未发现证据充分的优化项')).toBeTruthy()
    expect(screen.getByText(/不会为了填充面板生成建议/)).toBeTruthy()
  })
})

describe('TrajectorySummary story linkage', () => {
  it('selects an aggregate on click and opens turn details only on double click', async () => {
    const value = analysis()
    value.steps = [
      ...value.steps,
      {
        id: 'step:edit',
        recordId: 'edit-record',
        recordIds: ['edit-record'],
        turn: 2,
        step: 1,
        kind: 'tool',
        action: '修改故事线实现',
        detail: '修改故事线实现',
        reason: '根据确认方案接入故事线',
        reasonLevel: 'fact',
        execution: '修改故事线实现',
        result: '故事线实现完成',
        status: 'complete',
        durationMs: 80,
        usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
      },
    ]
    value.stats.turns = 2
    value.stats.steps = value.steps.length
    const openRecord = vi.fn()
    const { container } = render(
      <TrajectorySummary
        analysis={value}
        source="zcode"
        sourceSessionId="summary-test"
        onOpenRecord={openRecord}
      />,
    )

    expect(screen.getByRole('region', { name: '执行故事线' })).toBeTruthy()
    const editStage = screen.getByRole('button', {
      name: /修改实现，第 2 轮，1 步/,
    })
    fireEvent.click(editStage)

    const turnTwo = [...container.querySelectorAll<HTMLButtonElement>(
      '.decision-turn-toggle',
    )].find(button => button.textContent?.includes('第 2 轮'))
    expect(turnTwo?.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText('故事线实现完成')).toBeTruthy()
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled()

    fireEvent.doubleClick(editStage)

    expect(turnTwo?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.analysis-step.story-selected')?.textContent)
      .toContain('修改故事线实现')
    await waitFor(() =>
      expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledOnce())
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      behavior: 'smooth',
    })

    const turnOne = [...container.querySelectorAll<HTMLButtonElement>(
      '.decision-turn-toggle',
    )].find(button => button.textContent?.includes('第 1 轮'))
    fireEvent.click(turnOne!)
    fireEvent.click(screen.getByRole('button', {
      name: '在故事线中选择：慢速验证',
    }))
    expect(container.querySelector('.story-node[aria-current="step"]')?.textContent)
      .toContain('运行验证')

    fireEvent.click(screen.getByRole('button', {
      name: '查看轨迹证据：慢速验证',
    }))
    expect(openRecord).toHaveBeenCalledWith('slow')
  })

  it('opens the selected stage details when Enter is pressed again', async () => {
    const value = analysis()
    const { container } = render(
      <TrajectorySummary
        analysis={value}
        source="zcode"
        sourceSessionId="summary-test"
        onOpenRecord={() => {}}
      />,
    )
    const selectedStage = screen.getByRole('button', {
      name: /运行验证，第 1 轮，1 步/,
    })

    expect(selectedStage.getAttribute('aria-current')).toBeNull()
    fireEvent.keyDown(selectedStage, { key: 'Enter' })
    expect(selectedStage.getAttribute('aria-current')).toBe('step')
    expect(container.querySelector('.decision-turn-toggle')
      ?.getAttribute('aria-expanded')).toBe('false')

    fireEvent.keyDown(selectedStage, { key: 'Enter' })

    expect(container.querySelector('.decision-turn-toggle')
      ?.getAttribute('aria-expanded')).toBe('true')
    await waitFor(() =>
      expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledOnce())
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      behavior: 'smooth',
    })
  })

  it('shows turn-local step numbers as status-colored rail nodes', () => {
    const value = analysis()
    value.steps.push({
      id: 'step:next-turn',
      recordId: 'next-turn',
      recordIds: ['next-turn'],
      turn: 2,
      step: 1,
      kind: 'tool',
      action: '下一轮继续验证',
      detail: '下一轮继续验证',
      reason: '确认轮内编号重新开始',
      reasonLevel: 'fact',
      execution: '下一轮继续验证',
      result: '验证通过',
      status: 'complete',
      durationMs: 10,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    })
    const { container } = render(
      <TrajectorySummary
        analysis={value}
        source="zcode"
        sourceSessionId="summary-test"
        onOpenRecord={() => {}}
      />,
    )

    for (const toggle of container.querySelectorAll<HTMLButtonElement>(
      '.decision-turn-toggle',
    )) {
      fireEvent.click(toggle)
    }

    expect([...container.querySelectorAll('.step-number-badge')]
      .map(element => element.textContent)).toEqual(['1', '2', '3', '1'])
    expect(container.querySelector('.step-number-badge')?.getAttribute('aria-label'))
      .toBe('轮内第 1 步')
    expect(container.querySelector('.step-number-badge')?.classList)
      .toContain('status-complete')
    expect(container.querySelector('.step-sequence')).toBeNull()
  })

  it('renders only the adopted story layout and ignores obsolete variant params', () => {
    window.history.replaceState(null, '', '/?variant=C')
    const { container } = render(
      <TrajectorySummary
        analysis={analysis()}
        source="zcode"
        sourceSessionId="summary-test"
        onOpenRecord={() => {}}
      />,
    )

    expect(container.querySelector('.story-selection-triad')).not.toBeNull()
    expect(screen.getByText('模型判断')).toBeTruthy()
    expect(container.querySelector('.story-selection-brief')).toBeNull()
    expect(container.querySelector('.story-selection-flow')).toBeNull()
    expect(container.querySelector('.prototype-switcher')).toBeNull()
    window.history.replaceState(null, '', '/')
  })
})

describe('TrajectorySummary correction list', () => {
  it('renders each correction as one summarized row with an evidence link', () => {
    const value = analysis()
    const longTrigger = '123456789012345678901234567890ABC'
    value.corrections = [{
      id: 'correction-1',
      title: '异常后恢复执行',
      summary: '运行测试失败：断言错误 → 修改测试断言 → 测试通过',
      trigger: longTrigger,
      diagnosis: '模型判断测试仍依赖旧结构',
      change: '修改测试断言',
      result: '测试通过',
      locations: {
        trigger: { turn: 1, step: 1 },
        diagnosis: { turn: 1, step: 2 },
        change: { turn: 1, step: 2 },
        result: { turn: 1, step: 3 },
      },
      status: 'recovered',
      confidence: 'high',
      recordIds: ['slow'],
    }]
    const { container } = render(
      <TrajectorySummary
        analysis={value}
        source="zcode"
        sourceSessionId="summary-test"
        onOpenRecord={() => {}}
      />,
    )

    const row = container.querySelector('.correction-item')
    expect(row?.textContent).toContain('触发')
    expect(row?.textContent).toContain('模型判断')
    expect(row?.textContent).toContain('调整')
    expect(row?.textContent).toContain('结果')
    expect(row?.textContent).toContain('123456789012345678901234567890')
    expect(row?.textContent).not.toContain('ABC')
    expect(row?.textContent).not.toContain('…')
    expect(row?.textContent).toContain('模型判断测试仍依赖旧结构')
    expect(row?.textContent).toContain('修改测试断言')
    expect(row?.textContent).toContain('测试通过')
    expect(row?.textContent).toContain('第1轮·步骤1→第1轮·步骤3')
    expect(screen.getByRole('button', { name: /证据链/ })).toBeTruthy()
    expect(container.querySelector('.correction-flow')).toBeNull()
    expect(container.querySelectorAll('.correction-stage')).toHaveLength(4)
    expect(container.querySelector('.correction-range')?.textContent)
      .toBe('第1轮·步骤1→第1轮·步骤3')
    const truncated = container.querySelector<HTMLElement>(
      '.correction-stage-content[data-tooltip-enabled]',
    )
    expect(truncated?.tabIndex).toBe(0)
    expect(truncated?.getAttribute('aria-label')).toBe(`触发：${longTrigger}`)
    fireEvent.focus(truncated!)
    expect(screen.getByRole('tooltip').textContent).toBe(longTrigger)
    for (const stage of container.querySelectorAll<HTMLElement>('.correction-stage')) {
      expect(stage.style.background).toBe('')
    }
  })
})
