import { describe, expect, it } from 'vitest'
import { capabilities } from '../server/sources/types'
import { analyzeTrajectory } from '../src/trajectory-analysis'
import {
  analyzeTrajectoryOptimizations,
} from '../src/trajectory-optimization'
import type { SessionDetail, SourceId, TrajectoryRecord } from '../src/types'

function record(id: number, overrides: Partial<TrajectoryRecord> = {}): TrajectoryRecord {
  return {
    id: `r${id}`, source: 'codex', sourceEventIds: [`e${id}`], fidelity: 'exact',
    seq: id, turn: 1, step: id, kind: 'tool', title: 'exec_command',
    summary: '读取文件', startTime: id * 100, endTime: id * 100 + 50,
    status: 'complete', depth: 0, input: { cmd: 'cat README.md' },
    output: 'same content', searchText: '', ...overrides,
  }
}

function detail(records: TrajectoryRecord[], source: SourceId = 'codex'): SessionDetail {
  return {
    summary: {
      id: `${source}:test`, source, sourceSessionId: 'test', format: 'test',
      capabilities: capabilities('tools'), cwd: '/workspace', title: 'test',
      createdAt: 0, updatedAt: 1000, size: 1,
    },
    projection: {
      header: { source, id: 'test', format: 'test', createdAt: 0 },
      records, turns: [], lanes: [], eventCount: records.length,
      eventTypeCounts: {}, unknownEventTypes: [], turnEnds: {},
      startTime: 0, endTime: 1000,
    },
  }
}

const failed = (id: number, overrides: Partial<TrajectoryRecord> = {}) => record(id, {
  status: 'error', input: { cmd: 'tool --bad-flag' },
  output: 'invalid argument: bad-flag', error: { code: 'EINVAL' }, ...overrides,
})

