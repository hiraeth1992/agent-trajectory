import type {
  EvaluationTargetRef,
  FrozenEvaluationCase,
} from '../../src/evaluation-types'
import type {
  SessionDetail,
  SessionSummary,
  SourceCapabilities,
  SourceId,
  SourceStatus,
  TokenUsage,
  TrajectoryRecord,
} from '../../src/types'
import { capabilities, sessionKey } from '../sources/types'
import { createEvaluationDataset } from './identity'

const SOURCE_CAPABILITIES: Record<SourceId, SourceCapabilities> = {
  dsh: capabilities(
    'messages',
    'tools',
    'nestedTools',
    'timing',
    'usage',
    'live',
    'attachments',
    'lineage',
    'policy',
    'tasks',
  ),
  codex: capabilities('messages', 'tools', 'timing', 'usage', 'live'),
  zcode: capabilities('messages', 'tools', 'timing', 'usage', 'live', 'trace', 'policy'),
}

function summary(source: SourceId, caseId: string): SessionSummary {
  return {
    id: sessionKey(source, caseId),
    source,
    sourceSessionId: caseId,
    format: `${source}-gold-v1`,
    capabilities: SOURCE_CAPABILITIES[source],
    cwd: '/workspace/gold',
    title: `Gold ${caseId}`,
    createdAt: 1_000,
    updatedAt: 10_000,
    size: 1,
    rawVersion: 1,
  }
}

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
    summary: id,
    startTime: 1_000,
    endTime: 2_000,
    status: 'complete',
    depth: 0,
    input: { cmd: 'npm test' },
    output: 'Test Files 1 passed\nTests 2 passed',
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    searchText: id,
    ...overrides,
  }
}

function user(
  source: SourceId,
  id: string,
  text: string,
  turn = 1,
  seq = 1,
): TrajectoryRecord {
  return record(source, id, {
    seq,
    turn,
    step: 0,
    kind: turn === 1 ? 'user' : 'steering',
    title: turn === 1 ? '用户' : '用户补充',
    summary: text,
    input: [{ type: 'text', text }],
    output: undefined,
    usage: undefined,
    startTime: turn * 1_000,
    endTime: turn * 1_000,
  })
}

function detail(
  source: SourceId,
  caseId: string,
  records: TrajectoryRecord[],
): SessionDetail {
  const value = summary(source, caseId)
  const turnNumbers = [...new Set(records.map(item => item.turn))]
    .filter(number => number > 0)
    .sort((left, right) => left - right)
  return {
    summary: value,
    projection: {
      header: {
        source,
        format: value.format,
        id: caseId,
        createdAt: value.createdAt,
        rawVersion: value.rawVersion,
      },
      records,
      turns: turnNumbers.map(number => {
        const turnRecords = records.filter(item => item.turn === number)
        const running = turnRecords.some(item => item.status === 'running')
        return {
          id: `turn-${number}`,
          number,
          startTime: Math.min(...turnRecords.map(item => item.startTime)),
          endTime: running
            ? null
            : Math.max(...turnRecords.map(item => item.endTime ?? item.startTime)),
          status: running ? 'running' : 'complete',
        }
      }),
      lanes: [],
      startTime: Math.min(...records.map(item => item.startTime)),
      endTime: Math.max(...records.map(item => item.endTime ?? item.startTime)),
      eventCount: records.length,
      eventTypeCounts: {},
      unknownEventTypes: [],
      turnEnds: Object.fromEntries(turnNumbers.map(number => [
        number,
        { time: number * 1_000 + 900, reason: 'complete' },
      ])),
      usage: records.reduce<TokenUsage>((usage, item) => ({
        inputTokens: (usage.inputTokens ?? 0) + (item.usage?.inputTokens ?? 0),
        outputTokens: (usage.outputTokens ?? 0) + (item.usage?.outputTokens ?? 0),
        totalTokens: (usage.totalTokens ?? 0) + (item.usage?.totalTokens ?? 0),
      }), {}),
    },
  }
}

function sourceStatus(source: SourceId): SourceStatus {
  return {
    source,
    availability: 'available',
    label: source.toUpperCase(),
    colorToken: source === 'dsh' ? 'blue' : source === 'codex' ? 'green' : 'amber',
    iconToken: source === 'dsh' ? 'agent' : source === 'codex' ? 'code' : 'terminal',
    sessionCount: 1,
    capabilities: SOURCE_CAPABILITIES[source],
    protocol: {
      detected: `${source}-gold-v1`,
      supported: [`${source}-gold-v1`],
      fingerprint: `${source}:gold:v1`,
    },
  }
}

function target(source: SourceId, caseId: string): EvaluationTargetRef {
  return {
    source,
    sourceSessionId: caseId,
    mode: 'frozen',
    fingerprint: `gold:${caseId}:v1`,
    snapshotId: `gold-${caseId}-snapshot`,
  }
}

