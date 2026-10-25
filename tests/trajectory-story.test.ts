import { describe, expect, it } from 'vitest'
import type {
  AnalysisStep,
  TrajectoryAnalysis,
} from '../src/trajectory-analysis'
import { buildTrajectoryStory } from '../src/trajectory-story'

function step(
  id: string,
  turn: number,
  number: number,
  action: string,
  overrides: Partial<AnalysisStep> = {},
): AnalysisStep {
  return {
    id,
    recordId: `record:${id}`,
    recordIds: [`record:${id}`],
    turn,
    step: number,
    kind: 'tool',
    action,
    detail: action,
    reason: `执行 ${action} 的依据`,
    reasonLevel: 'fact',
    execution: action,
    result: `${action}完成`,
    status: 'complete',
    durationMs: 100,
    usage: { inputTokens: 8, outputTokens: 2 },
    ...overrides,
  }
}

function analysis(steps: AnalysisStep[]): TrajectoryAnalysis {
  return {
    objective: '实现故事线',
    objectiveLabel: '会话目标',
    outcome: {
      label: '完成',
      summary: 'fixture',
      tone: 'positive',
      confidence: 'high',
      evidenceRecordIds: [],
    },
    stats: {
      durationMs: 1_000,
      turns: 2,
      steps: steps.length,
      errors: 1,
      retries: 0,
      recovered: 1,
    },
    steps,
    costSteps: steps,
    corrections: [{
      id: 'recovery:test',
      title: '异常后恢复执行',
      summary: '测试失败后修正',
      trigger: '运行测试失败',
      diagnosis: '需要修正实现',
      change: '修改实现',
      result: '测试通过',
      locations: {
        trigger: { turn: 1, step: 4 },
        diagnosis: { turn: 1, step: 5 },
        change: { turn: 1, step: 5 },
        result: { turn: 1, step: 6 },
      },
      status: 'recovered',
      confidence: 'high',
      recordIds: ['record:failed', 'record:fix', 'record:passed'],
    }],
    evaluations: [],
  }
}

describe('buildTrajectoryStory', () => {
  it('groups consecutive behavior while preserving step order and evidence mappings', () => {
    const steps = [
      step('read', 1, 1, '读取相关文件内容'),
      step('search', 1, 2, '搜索相关代码和文件'),
      step('edit', 1, 3, '修改 TrajectorySummary.tsx'),
      step('failed', 1, 4, '运行测试或构建验证', {
        status: 'error',
        result: '测试失败',
      }),
      step('fix', 1, 5, '修改 TrajectorySummary.test.tsx'),
      step('passed', 1, 6, '运行测试或构建验证', {
        result: '测试通过',
      }),
      step('report', 2, 1, '汇报执行结果'),
    ]

    const story = buildTrajectoryStory(analysis(steps))

    expect(story.stages.flatMap(stage => stage.stepIds))
      .toEqual(steps.map(item => item.id))
    expect(Object.keys(story.stageIdByStepId)).toHaveLength(steps.length)
    expect(story.stages[0]).toMatchObject({
      phase: 'inspect',
      title: '检查现状与证据',
      stepIds: ['read', 'search'],
      stepCount: 2,
      judgment: '执行 读取相关文件内容 的依据',
      actions: ['读取相关文件内容', '搜索相关代码和文件'],
      outcome: '搜索相关代码和文件完成',
      durationMs: 200,
      usage: {
        inputTokens: 16,
        outputTokens: 4,
        totalTokens: 20,
      },
    })
    const failed = story.stages.find(stage => stage.stepIds.includes('failed'))
    expect(failed).toMatchObject({
      phase: 'recover',
      errorCount: 1,
      recoveredCount: 1,
    })
    expect(failed?.stepIds).toContain('fix')
    expect(story).not.toHaveProperty('stepNumberById')
  })

  it('uses recovery diagnosis and verified results instead of malformed trailing prose', () => {
    const value = analysis([
      step('failed', 1, 1, '运行测试或构建验证', {
        status: 'error',
        reason: '来源未记录独立思考；根据实际动作推断本步骤目的是“运行测试”',
        result: '测试失败：schema 不兼容',
      }),
      step('fix', 1, 2, '修改 codex-app-server.ts', {
        reason: '来源未记录独立思考；根据实际动作推断本步骤目的是“修改实现”',
        result: '修改 codex-app-server.ts成功；模型结论：确认失败原因是。 2. 当前模型不支持',
      }),
      step('passed', 1, 3, '运行测试或构建验证', {
        result: '测试通过：23 个测试文件、186 项测试全部通过',
      }),
    ])
    value.corrections = [{
      ...value.corrections[0]!,
      diagnosis: 'JSON Schema 重试通知不能当作最终失败',
      recordIds: ['record:failed', 'record:fix', 'record:passed'],
    }]

    const stage = buildTrajectoryStory(value, 1).stages[0]!

    expect(stage.judgment).toBe('JSON Schema 重试通知不能当作最终失败')
    expect(stage.actions).toEqual([
      '运行测试或构建验证',
      '修改 codex-app-server.ts',
    ])
    expect(stage.outcome).toBe('测试通过：23 个测试文件、186 项测试全部通过')
    expect(stage.outcome).not.toContain('确认失败原因是。')
  })

  it('compacts long traces to the requested stage count without losing steps', () => {
    const steps = Array.from({ length: 18 }, (_, index) =>
      step(
        `step-${index + 1}`,
        Math.floor(index / 3) + 1,
        index % 3 + 1,
        index % 3 === 0
          ? '读取相关文件内容'
          : index % 3 === 1
            ? '修改代码实现'
            : '运行测试或构建验证',
      ))

    const story = buildTrajectoryStory(analysis(steps), 4)

    expect(story.stages).toHaveLength(4)
    expect(story.stages.flatMap(stage => stage.stepIds))
      .toEqual(steps.map(item => item.id))
    for (const item of steps) {
      expect(story.stageIdByStepId[item.id]).toBeTruthy()
    }
  })
})