describe('trajectory optimization', () => {
  it.each(['codex', 'dsh', 'zcode'] as const)('finds a single evidence-backed repetition for %s', source => {
    const value = detail([record(1), record(2), record(3)], source)
    const found = analyzeTrajectory(value).optimizations!
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      category: 'duplicate', occurrences: 3, confidence: 'medium',
      evidence: [{ recordId: 'r1', turn: 1, step: 1 }, { recordId: 'r2', turn: 1, step: 2 }, { recordId: 'r3', turn: 1, step: 3 }],
    })
  })

  it('does not equate missing output, reordered shell arguments, or changed output', () => {
    for (const overrides of [
      { output: undefined }, { output: 'changed' },
      { input: { cmd: 'cat  README.md' } },
    ]) {
      expect(analyzeTrajectoryOptimizations(detail([
        record(1), record(2, overrides), record(3),
      ]))).toEqual([])
    }
  })

  it('excludes repeated validations, polling, and duplicated nested records', () => {
    for (const overrides of [
      { input: { cmd: 'npm test' } }, { title: 'write_stdin' },
      { input: { cmd: 'tail logfile' } }, { callId: 'same-call' },
      { parentCallId: 'parent' }, { parentSpanId: 'parent' },
    ]) {
      expect(analyzeTrajectoryOptimizations(detail([
        record(1, overrides), record(2, overrides), record(3, overrides),
      ]))).toEqual([])
    }
  })

  it('invalidates repetitions after edits, unknown effects, turn changes and user steering', () => {
    for (const separator of [
      record(3, { title: 'apply_patch' }),
      record(3, { input: { cmd: 'custom-script' } }),
      record(3, { kind: 'user', summary: '请再次读取并复核' }),
      record(3, { kind: 'steering', summary: '更改要求' }),
      record(3, { kind: 'compaction' }),
      record(3, { turn: 2 }),
    ]) {
      const found = analyzeTrajectoryOptimizations(detail([record(1), record(2), separator, record(4)]))
      expect(found.some(item => item.category === 'duplicate')).toBe(false)
    }
  })

  it('honors explicit rechecks throughout the request interval', () => {
    expect(analyzeTrajectoryOptimizations(detail([
      record(0, { kind: 'user', summary: '重复读取检查一致性' }),
      record(1), record(2), record(3),
    ]))).toEqual([])
  })

  it('merges repeated parameter errors instead of also reporting duplicate calls', () => {
    const found = analyzeTrajectoryOptimizations(detail([failed(1), failed(2), failed(3)]))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      category: 'retry', priority: 'high', occurrences: 3, measures: ['code', 'hook'],
    })
    expect(found[0]?.action).toContain('支持调用前 Hook')
  })

  it('keeps different retry problems separate even when they share one category', () => {
    const found = analyzeTrajectoryOptimizations(detail([
      failed(1),
      failed(2),
      failed(3, {
        input: { cmd: 'another-tool' },
        output: 'deterministic failure',
        error: { code: 'failed' },
      }),
      failed(4, {
        input: { cmd: 'another-tool' },
        output: 'deterministic failure',
        error: { code: 'failed' },
      }),
    ]))

    expect(found.map(item => item.title)).toEqual([
      '为参数错误增加重试前检查',
      '相同错误再次出现时，先诊断再重试',
    ])
  })

  it('does not classify temporary errors or post-edit failures as identical retries', () => {
    const temporary = analyzeTrajectoryOptimizations(detail([
      failed(1, { output: 'network timeout' }), failed(2, { output: 'network timeout' }),
    ]))
    expect(temporary).toHaveLength(1)
    expect(temporary[0]).toMatchObject({
      title: '为未恢复错误建立明确的收敛路径',
      occurrences: 1,
    })
    expect(temporary.some(item =>
      item.title === '相同错误再次出现时，先诊断再重试')).toBe(false)
    expect(analyzeTrajectoryOptimizations(detail([
      failed(1), record(2, { title: 'apply_patch' }), failed(3),
    ])).some(item => item.title === '相同错误再次出现时，先诊断再重试')).toBe(false)
  })

  it('does not mistake a filename containing Network for a temporary network error', () => {
    const found = analyzeTrajectoryOptimizations(detail([
      failed(1, {
        output: 'stat: Network Persistent State: no such file',
        error: { code: '1' },
      }),
    ]))
    expect(found[0]).toMatchObject({
      title: '为未恢复错误建立明确的收敛路径',
      confidence: 'high',
    })
  })

  it('always recommends a convergence path for a final unresolved error', () => {
    const found = analyzeTrajectoryOptimizations(detail([
      failed(1, { output: 'first unique failure' }),
      record(2, { input: { cmd: 'pwd' }, output: '/workspace' }),
      failed(3, {
        input: { cmd: 'another-tool' },
        output: 'final unique failure',
        error: { code: 'failed' },
      }),
    ]))
    expect(found).toContainEqual(expect.objectContaining({
      category: 'retry',
      title: '为未恢复错误建立明确的收敛路径',
      priority: 'high',
      confidence: 'high',
      occurrences: 1,
      evidence: [{ recordId: 'r3', turn: 1, step: 3 }],
    }))
  })

  it('suggests capability preflight after several distinct recovered failures', () => {
    const found = analyzeTrajectoryOptimizations(detail([
      failed(1, { input: { cmd: 'tool-a' }, output: 'failure a' }),
      record(2, { input: { cmd: 'pwd' }, output: '/workspace' }),
      failed(3, { input: { cmd: 'tool-b' }, output: 'failure b' }),
      record(4, { input: { cmd: 'pwd' }, output: '/workspace' }),
      failed(5, { input: { cmd: 'tool-c' }, output: 'failure c' }),
      record(6, { input: { cmd: 'pwd' }, output: '/workspace' }),
      failed(7, { input: { cmd: 'tool-d' }, output: 'failure d' }),
      record(8, { input: { cmd: 'pwd' }, output: '/workspace' }),
    ]))
    expect(found).toContainEqual(expect.objectContaining({
      category: 'detour',
      title: '增加能力预检，减少连续失败后的反复改道',
      priority: 'medium',
      confidence: 'medium',
      occurrences: 4,
    }))
  })

  it('keeps a single recovered error quiet', () => {
    expect(analyzeTrajectoryOptimizations(detail([
      failed(1, { output: 'unique failure' }),
      record(2, { input: { cmd: 'pwd' }, output: '/workspace' }),
    ]))).toEqual([])
  })

  it('reports a concrete environment failure without claiming an uninstalled plugin', () => {
    const found = analyzeTrajectoryOptimizations(detail([
      failed(1, { output: 'bash: xyz: command not found' }),
      failed(2, { output: 'bash: xyz: command not found' }),
    ]))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ category: 'environment', occurrences: 2 })
    expect(found[0]?.limitation).toContain('不能确认实际安装状态')
  })

  it('merges distinct environment failures that share one problem and remedy', () => {
    const found = analyzeTrajectoryOptimizations(detail([
      failed(1, {
        input: { cmd: 'first-missing-command' },
        output: 'bash: first-missing-command: command not found',
      }),
      failed(2, {
        input: { cmd: 'node missing-script.mjs' },
        output: 'Error: cannot find module missing-script.mjs',
      }),
    ]))

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      category: 'environment',
      title: '执行前确认所需命令和依赖可用',
      occurrences: 2,
      evidence: [
        { recordId: 'r1', turn: 1, step: 1 },
        { recordId: 'r2', turn: 1, step: 2 },
      ],
    })
  })

  it('reports missing post-edit validation only for finished work', () => {
    const edit = record(2, { title: 'apply_patch' })
    expect(analyzeTrajectoryOptimizations(detail([edit]))[0]).toMatchObject({
      category: 'verification', confidence: 'low',
    })
    expect(analyzeTrajectoryOptimizations(detail([
      edit, record(3, { input: { cmd: 'npm test' } }),
    ]))).toEqual([])
    expect(analyzeTrajectoryOptimizations(detail([
      edit, record(3, {
        input: { cmd: 'npm test' },
        status: 'error',
        output: 'Tests failed',
      }),
    ])).map(item => item.category)).toEqual(['retry', 'verification'])
    expect(analyzeTrajectoryOptimizations(detail([
      edit, record(3, { status: 'running', endTime: null }),
    ]))).toEqual([])
    const reedit = analyzeTrajectoryOptimizations(detail([
      edit, record(3, { input: { cmd: 'npm test' } }),
      record(4, { title: 'apply_patch' }),
    ]))
    expect(reedit[0]?.evidence[0]?.recordId).toBe('r4')
  })

  it('does not infer waste from high cost or missing source data alone', () => {
    expect(analyzeTrajectoryOptimizations(detail([
      record(1, { usage: { totalTokens: 1000000 } }),
      record(2, { input: undefined, output: undefined }),
    ]))).toEqual([])
  })

})