function goldCase(
  value: Omit<FrozenEvaluationCase, 'target' | 'sourceStatus'> & {
    source: SourceId
  },
): FrozenEvaluationCase {
  const { source, ...selected } = value
  return {
    ...selected,
    target: target(source, value.id),
    sourceStatus: sourceStatus(source),
  }
}

const cases: FrozenEvaluationCase[] = [
  goldCase({
    id: 'zcode-verified-success',
    split: 'calibration',
    source: 'zcode',
    description: '正常正控：修改后测试通过。',
    detail: detail('zcode', 'zcode-verified-success', [
      user('zcode', 'user-1', '修复问题并验证'),
      record('zcode', 'validation-1', { seq: 2 }),
    ]),
    expected: [
      { criterionId: 'outcome', verdict: 'pass', evidenceRecordIds: ['validation-1'] },
      { criterionId: 'recovery', verdict: 'not_applicable' },
    ],
    expectedRequirements: [{
      id: 'requirement:user-1:01',
      state: 'implemented',
    }],
    expectedChain: { continuity: 'not_applicable' },
  }),
  goldCase({
    id: 'codex-unverified-completion',
    split: 'calibration',
    source: 'codex',
    description: '正常结束但没有测试或业务真值。',
    detail: detail('codex', 'codex-unverified-completion', [
      user('codex', 'user-1', '实现导出功能'),
      record('codex', 'edit-1', {
        seq: 2,
        title: 'apply_patch',
        input: '*** Update File: src/export.ts',
        output: 'Done',
        usage: undefined,
      }),
    ]),
    expected: [
      { criterionId: 'outcome', verdict: 'insufficient_evidence', attribution: 'source' },
      { criterionId: 'reliability', verdict: 'pass' },
    ],
    expectedRequirements: [{
      id: 'requirement:user-1:01',
      state: 'insufficient_evidence',
    }],
  }),
  goldCase({
    id: 'dsh-validation-failure',
    split: 'calibration',
    source: 'dsh',
    description: '验证明确失败且没有恢复。',
    detail: detail('dsh', 'dsh-validation-failure', [
      user('dsh', 'user-1', '修复测试'),
      record('dsh', 'validation-1', {
        seq: 2,
        status: 'error',
        output: 'Tests 1 failed',
        error: { code: '1', reason: 'one assertion failed' },
      }),
    ]),
    expected: [
      { criterionId: 'outcome', verdict: 'fail', attribution: 'agent' },
      { criterionId: 'reliability', verdict: 'fail' },
      { criterionId: 'recovery', verdict: 'fail' },
    ],
    expectedRequirements: [{
      id: 'requirement:user-1:01',
      state: 'understood_unimplemented',
    }],
  }),
  goldCase({
    id: 'zcode-recovered-and-verified',
    split: 'calibration',
    source: 'zcode',
    description: '先失败，修复后验证成功。',
    detail: detail('zcode', 'zcode-recovered-and-verified', [
      user('zcode', 'user-1', '修复失败并验证'),
      record('zcode', 'validation-failed', {
        seq: 2,
        step: 1,
        status: 'error',
        output: 'Tests 1 failed',
        error: { code: '1', reason: 'one assertion failed' },
      }),
      record('zcode', 'edit-1', {
        seq: 3,
        step: 2,
        title: 'apply_patch',
        input: '*** Update File: tests/example.test.ts',
        output: 'Done',
        usage: undefined,
        startTime: 2_100,
        endTime: 2_200,
      }),
      record('zcode', 'validation-passed', {
        seq: 4,
        step: 3,
        startTime: 2_300,
        endTime: 2_500,
      }),
    ]),
    expected: [
      { criterionId: 'outcome', verdict: 'pass' },
      { criterionId: 'reliability', verdict: 'warning' },
      { criterionId: 'recovery', verdict: 'pass' },
    ],
  }),
  goldCase({
    id: 'codex-edit-after-validation',
    split: 'calibration',
    source: 'codex',
    description: '测试通过后又修改，最终状态未验证。',
    detail: detail('codex', 'codex-edit-after-validation', [
      user('codex', 'user-1', '修改并验证'),
      record('codex', 'validation-1', { seq: 2 }),
      record('codex', 'edit-1', {
        seq: 3,
        title: 'apply_patch',
        input: '*** Update File: src/example.ts',
        output: 'Done',
        usage: undefined,
      }),
    ]),
    expected: [
      { criterionId: 'outcome', verdict: 'warning' },
    ],
  }),
  goldCase({
    id: 'dsh-live-session',
    split: 'calibration',
    source: 'dsh',
    description: '运行中会话由事实质量门禁短路。',
    detail: detail('dsh', 'dsh-live-session', [
      user('dsh', 'user-1', '继续执行'),
      record('dsh', 'running-tool', {
        seq: 2,
        status: 'running',
        endTime: null,
        output: undefined,
      }),
    ]),
    expected: [
      { criterionId: 'outcome', verdict: 'insufficient_evidence', attribution: 'source' },
      { criterionId: 'reliability', verdict: 'insufficient_evidence' },
    ],
  }),
  goldCase({
    id: 'zcode-truncated-evidence',
    split: 'regression',
    source: 'zcode',
    description: '超长字段截断不能被当成 Agent 失败。',
    detail: detail('zcode', 'zcode-truncated-evidence', [
      user('zcode', 'user-1', '检查完整输出'),
      record('zcode', 'tool-1', {
        seq: 2,
        input: {
          truncated: true,
          originalBytes: 100_000,
          preview: 'partial',
        },
      }),
    ]),
    expected: [
      { criterionId: 'outcome', verdict: 'insufficient_evidence', attribution: 'source' },
      { criterionId: 'recovery', verdict: 'insufficient_evidence' },
    ],
  }),
  goldCase({
    id: 'codex-missing-tool-result',
    split: 'regression',
    source: 'codex',
    description: '已完成工具缺少结果时短路相关判据。',
    detail: detail('codex', 'codex-missing-tool-result', [
      user('codex', 'user-1', '读取并分析结果'),
      record('codex', 'tool-1', {
        seq: 2,
        output: undefined,
      }),
    ]),
    expected: [
      { criterionId: 'outcome', verdict: 'insufficient_evidence', attribution: 'source' },
      { criterionId: 'observability', verdict: 'insufficient_evidence' },
    ],
  }),
  (() => {
    const value = detail('dsh', 'dsh-unknown-required-event', [
      user('dsh', 'user-1', '分析轨迹'),
    ])
    value.projection.unknownEventTypes = ['future/required']
    return goldCase({
      id: 'dsh-unknown-required-event',
      split: 'regression',
      source: 'dsh',
      description: '未知 required event 归因来源，不污染 Agent 质量。',
      detail: value,
      expected: [
        { criterionId: 'outcome', verdict: 'insufficient_evidence', attribution: 'source' },
        { criterionId: 'efficiency', verdict: 'insufficient_evidence' },
      ],
    })
  })(),
  goldCase({
    id: 'zcode-multiple-requirements',
    split: 'regression',
    source: 'zcode',
    description: '整体测试通过不能冒充多个要求逐项完成。',
    detail: detail('zcode', 'zcode-multiple-requirements', [
      user('zcode', 'user-1', '实现导出'),
      user('zcode', 'user-2', '增加权限检查', 2, 2),
      record('zcode', 'validation-1', { seq: 3, turn: 2, step: 1 }),
    ]),
    expected: [
      { criterionId: 'outcome', verdict: 'pass' },
    ],
    expectedRequirements: [
      { id: 'requirement:user-1:01', state: 'insufficient_evidence' },
      { id: 'requirement:user-2:01', state: 'insufficient_evidence' },
    ],
    expectedChain: { continuity: 'insufficient_evidence' },
  }),
  goldCase({
    id: 'codex-explicit-continuity',
    split: 'regression',
    source: 'codex',
    description: '后续轮次显式承接已确认方案。',
    detail: detail('codex', 'codex-explicit-continuity', [
      user('codex', 'user-1', '先设计升级方案'),
      user('codex', 'user-2', '按已确认方案继续开发', 2, 2),
      record('codex', 'action-1', { seq: 3, turn: 2, step: 1 }),
    ]),
    expected: [
      { criterionId: 'reliability', verdict: 'pass' },
    ],
    expectedChain: { continuity: 'normal' },
  }),
  goldCase({
    id: 'dsh-reported-context-loss',
    split: 'regression',
    source: 'dsh',
    description: '用户明确指出前序要求被遗漏。',
    detail: detail('dsh', 'dsh-reported-context-loss', [
      user('dsh', 'user-1', '实现导出并保留权限检查'),
      user('dsh', 'user-2', '你忘了前面的权限要求', 2, 2),
    ]),
    expected: [
      { criterionId: 'outcome', verdict: 'insufficient_evidence' },
    ],
    expectedChain: {
      continuity: 'missing',
      failedTransition: { fromTurn: 1, toTurn: 2 },
    },
  }),
]

export const SYNTHETIC_CONTRACT_DATASET = createEvaluationDataset({
  schemaVersion: 1,
  id: 'agent-trajectory-synthetic-contract',
  version: '1',
  description: 'Twelve anonymous frozen trajectories for evaluator contract regression.',
  goldCompleteness: 'partial-contract',
  cases,
})

/** @deprecated Use SYNTHETIC_CONTRACT_DATASET. */
export const MINIMAL_GOLD_DATASET = SYNTHETIC_CONTRACT_DATASET
