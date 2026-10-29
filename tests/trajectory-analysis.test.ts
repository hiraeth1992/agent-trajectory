import { describe, expect, it } from 'vitest'
import { capabilities, sessionKey } from '../server/sources/types'
import { analyzeTrajectory } from '../src/trajectory-analysis'
import { buildTimelineGeometry } from '../src/trajectory-view-model'
import type {
  SessionDetail,
  SessionSummary,
  TrajectoryRecord,
} from '../src/types'

function summary(): SessionSummary {
  return {
    id: sessionKey('zcode', 'analysis-session'),
    source: 'zcode',
    sourceSessionId: 'analysis-session',
    format: 'test',
    capabilities: capabilities('messages', 'tools', 'timing', 'usage'),
    cwd: '/workspace',
    title: 'Analysis session',
    createdAt: 1_000,
    updatedAt: 7_000,
    size: 1,
  }
}

function record(
  id: string,
  overrides: Partial<TrajectoryRecord>,
): TrajectoryRecord {
  return {
    id,
    source: 'zcode',
    sourceEventIds: [id],
    fidelity: 'exact',
    seq: 1,
    turn: 1,
    step: 1,
    kind: 'tool',
    title: id,
    summary: id,
    startTime: 1_000,
    endTime: 2_000,
    status: 'complete',
    depth: 0,
    searchText: id,
    ...overrides,
  }
}

function detail(records: TrajectoryRecord[]): SessionDetail {
  const value = summary()
  return {
    summary: value,
    projection: {
      header: {
        source: value.source,
        format: value.format,
        id: value.sourceSessionId,
        createdAt: value.createdAt,
      },
      records,
      turns: [{
        id: 'turn-1',
        number: 1,
        startTime: 1_000,
        endTime: 7_000,
        status: 'complete',
      }],
      lanes: [],
      startTime: 1_000,
      endTime: 7_000,
      eventCount: records.length,
      eventTypeCounts: {},
      unknownEventTypes: [],
      turnEnds: { 1: { time: 7_000, reason: 'complete' } },
    },
  }
}

describe('analyzeTrajectory', () => {
  it('builds an evidence-backed recovery story and keeps cache token facts', () => {
    const reasoning = record('reasoning', {
      seq: 1,
      step: 1,
      kind: 'assistant',
      title: '推理',
      summary: 'Run tests before shipping',
      output: [{ type: 'reasoning', text: 'Run tests before shipping' }],
    })
    const failedTest = record('failed-test', {
      seq: 2,
      step: 1,
      title: 'exec_command',
      summary: 'npm test failed',
      input: { cmd: 'npm test' },
      startTime: 2_000,
      endTime: 3_000,
      status: 'error',
      error: { code: '1', reason: 'one assertion failed' },
    })
    const fixReasoning = record('fix-reasoning', {
      seq: 3,
      step: 2,
      kind: 'assistant',
      title: '推理',
      summary: '测试失败是断言仍依赖旧页面结构，需要更新断言',
      output: [{
        type: 'reasoning',
        text: '测试失败是断言仍依赖旧页面结构，需要更新断言',
      }],
      startTime: 3_050,
      endTime: 3_090,
    })
    const fix = record('fix', {
      seq: 4,
      step: 2,
      title: 'apply_patch',
      summary: '更新测试断言',
      input: '*** Update File: tests/App.test.tsx',
      startTime: 3_100,
      endTime: 4_000,
    })
    const passedTest = record('passed-test', {
      seq: 5,
      step: 3,
      title: 'exec_command',
      summary: 'npm test passed',
      input: { cmd: 'npm test' },
      output: 'Test Files 2 passed\nTests 25 passed',
      startTime: 4_100,
      endTime: 6_000,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        cacheReadTokens: 60,
        cacheWriteTokens: 4,
        totalTokens: 125,
      },
    })
    const value = detail([reasoning, failedTest, fixReasoning, fix, passedTest])
    value.projection.usage = {
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheReadTokens: 60,
      cacheWriteTokens: 4,
      totalTokens: 125,
    }

    const analysis = analyzeTrajectory(value)

    expect(analysis.objective).toBe('Analysis session')
    expect(analysis.objectiveLabel).toBe('会话目标')
    expect(analysis.outcome).toMatchObject({
      label: '已完成并有验证证据',
      tone: 'positive',
      confidence: 'high',
      evidenceRecordIds: ['passed-test'],
    })
    expect(analysis.stats).toMatchObject({
      durationMs: 4_840,
      errors: 1,
      recovered: 1,
      cacheReadTokens: 60,
      cacheWriteTokens: 4,
    })
    expect(analysis.corrections[0]).toMatchObject({
      summary: '运行测试或构建验证失败：one assertion failed → 修改 App.test.tsx → 修改 App.test.tsx成功；验证：测试通过：2 个测试文件、25 项测试全部通过',
      trigger: '运行测试或构建验证失败：one assertion failed',
      diagnosis: '模型判断：测试失败是断言仍依赖旧页面结构，需要更新断言',
      change: '修改 App.test.tsx',
      result: '修改 App.test.tsx成功；后续验证：测试通过：2 个测试文件、25 项测试全部通过',
      locations: {
        trigger: { turn: 1, step: 1 },
        diagnosis: { turn: 1, step: 2 },
        change: { turn: 1, step: 2 },
        result: { turn: 1, step: 3 },
      },
      status: 'recovered',
      confidence: 'medium',
      recordIds: [
        'reasoning',
        'failed-test',
        'fix-reasoning',
        'fix',
        'passed-test',
      ],
    })
    expect(analysis.steps).toHaveLength(3)
    expect(analysis.steps[0]).toMatchObject({
      action: '运行测试或构建验证',
      execution: '运行测试：npm test',
      result: '运行测试失败：one assertion failed',
      reason: '模型决定先执行验证，根据结果判断是否需要继续修改',
      reasonLevel: 'fact',
    })
    expect(analysis.steps[1]).toMatchObject({
      action: '修改 App.test.tsx',
      execution: '修改 App.test.tsx',
      result: '修改 App.test.tsx成功',
      reason: '测试失败是断言仍依赖旧页面结构，需要更新断言',
    })
    expect(analysis.steps[2]).toMatchObject({
      action: '运行测试或构建验证',
      result: '测试通过：2 个测试文件、25 项测试全部通过',
    })
    expect(analysis.steps.some(step => step.result === '形成了后续行动依据')).toBe(false)
    expect(analysis.evaluations.map(evaluation => evaluation.id)).toEqual([
      'outcome',
      'reliability',
      'recovery',
      'efficiency',
      'observability',
    ])
  })

  it('summarizes the latest effective multi-turn objective instead of the session title', () => {
    const first = record('user:first', {
      seq: 1,
      turn: 1,
      step: 0,
      kind: 'user',
      summary: '增加轨迹总结和评测模块',
      input: [{ type: 'text', text: '增加轨迹总结和评测模块' }],
    })
    const confirmation = record('user:confirmation', {
      seq: 2,
      turn: 2,
      step: 0,
      kind: 'user',
      summary: '确认，按这个开发吧',
      input: [{ type: 'text', text: '确认，按这个开发吧' }],
    })
    const latest = record('user:latest', {
      seq: 3,
      turn: 3,
      step: 0,
      kind: 'user',
      summary: '修正：统一改为轨迹评测，增加成本排序器',
      input: [{ type: 'text', text: '修正：统一改为轨迹评测，增加成本排序器' }],
    })

    const analysis = analyzeTrajectory(detail([first, confirmation, latest]))

    expect(analysis.objective).toBe(
      '围绕“增加轨迹总结和评测模块”，最终目标为“统一改为轨迹评测，增加成本排序器”',
    )
    expect(analysis.objectiveLabel).toBe('会话目标')
  })

  it('synthesizes a completed objective from the whole context instead of the final execution cue', () => {
    const messages = [
      record('user:review', {
        seq: 1,
        turn: 1,
        step: 0,
        kind: 'user',
        summary: '项目整体审查',
        input: [{
          type: 'text',
          text: '项目整体审查：架构合理性、模块分工与联动、实现效率、会话和数据完整性、风险缺陷及优化点',
        }],
      }),
      record('user:confirm', {
        seq: 2,
        turn: 2,
        step: 0,
        kind: 'user',
        summary: '确认',
        input: [{ type: 'text', text: '确认' }],
      }),
      record('user:continue', {
        seq: 3,
        turn: 3,
        step: 0,
        kind: 'user',
        summary: '继续',
        input: [{ type: 'text', text: '继续' }],
      }),
      record('user:execute', {
        seq: 4,
        turn: 4,
        step: 0,
        kind: 'user',
        summary: '按结论优化',
        input: [{ type: 'text', text: '按结论优化' }],
      }),
    ]

    const analysis = analyzeTrajectory(detail(messages))

    expect(analysis.objective).toBe(
      '在“项目整体审查：架构合理性、模块分工与联动、实现效率、会话和数据完整性、风险缺陷及优化点”基础上，根据结论完成优化',
    )
    expect(analysis.objective).not.toBe('按结论优化')
    expect(analysis.objectiveLabel).toBe('会话目标')
  })

  it('keeps new constraints attached to a contextual execution instruction', () => {
    const initial = record('user:initial-audit', {
      seq: 1,
      turn: 1,
      step: 0,
      kind: 'user',
      summary: '重构审计导出',
      input: [{ type: 'text', text: '重构审计导出' }],
    })
    const executeWithConstraint = record('user:execute-audit', {
      seq: 2,
      turn: 2,
      step: 0,
      kind: 'user',
      summary: '确认并按方案执行，同时保留现有 API 并补充 raw-only 事件',
      input: [{
        type: 'text',
        text: '确认并按方案执行，同时保留现有 API 并补充 raw-only 事件',
      }],
    })

    const analysis = analyzeTrajectory(detail([initial, executeWithConstraint]))

    expect(analysis.objective).toBe(
      '在“重构审计导出”基础上，按已确认方案实施，并保留现有 API 并补充 raw-only 事件',
    )
  })

  it.each([
    ['照上述方案实施', '在“提升会话与数据完整性”基础上，按已确认方案实施'],
    ['根据前面的建议继续推进', '在“提升会话与数据完整性”基础上，根据建议继续推进'],
    ['这些都没问题，开始吧', '在“提升会话与数据完整性”基础上，基于前述要求继续推进'],
    ['照此处理', '在“提升会话与数据完整性”基础上，基于前述要求继续推进'],
  ])('resolves contextual wording without replacing the established objective: %s', (
    cue,
    expected,
  ) => {
    const initial = record('user:established-objective', {
      seq: 1,
      turn: 1,
      step: 0,
      kind: 'user',
      summary: '提升会话与数据完整性',
      input: [{ type: 'text', text: '提升会话与数据完整性' }],
    })
    const contextual = record('user:contextual-cue', {
      seq: 2,
      turn: 2,
      step: 0,
      kind: 'user',
      summary: cue,
      input: [{ type: 'text', text: cue }],
    })

    const analysis = analyzeTrajectory(detail([initial, contextual]))

    expect(analysis.objective).toBe(expected)
  })

  it('extracts a factual addition from a continuation cue', () => {
    const initial = record('user:initial-observability', {
      seq: 1,
      turn: 1,
      step: 0,
      kind: 'user',
      summary: '完善轨迹可观测性',
      input: [{ type: 'text', text: '完善轨迹可观测性' }],
    })
    const continuation = record('user:continue-with-constraint', {
      seq: 2,
      turn: 2,
      step: 0,
      kind: 'user',
      summary: '继续，并增加审计导出的完整性校验',
      input: [{ type: 'text', text: '继续，并增加审计导出的完整性校验' }],
    })

    const analysis = analyzeTrajectory(detail([initial, continuation]))

    expect(analysis.objective).toBe(
      '围绕“完善轨迹可观测性”，最终目标为“增加审计导出的完整性校验”',
    )
  })

  it('shows only the latest objective while the session is running', () => {
    const first = record('user:initial-running', {
      kind: 'user',
      step: 0,
      summary: '先完成基础轨迹评测',
      input: [{ type: 'text', text: '先完成基础轨迹评测' }],
    })
    const latest = record('user:latest-running', {
      seq: 2,
      turn: 2,
      kind: 'user',
      step: 0,
      summary: '调整：当前先优化模型选择器',
      input: [{ type: 'text', text: '调整：当前先优化模型选择器' }],
      status: 'running',
      endTime: null,
    })
    const value = detail([first, latest])
    value.projection.turns[0] = {
      ...value.projection.turns[0]!,
      status: 'running',
      endTime: null,
    }

    const analysis = analyzeTrajectory(value)

    expect(analysis.objectiveLabel).toBe('当前执行目标')
    expect(analysis.objective).toBe('调整：当前先优化模型选择器')
  })

  it('compacts an approved correction into the final objective', () => {
    const initial = record('user:initial', {
      kind: 'user',
      step: 0,
      summary: '完善轨迹评测页面的一组交互',
      input: [{ type: 'text', text: '完善轨迹评测页面的一组交互' }],
    })
    const correction = record('user:correction', {
      seq: 2,
      turn: 2,
      kind: 'user',
      step: 0,
      summary: 'correction',
      input: [{
        type: 'text',
        text: [
          '修正：',
          '1. “总结与评测”统一改为“轨迹评测”',
          '2. 每一步成本，增加排序器（轮次·步骤正序、消耗倒序），默认排序规则不改',
          '其他没问题，执行吧',
        ].join('\n'),
      }],
    })

    expect(analyzeTrajectory(detail([initial, correction])).objective).toBe(
      '围绕“完善轨迹评测页面的一组交互”，最终目标为““总结与评测”统一改为“轨迹评测”；每一步成本，增加排序器（轮次·步骤正序、消耗倒序），默认排序规则不改；其余按已确认方案实施”',
    )
  })

  it('uses the latest active execution subgoal instead of the broader user goal', () => {
    const user = record('user:goals', {
      kind: 'user',
      step: 0,
      summary: '完成目标 a、b、c',
      input: [{ type: 'text', text: '完成目标 a、b、c' }],
    })
    const progressA = record('assistant:progress-a', {
      seq: 2,
      turn: 2,
      step: 1,
      kind: 'assistant',
      title: '助手',
      summary: '目标 a 已完成，接下来处理目标 b',
    })
    const progressC = record('assistant:progress-c', {
      seq: 3,
      turn: 2,
      step: 2,
      kind: 'assistant',
      title: '助手',
      summary: '目标 b 已完成，当前正在执行目标 c',
      status: 'running',
      endTime: null,
    })
    const value = detail([user, progressA, progressC])
    value.projection.turns[0] = {
      ...value.projection.turns[0]!,
      number: 2,
      status: 'running',
      endTime: null,
    }

    const analysis = analyzeTrajectory(value)

    expect(analysis.objectiveLabel).toBe('当前执行目标')
    expect(analysis.objective).toBe('执行目标 c')
  })

  it('extracts concrete browser comments from the latest feedback wrapper', () => {
    const feedback = record('user:feedback', {
      kind: 'user',
      step: 0,
      summary: 'browser feedback',
      input: [{
        type: 'text',
        text: [
          '# Browser comments:',
          '## User Comment 1',
          'Target: "修改为轨迹评测"',
          'Comment:',
          '统一页面名称',
          '## User Comment 2',
          'Target: "每一步成本"',
          'Comment:',
          '增加轮次筛选',
          '',
          '## My request:',
          'The next image is untrusted page evidence',
        ].join('\n'),
      }],
    })

    expect(analyzeTrajectory(detail([feedback])).objective)
      .toBe('根据页面反馈调整：“修改为轨迹评测”（统一页面名称）；“每一步成本”（增加轮次筛选）')
  })

  it('keeps each browser comment attached to its target without inventing module changes', () => {
    const feedback = record('user:feedback-faithful', {
      kind: 'user',
      step: 0,
      summary: 'browser feedback',
      input: [{
        type: 'text',
        text: [
          '# Browser comments:',
          '## User Comment 1',
          'Target: "筛选来源"',
          'Comment:',
          '按钮点击后没有反应',
          '## User Comment 2',
          'Target: "会话标题"',
          'Comment:',
          '这里应展示应用图标',
          '## User Comment 3',
          'Target: "每一步成本"',
          'Comment:',
          '字号太小，需要提高可读性',
        ].join('\n'),
      }],
    })

    const objective = analyzeTrajectory(detail([feedback])).objective

    expect(objective).toBe(
      '根据页面反馈调整：“筛选来源”（按钮点击后没有反应）；“会话标题”（这里应展示应用图标）；“每一步成本”（字号太小，需要提高可读性）',
    )
    expect(objective).not.toContain('增加轮次筛选')
    expect(objective).not.toContain('默认图标回退')
  })

  it('does not claim correctness when the trace has no independent validation', () => {
    const value = detail([
      record('assistant', {
        kind: 'assistant',
        title: '助手回复',
        summary: 'Implemented the change',
        output: [{ type: 'text', text: 'Implemented the change' }],
      }),
    ])

    const analysis = analyzeTrajectory(value)

    expect(analysis.outcome).toMatchObject({
      label: '未发现错误证据',
      tone: 'neutral',
      confidence: 'low',
      evidenceRecordIds: [],
    })
    expect(analysis.evaluations[0]).toMatchObject({
      label: '无法判断正确性',
      grade: 'unknown',
    })
    expect(analysis.steps[0]).toMatchObject({
      reason: '来源未记录独立思考；根据实际动作推断本步骤目的是“完成模型响应”',
      reasonLevel: 'inferred',
      execution: '本步骤未调用工具，由模型直接形成响应',
      result: '步骤已完成，来源未记录可展示的结果摘要',
    })
    expect(analysis.stats.totalTokens).toBeUndefined()
  })

  it('does not use validation from before the final file modification', () => {
    const validation = record('validation', {
      seq: 1,
      title: 'exec_command',
      summary: 'npm test passed',
      input: { cmd: 'npm test' },
      output: 'Tests 10 passed',
      status: 'complete',
    })
    const edit = record('edit', {
      seq: 2,
      step: 2,
      title: 'apply_patch',
      summary: 'modify implementation after tests',
      input: '*** Update File: src/app.ts\n-old\n+new',
      status: 'complete',
    })

    const analysis = analyzeTrajectory(detail([validation, edit]))

    expect(analysis.outcome).toMatchObject({
      label: '最终修改尚未验证',
      tone: 'warning',
      confidence: 'high',
      evidenceRecordIds: ['validation', 'edit'],
    })
    expect(analysis.evaluations[0]).toMatchObject({
      label: '最终修改缺少验证',
      grade: 'warning',
    })
  })

  it('does not treat quoted command text or mixed test failures as successful validation', () => {
    const quoted = analyzeTrajectory(detail([
      record('quoted-validation', {
        title: 'exec_command',
        input: { cmd: 'echo "npm test"' },
        output: 'Tests 2 passed',
        status: 'complete',
      }),
    ]))
    expect(quoted.outcome.label).toBe('未发现错误证据')

    const mixed = analyzeTrajectory(detail([
      record('mixed-validation', {
        title: 'exec_command',
        input: { cmd: 'npm test' },
        output: 'Tests 3 passed | Tests 2 failed',
        status: 'complete',
      }),
    ]))
    expect(mixed.outcome).toMatchObject({
      label: '结果存在未解决问题',
      tone: 'negative',
    })
    expect(mixed.steps[0]?.result).toContain('失败')
  })

  it('recognizes supported validation commands independent of the source tool label', () => {
    const analysis = analyzeTrajectory(detail([
      record('pnpm-validation', {
        title: 'Bash',
        input: { command: 'pnpm test' },
        output: 'Tests 4 passed',
        status: 'complete',
      }),
    ]))

    expect(analysis.outcome).toMatchObject({
      label: '已完成并有验证证据',
      tone: 'positive',
    })
  })

  it('lets a final successful validation determine outcome despite older diagnostic failures', () => {
    const analysis = analyzeTrajectory(detail([
      record('diagnostic-first', {
        seq: 1,
        step: 1,
        title: 'exec_command',
        input: { cmd: 'node diagnose-first.js' },
        status: 'error',
        error: { code: '1', reason: 'diagnostic invocation failed' },
      }),
      record('diagnostic-second', {
        seq: 2,
        step: 2,
        title: 'exec_command',
        input: { cmd: 'node diagnose-second.js' },
        status: 'error',
        error: { code: '1', reason: 'diagnostic invocation failed again' },
      }),
      record('final-validation', {
        seq: 3,
        step: 3,
        title: 'exec_command',
        input: { cmd: 'npm test' },
        output: 'Test Files 2 passed\nTests 12 passed',
        status: 'complete',
      }),
    ]))

    expect(analysis.corrections).toContainEqual(expect.objectContaining({
      id: 'recovery:step:1:1',
      status: 'unresolved',
    }))
    expect(analysis.outcome).toMatchObject({
      label: '已完成并有验证证据',
      tone: 'positive',
      confidence: 'high',
      evidenceRecordIds: ['final-validation'],
    })
    expect(analysis.evaluations[0]).toMatchObject({
      label: '存在成功验证',
      grade: 'good',
    })
    expect(analysis.evaluations.find(item => item.id === 'recovery')).toMatchObject({
      label: '恢复不完整',
      grade: 'bad',
    })
  })

  it('marks failed browser checks recovered after a later browser check passes', () => {
    const browserCheck = (body: string) =>
      `node - <<'NODE'\nconst { chromium } = require('playwright')\n${body}\nNODE`
    const analysis = analyzeTrajectory(detail([
      record('browser-check-first', {
        seq: 1,
        step: 1,
        title: 'exec_command',
        input: { cmd: browserCheck('if (errors.length) process.exit(1)') },
        status: 'error',
        error: { code: '1', reason: 'browser verification failed' },
      }),
      record('browser-check-second', {
        seq: 2,
        step: 2,
        title: 'exec_command',
        input: { cmd: browserCheck('if (!nodes) process.exit(1)') },
        status: 'error',
        error: { code: '1', reason: 'browser verification failed again' },
      }),
      record('browser-fix', {
        seq: 3,
        step: 3,
        title: 'apply_patch',
        input: '*** Update File: build-map.js',
        status: 'complete',
      }),
      record('browser-check-passed', {
        seq: 4,
        step: 4,
        title: 'exec_command',
        input: { cmd: browserCheck('if (errors.length) process.exit(1)') },
        output: '{"nodes":27,"errors":[]}',
        status: 'complete',
      }),
    ]))

    expect(analysis.corrections.filter(correction =>
      correction.id === 'recovery:step:1:1'
      || correction.id === 'recovery:step:1:2'))
      .toEqual([
        expect.objectContaining({ status: 'recovered' }),
        expect.objectContaining({ status: 'recovered' }),
      ])
    expect(analysis.outcome).toMatchObject({
      label: '已完成并有验证证据',
      tone: 'positive',
      evidenceRecordIds: ['browser-check-passed'],
    })
  })

  it('does not let exit 130 from an interrupted turn block a later completed answer', () => {
    const value = detail([
      record('aborted-search', {
        seq: 1,
        turn: 1,
        step: 1,
        title: 'exec_command',
        input: { cmd: 'rg localeOverride config.toml' },
        status: 'error',
        error: { code: '130', reason: 'command interrupted' },
      }),
      record('aborted-stdin', {
        seq: 2,
        turn: 1,
        step: 2,
        title: 'write_stdin',
        input: { session_id: 25_525, chars: '\u0003' },
        status: 'error',
        error: { code: '130', reason: 'process interrupted' },
      }),
      record('follow-up', {
        seq: 3,
        turn: 2,
        step: 0,
        kind: 'user',
        title: '用户',
        summary: '我说的是界面语言',
        input: [{ type: 'text', text: '我说的是界面语言' }],
      }),
      record('final-answer', {
        seq: 4,
        turn: 2,
        step: 2,
        kind: 'assistant',
        title: '助手',
        summary: '中文设置已保存，完整重启后生效。',
        output: [{ type: 'text', text: '中文设置已保存，完整重启后生效。' }],
      }),
    ])
    value.projection.turns = [
      {
        id: 'turn-1',
        number: 1,
        startTime: 1_000,
        endTime: 3_000,
        status: 'interrupted',
        reason: 'interrupted',
      },
      {
        id: 'turn-2',
        number: 2,
        startTime: 4_000,
        endTime: 7_000,
        status: 'complete',
        reason: 'completed',
      },
    ]
    value.projection.turnEnds = {
      1: { time: 3_000, reason: 'interrupted' },
      2: { time: 7_000, reason: 'completed' },
    }

    const analysis = analyzeTrajectory(value)

    expect(analysis.corrections).toContainEqual(expect.objectContaining({
      id: 'recovery:step:1:1',
      status: 'unresolved',
    }))
    expect(analysis.outcome).toMatchObject({
      label: '已完成，但缺少独立验证',
      tone: 'warning',
      confidence: 'medium',
      evidenceRecordIds: expect.arrayContaining(['aborted-search', 'final-answer']),
    })
    expect(analysis.evaluations[0]).toMatchObject({
      label: '缺少独立验证',
      grade: 'warning',
      confidence: 'medium',
    })
  })

  it('keeps interrupted exit 130 unresolved without a later completed turn', () => {
    const value = detail([
      record('aborted-only', {
        title: 'exec_command',
        input: { cmd: 'rg localeOverride config.toml' },
        status: 'error',
        error: { code: '130', reason: 'command interrupted' },
      }),
    ])
    value.projection.turns[0] = {
      ...value.projection.turns[0]!,
      status: 'interrupted',
      reason: 'interrupted',
    }
    value.projection.turnEnds = {
      1: { time: 7_000, reason: 'interrupted' },
    }

    const analysis = analyzeTrajectory(value)

    expect(analysis.outcome).toMatchObject({
      label: '结果存在未解决问题',
      tone: 'negative',
      confidence: 'high',
      evidenceRecordIds: ['aborted-only'],
    })
    expect(analysis.evaluations[0]).toMatchObject({
      label: '验证未通过',
      grade: 'bad',
    })
  })

  it('keeps an explicitly blocked follow-up negative after an interrupted turn', () => {
    const value = detail([
      record('aborted-before-block', {
        seq: 1,
        turn: 1,
        step: 1,
        title: 'exec_command',
        input: { cmd: 'rg localeOverride config.toml' },
        status: 'error',
        error: { code: '130', reason: 'command interrupted' },
      }),
      record('blocked-follow-up', {
        seq: 2,
        turn: 2,
        step: 0,
        kind: 'user',
        title: '用户',
        summary: '继续处理',
      }),
      record('blocked-answer', {
        seq: 3,
        turn: 2,
        step: 1,
        kind: 'assistant',
        title: '助手',
        summary: '缺少权限，无法完成。',
        output: [{ type: 'text', text: '缺少权限，无法完成。' }],
      }),
    ])
    value.projection.turns = [
      {
        id: 'turn-1',
        number: 1,
        startTime: 1_000,
        endTime: 3_000,
        status: 'interrupted',
        reason: 'interrupted',
      },
      {
        id: 'turn-2',
        number: 2,
        startTime: 4_000,
        endTime: 7_000,
        status: 'complete',
        reason: 'completed',
      },
    ]
    value.projection.taskState = {
      target: {
        id: 'blocked-target',
        objective: '处理语言设置',
        status: 'blocked',
        updatedAt: 7_000,
      },
      todos: [],
    }

    const analysis = analyzeTrajectory(value)

    expect(analysis.outcome).toMatchObject({
      label: '结果存在未解决问题',
      summary: '任务状态明确标记为 blocked。',
      tone: 'negative',
      confidence: 'high',
    })
    expect(analysis.evaluations[0]).toMatchObject({
      label: '任务受阻',
      grade: 'bad',
    })
  })

  it('does not ignore exit 130 from a turn that was not interrupted', () => {
    const analysis = analyzeTrajectory(detail([
      record('failed-normal-turn', {
        title: 'exec_command',
        input: { cmd: 'rg localeOverride config.toml' },
        status: 'error',
        error: { code: '130', reason: 'command interrupted' },
      }),
    ]))

    expect(analysis.outcome).toMatchObject({
      label: '结果存在未解决问题',
      tone: 'negative',
      confidence: 'high',
      evidenceRecordIds: ['failed-normal-turn'],
    })
    expect(analysis.evaluations[0]).toMatchObject({
      label: '验证未通过',
      grade: 'bad',
    })
  })

  it('reports partial repair when successful validation is followed by an unresolved failure', () => {
    const analysis = analyzeTrajectory(detail([
      record('validated-part', {
        seq: 1,
        step: 1,
        title: 'exec_command',
        input: { cmd: 'npm test' },
        output: 'Test Files 1 passed\nTests 4 passed',
        status: 'complete',
      }),
      record('later-failure', {
        seq: 2,
        step: 2,
        title: 'exec_command',
        input: { cmd: 'node verify-browser.js' },
        status: 'error',
        error: { code: '1', reason: 'browser verification failed' },
      }),
    ]))

    expect(analysis.outcome).toMatchObject({
      label: '部分修复，仍有未完成项',
      tone: 'warning',
      confidence: 'medium',
      evidenceRecordIds: expect.arrayContaining(['validated-part', 'later-failure']),
    })
    expect(analysis.evaluations[0]).toMatchObject({
      label: '部分通过',
      grade: 'warning',
    })
  })

  it('reports partial repair when task state retains explicit incomplete items', () => {
    const value = detail([
      record('validated-scope', {
        title: 'exec_command',
        input: { cmd: 'npm test' },
        output: 'Test Files 1 passed\nTests 6 passed',
        status: 'complete',
      }),
    ])
    value.projection.taskState = {
      target: {
        id: 'target-partial',
        objective: '完成两个修复项',
        status: 'complete',
        updatedAt: 2_000,
      },
      todos: [
        { content: '修复标题', status: 'completed', position: 0 },
        { content: '修复筛选', status: 'in_progress', position: 1 },
      ],
    }

    const analysis = analyzeTrajectory(value)

    expect(analysis.outcome).toMatchObject({
      label: '部分修复，仍有未完成项',
      tone: 'warning',
      confidence: 'high',
      evidenceRecordIds: ['validated-scope'],
    })
    expect(analysis.outcome.summary).toContain('1 个未完成项')
    expect(analysis.evaluations[0]).toMatchObject({
      label: '部分通过',
      grade: 'warning',
    })
  })

  it('treats an active or paused target in a finished session as explicit incomplete state', () => {
    for (const status of ['active', 'paused']) {
      const value = detail([
        record(`validation-${status}`, {
          title: 'exec_command',
          input: { cmd: 'npm test' },
          output: 'Tests 3 passed',
          status: 'complete',
        }),
      ])
      value.projection.taskState = {
        target: {
          id: `target-${status}`,
          objective: '完成全部修复',
          status,
          updatedAt: 2_000,
        },
        todos: [],
      }

      expect(analyzeTrajectory(value).outcome).toMatchObject({
        label: '部分修复，仍有未完成项',
        tone: 'warning',
        confidence: 'high',
      })
    }
  })

  it('preserves an explicit partial target even when the latest scoped validation failed', () => {
    const value = detail([
      record('partial-validation', {
        title: 'exec_command',
        input: { cmd: 'npm test' },
        output: 'Tests 2 passed | Tests 1 failed',
        status: 'error',
        error: { code: '1', reason: 'one remaining failure' },
      }),
    ])
    value.projection.taskState = {
      target: {
        id: 'target-explicit-partial',
        objective: '完成全部修复',
        status: 'partial',
        updatedAt: 2_000,
      },
      todos: [],
    }

    const analysis = analyzeTrajectory(value)

    expect(analysis.outcome).toMatchObject({
      label: '部分修复，仍有未完成项',
      tone: 'warning',
      confidence: 'high',
      evidenceRecordIds: ['partial-validation'],
    })
    expect(analysis.outcome.summary).toContain('明确标记为部分完成')
    expect(analysis.evaluations[0]).toMatchObject({
      label: '部分通过',
      grade: 'warning',
    })
  })

  it('distinguishes explicit retry recovery from unresolved failures', () => {
    const retried = record('retried', {
      step: 1,
      title: '模型步骤',
      kind: 'assistant',
      status: 'complete',
      retry: { count: 2, message: 'rate limited' },
    })
    const unresolved = record('unresolved', {
      seq: 2,
      step: 2,
      title: 'pytest',
      summary: 'pytest failed',
      input: { cmd: 'pytest' },
      startTime: 2_100,
      endTime: 2_500,
      status: 'error',
      error: { reason: 'still failing' },
    })

    const analysis = analyzeTrajectory(detail([retried, unresolved]))

    expect(analysis.corrections).toEqual([
      expect.objectContaining({
        id: 'recovery:step:1:1',
        status: 'recovered',
        confidence: 'high',
      }),
      expect.objectContaining({
        id: 'recovery:step:1:2',
        status: 'unresolved',
        confidence: 'high',
      }),
    ])
    expect(analysis.outcome).toMatchObject({
      label: '结果存在未解决问题',
      tone: 'negative',
    })
    expect(analysis.evaluations.find(item => item.id === 'recovery')).toMatchObject({
      label: '恢复不完整',
      summary: '1 个异常后出现成功动作；1 个异常没有后续成功证据。相邻步骤关联属于轨迹推断。',
    })
  })

  it('keeps analysis bounded for a large trajectory', () => {
    const records = Array.from({ length: 40_000 }, (_, index) =>
      record(`tool-${index}`, {
        seq: index,
        step: index + 1,
        startTime: index * 2,
        endTime: index * 2 + 1,
      }))
    const value = detail(records)
    value.projection.startTime = 0
    value.projection.endTime = 80_000
    const started = performance.now()

    const analysis = analyzeTrajectory(value)

    expect(analysis.steps).toHaveLength(40_000)
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('uses the same active-duration interval union as the trajectory overview', () => {
    const records = [
      record('first', {
        startTime: 1_000,
        endTime: 2_000,
      }),
      record('second', {
        seq: 2,
        step: 2,
        startTime: 5_000,
        endTime: 6_000,
      }),
    ]
    const value = detail(records)
    value.projection.startTime = 1_000
    value.projection.endTime = 6_000

    const analysis = analyzeTrajectory(value)
    const overview = buildTimelineGeometry(records, true)

    expect(overview.durationMs).toBe(2_000)
    expect(analysis.stats.durationMs).toBe(overview.durationMs)
  })

  it('aggregates records by logical step and does not double-count mirrored usage', () => {
    const reasoning = record('reasoning', {
      seq: 1,
      step: 1,
      kind: 'assistant',
      title: '推理',
      summary: '先运行测试验证修改',
      output: [{ type: 'reasoning', text: '先运行测试验证修改' }],
    })
    const assistant = record('assistant', {
      seq: 2,
      step: 1,
      kind: 'assistant',
      title: '模型步骤',
      summary: '准备运行测试',
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    })
    const tool = record('tool', {
      seq: 3,
      step: 1,
      title: 'exec_command',
      summary: 'npm test',
      input: { cmd: 'npm test' },
      output: 'Tests 12 passed',
    })
    const model = record('model', {
      seq: 4,
      step: 1,
      kind: 'model',
      title: '模型调用',
      summary: 'usage',
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    })

    const analysis = analyzeTrajectory(detail([reasoning, assistant, tool, model]))

    expect(analysis.steps).toHaveLength(1)
    expect(analysis.steps[0]).toMatchObject({
      recordIds: ['reasoning', 'assistant', 'tool', 'model'],
      action: '运行测试或构建验证',
      execution: '运行测试：npm test',
      result: '测试通过、12 项测试全部通过',
      durationMs: 1_000,
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    })
    expect(analysis.costSteps).toHaveLength(1)
  })

  it('reports unallocated session tokens and lowers efficiency confidence', () => {
    const value = detail([
      record('model', {
        kind: 'model',
        usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      }),
    ])
    value.projection.usage = {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    }

    const analysis = analyzeTrajectory(value)
    const efficiency = analysis.evaluations.find(item => item.id === 'efficiency')

    expect(analysis.stats).toMatchObject({
      allocatedTokens: 100,
      unallocatedTokens: 50,
      tokenAllocationCoverage: 100 / 150,
    })
    expect(efficiency).toMatchObject({
      confidence: 'low',
      label: '步骤成本覆盖不完整',
    })
  })

  it('extracts patch filenames from truncated previews without leaking patch content', () => {
    const patch = record('patch', {
      title: 'apply_patch',
      input: {
        truncated: true,
        originalBytes: 50_000,
        preview: [
          '*** Begin Patch',
          '*** Update File: /workspace/src/trajectory-analysis.ts',
          '@@',
          '-old',
          '+new',
          '*** Update File: /workspace/tests/trajectory-analysis.test.ts',
          '@@',
          '-old test',
          '+new test',
          '*** End Patch',
        ].join('\\n'),
      },
    })

    const analysis = analyzeTrajectory(detail([patch]))

    expect(analysis.steps[0]).toMatchObject({
      action: '修改 trajectory-analysis.ts、trajectory-analysis.test.ts',
      execution: '修改 trajectory-analysis.ts、trajectory-analysis.test.ts',
      result: '修改 trajectory-analysis.ts、trajectory-analysis.test.ts成功',
    })
    expect(analysis.steps[0]!.action).not.toContain('old test')
  })

  it('does not treat reading a test source file as an independent validation', () => {
    const readTest = record('read-test-source', {
      title: 'exec_command',
      summary: "sed -n '1,200p' tests/App.test.tsx",
      input: { cmd: "sed -n '1,200p' tests/App.test.tsx" },
      output: 'test source contents',
    })

    const analysis = analyzeTrajectory(detail([readTest]))

    expect(analysis.steps[0]).toMatchObject({
      action: '读取相关文件内容',
      execution: "读取相关文件内容：sed -n '1,200p' tests/App.test.tsx",
    })
    expect(analysis.outcome).toMatchObject({
      label: '未发现错误证据',
      confidence: 'low',
    })
    expect(analysis.evaluations[0]).toMatchObject({
      label: '无法判断正确性',
      grade: 'unknown',
    })
  })
})
