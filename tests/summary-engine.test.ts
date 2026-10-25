import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  AiEnhancementDraft,
  SummaryAdapterStatus,
} from '../src/ai-summary-types'
import type { AiOptimization } from '../src/trajectory-optimization'
import { capabilities } from '../server/sources/types'
import { SummaryCache } from '../server/summary/cache'
import { SummaryEngine } from '../server/summary/engine'
import { SummarySettingsStore } from '../server/summary/settings'
import {
  MemorySummarySecretStore,
  type SummaryCompletionRequest,
  type SummaryModelAdapter,
} from '../server/summary/types'
import type { ApiRegistry } from '../server/api'
import type {
  SessionDetail,
  SessionSummary,
  SourceStatus,
  TrajectoryRecord,
} from '../src/types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

function summary(): SessionSummary {
  return {
    id: 'zcode:summary-session',
    source: 'zcode',
    sourceSessionId: 'summary-session',
    format: 'test',
    capabilities: capabilities('messages', 'tools', 'timing', 'usage'),
    cwd: '/workspace',
    title: '总结测试',
    createdAt: 1,
    updatedAt: 2,
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
    title: 'exec_command',
    summary: '运行测试',
    startTime: 1,
    endTime: 2,
    status: 'complete',
    depth: 0,
    input: { cmd: 'npm test', apiKey: 'private-value' },
    output: 'Tests 2 passed',
    raw: [{ authorization: 'Bearer private-value', result: 'Tests 2 passed' }],
    searchText: 'test',
    ...overrides,
  }
}

function detail(): SessionDetail {
  const session = summary()
  return {
    summary: session,
    projection: {
      header: {
        source: 'zcode',
        format: 'test',
        id: session.sourceSessionId,
        createdAt: 1,
        provider: 'provider-a',
        model: 'model-a',
      },
      records: [
        record('tool-1', {}),
        record('model-1', {
          seq: 2,
          kind: 'model',
          title: '模型调用',
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        }),
      ],
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
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    },
  }
}

class Registry implements ApiRegistry {
  constructor(readonly value: SessionDetail) {}

  async listSources(): Promise<SourceStatus[]> {
    return []
  }

  async listSessions(): Promise<SessionSummary[]> {
    return [this.value.summary]
  }

  async load(): Promise<SessionDetail> {
    return this.value
  }

  async fingerprint(): Promise<string> {
    return 'fingerprint'
  }

  async raw(_source: string, _session: string, recordId: string) {
    return this.value.projection.records.find(record => record.id === recordId)?.raw
  }
}

function draft(overrides: Partial<AiEnhancementDraft> = {}): AiEnhancementDraft {
  return {
    outcome: {
      headline: '执行完成',
      summary: '完成测试并确认结果',
      verification: '测试证据支持当前结论',
      unresolved: [],
      evidenceRecordIds: ['tool-1', 'not-real'],
    },
    evidenceRequests: [],
    ...overrides,
  }
}

function optimization(
  overrides: Partial<AiOptimization> = {},
): AiOptimization {
  return {
    findingId: '',
    category: 'verification',
    title: '补充验证闭环',
    observation: '修改后没有观察到相关验证',
    cause: '验证可能遗漏或没有记录',
    action: '执行相关测试并保存结果',
    target: '项目验证流程',
    expectedBenefit: '让完成结论有对应依据',
    verification: '确认最终修改后存在成功验证',
    limitation: '没有记录不代表没有执行',
    measures: ['verification'],
    evidenceRecordIds: ['tool-1'],
    ...overrides,
    executionActions: overrides.executionActions ?? [{
      kind: 'rule',
      title: '增加完成前验证规则',
      target: 'AGENTS.md',
      instruction: '加入完成前验证要求',
      content: '- 修改后必须验证',
      verification: '确认修改后存在验证记录',
    }],
  }
}

class FakeAdapter implements SummaryModelAdapter {
  readonly id = 'fake'
  prompts: string[] = []
  schemas: Record<string, unknown>[] = []
  responses: AiEnhancementDraft[]

  constructor(...responses: AiEnhancementDraft[]) {
    this.responses = responses
  }

  async status(): Promise<SummaryAdapterStatus> {
    return {
      id: this.id,
      type: 'openai-compatible',
      label: 'Fake',
      available: true,
      models: [{
        adapterId: this.id,
        adapterType: 'openai-compatible',
        id: 'model-a',
        label: 'model-a',
        isDefault: true,
      }],
    }
  }

  async listModels() {
    return (await this.status()).models
  }

  async complete(request: SummaryCompletionRequest) {
    this.prompts.push(request.prompt)
    this.schemas.push(request.outputSchema)
    return {
      draft: this.responses.shift() ?? draft(),
      usage: { inputTokens: 100, outputTokens: 20 },
    }
  }
}

async function stores() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-summary-test-'))
  roots.push(root)
  const secrets = new MemorySummarySecretStore()
  return {
    root,
    secrets,
    settings: new SummarySettingsStore(path.join(root, 'settings.json'), secrets),
    cache: new SummaryCache(path.join(root, 'cache.json')),
  }
}

describe('SummaryEngine', () => {
  it('builds a redacted fact preview without raw trajectory events', async () => {
    const stored = await stores()
    const engine = new SummaryEngine(
      new Registry(detail()),
      stored.settings,
      stored.cache,
      stored.secrets,
      '/missing-codex',
    )

    const preview = await engine.preview('zcode', 'summary-session', ['outcome'])
    const serialized = JSON.stringify(preview)

    expect(preview.facts.steps).toHaveLength(1)
    expect(serialized).not.toContain('private-value')
    expect(serialized).not.toContain('authorization')
    expect(serialized).not.toContain('"raw"')
    expect(preview.facts.steps[0]?.localFacts.usage?.totalTokens).toBe(12)
  })

  it('invalidates AI facts hashes when the judge-ready quality boundary changes', async () => {
    const stored = await stores()
    const current = detail()
    const registry = new Registry(current)
    const engine = new SummaryEngine(
      registry,
      stored.settings,
      stored.cache,
      stored.secrets,
      '/missing-codex',
    )

    const complete = await engine.preview('zcode', 'summary-session', ['outcome'])
    current.projection.records[0]!.output = {
      truncated: true,
      originalBytes: 100_000,
      preview: 'partial output',
    }
    const truncated = await engine.preview('zcode', 'summary-session', ['outcome'])

    expect(complete.facts.schemaVersion).toBe(3)
    expect(complete.facts.factsQuality).toMatchObject({
      ready: true,
      issues: expect.arrayContaining([
        expect.objectContaining({ id: 'target-live', severity: 'warning' }),
      ]),
    })
    expect(truncated.facts.factsQuality).toMatchObject({
      ready: false,
      blockedCriterionIds: expect.arrayContaining(['outcome']),
    })
    expect(truncated.factsHashes.outcome).not.toBe(complete.factsHashes.outcome)
  })

  it('reports the real session model without auto-selecting it', async () => {
    const stored = await stores()
    const adapter = new FakeAdapter(draft())
    const engine = new SummaryEngine(
      new Registry(detail()),
      stored.settings,
      stored.cache,
      stored.secrets,
      '/missing-codex',
      async () => [adapter],
    )

    const options = await engine.options('zcode', 'summary-session')

    expect(options).toMatchObject({
      sessionProvider: 'provider-a',
      sessionModel: 'model-a',
      sessionModelAvailability: 'direct',
      selectedReason: 'unavailable',
    })
    expect(options.selected).toBeUndefined()
  })

  it('does not pretend a recorded ZCode model is callable when no adapter matches', async () => {
    const stored = await stores()
    const value = detail()
    value.projection.header.provider = 'account:bigmodel-start-plan'
    value.projection.header.model = 'GLM-5.3-Flash'
    const adapter = new FakeAdapter(draft())
    const engine = new SummaryEngine(
      new Registry(value),
      stored.settings,
      stored.cache,
      stored.secrets,
      '/missing-codex',
      async () => [adapter],
    )

    const options = await engine.options('zcode', 'summary-session')

    expect(options.sessionModelAvailability).toBe('fallback')
    expect(options.sessionModelReason).toContain('短期账号请求头')
    expect(options.selected).toBeUndefined()
  })

  it('remembers a successful user selection by source without matching the agent model', async () => {
    const stored = await stores()
    const value = detail()
    value.projection.header.provider = 'account:bigmodel-start-plan'
    value.projection.header.model = 'GLM-5.3-Flash'
    const adapter = new FakeAdapter(draft())
    const engine = new SummaryEngine(
      new Registry(value),
      stored.settings,
      stored.cache,
      stored.secrets,
      '/missing-codex',
      async () => [adapter],
    )

    await engine.generate('zcode', 'summary-session', {
      adapterId: 'fake',
      model: 'model-a',
      remember: true,
      modules: ['outcome'],
    })

    const options = await engine.options('zcode', 'summary-session')
    expect(options.selectedReason).toBe('remembered')
    expect(options.selected).toEqual({ adapterId: 'fake', model: 'model-a' })
    expect((await stored.settings.read()).mappings).toContainEqual({
      source: 'zcode',
      selection: { adapterId: 'fake', model: 'model-a' },
    })
  })

  it('does not cache or remember a generation aborted after model completion', async () => {
    const stored = await stores()
    const controller = new AbortController()
    class AbortingAdapter extends FakeAdapter {
      override async complete(request: SummaryCompletionRequest) {
        const result = await super.complete(request)
        controller.abort()
        return result
      }
    }
    const adapter = new AbortingAdapter(draft())
    const engine = new SummaryEngine(
      new Registry(detail()),
      stored.settings,
      stored.cache,
      stored.secrets,
      '/missing-codex',
      async () => [adapter],
    )

    await expect(engine.generate('zcode', 'summary-session', {
      adapterId: 'fake',
      model: 'model-a',
      remember: true,
      modules: ['outcome'],
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })

    expect(await stored.cache.get('zcode', 'summary-session')).toBeUndefined()
    expect((await stored.settings.read()).mappings).toEqual([])
  })

  it('validates ids and reads only requested evidence in the second stage', async () => {
    const stored = await stores()
    const adapter = new FakeAdapter(
      draft({
        evidenceRequests: [
          { recordId: 'tool-1', reason: '需要测试输出' },
          { recordId: 'not-real', reason: '非法请求' },
        ],
      }),
      draft({
        outcome: {
          ...draft().outcome!,
          summary: '根据测试证据确认修改通过',
        },
        evidenceRequests: [],
      }),
    )
    const engine = new SummaryEngine(
      new Registry(detail()),
      stored.settings,
      stored.cache,
      stored.secrets,
      '/missing-codex',
      async () => [adapter],
    )

    const result = await engine.generate('zcode', 'summary-session', {
      adapterId: 'fake',
      model: 'model-a',
      remember: true,
      modules: ['outcome'],
    })

    expect(adapter.prompts).toHaveLength(2)
    expect(adapter.prompts[1]).toContain('tool-1')
    expect(adapter.prompts[1]).not.toContain('not-real')
    expect(adapter.prompts[1]).not.toContain('private-value')
    expect(result.modules.outcome?.value.evidenceRecordIds).toEqual(['tool-1'])
    expect(result.modules.outcome?.value.summary)
      .toBe('根据测试证据确认修改通过')
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 40 })

    const options = await engine.options('zcode', 'summary-session')
    expect(options.cacheStatus).toBe('current')
    expect(options.cached?.modules.outcome?.value.summary)
      .toBe('根据测试证据确认修改通过')
  })

  it('keeps only evidence-backed optimization proposals and uses a scoped schema', async () => {
    const stored = await stores()
    const adapter = new FakeAdapter(draft({
      outcome: undefined,
      optimization: [
        optimization(),
        optimization({ evidenceRecordIds: ['not-real'] }),
        optimization({ evidenceRecordIds: ['tool-1'] }),
      ],
    }))
    const engine = new SummaryEngine(
      new Registry(detail()),
      stored.settings,
      stored.cache,
      stored.secrets,
      '/missing-codex',
      async () => [adapter],
    )

    const result = await engine.generate('zcode', 'summary-session', {
      adapterId: 'fake',
      model: 'model-a',
      remember: false,
      modules: ['optimization'],
    })

    expect(result.modules.optimization?.promptVersion).toBe(4)
    expect(result.modules.optimization?.value).toEqual([optimization()])
    expect(adapter.prompts[0]).toContain('Skill')
    expect(adapter.prompts[0]).toContain('AGENTS.md')
    expect(adapter.schemas[0]).toMatchObject({
      required: ['optimization', 'evidenceRequests'],
    })
  })

  it('recomputes preview size by scope and merges a partial run into cached modules', async () => {
    const stored = await stores()
    const adapter = new FakeAdapter(
      draft(),
      draft({
        outcome: undefined,
        objective: {
          statement: '确认并交付可验证的实现',
          successCriteria: ['相关检查通过'],
          constraints: ['保持可信事实不变'],
          evolution: '目标保持稳定',
          evidenceRecordIds: ['tool-1'],
        },
      }),
    )
    const engine = new SummaryEngine(
      new Registry(detail()),
      stored.settings,
      stored.cache,
      stored.secrets,
      '/missing-codex',
      async () => [adapter],
    )
    const objectivePreview = await engine.preview(
      'zcode', 'summary-session', ['objective'],
    )
    const allPreview = await engine.preview(
      'zcode', 'summary-session',
      ['outcome', 'objective', 'story', 'evaluation', 'optimization'],
    )
    expect(objectivePreview.estimatedInputTokens)
      .toBeLessThan(allPreview.estimatedInputTokens)

    await engine.generate('zcode', 'summary-session', {
      adapterId: 'fake',
      model: 'model-a',
      remember: true,
      modules: ['outcome'],
    })
    const result = await engine.generate('zcode', 'summary-session', {
      adapterId: 'fake',
      model: 'model-a',
      remember: true,
      modules: ['objective'],
    })

    expect(result.modules.outcome).toBeDefined()
    expect(result.modules.objective?.value.statement)
      .toBe('确认并交付可验证的实现')
    expect((await stored.settings.read()).lastModules).toEqual(['objective'])
  })

  it('filters a hidden discovered model from options and selection', async () => {
    const stored = await stores()
    const adapter = new FakeAdapter(draft())
    await stored.settings.update({
      defaultSelection: { adapterId: 'fake', model: 'model-a' },
      mappings: [{
        source: 'zcode',
        selection: { adapterId: 'fake', model: 'model-a' },
      }],
      openAiCompatible: [],
      hiddenModels: [{
        adapterId: 'fake',
        model: 'model-a',
        label: 'model-a',
        adapterType: 'openai-compatible',
      }],
    })
    const engine = new SummaryEngine(
      new Registry(detail()),
      stored.settings,
      stored.cache,
      stored.secrets,
      '/missing-codex',
      async () => [adapter],
    )

    const options = await engine.options('zcode', 'summary-session')

    expect(options.adapters[0]?.models).toEqual([])
    expect(options.selected).toBeUndefined()
    expect(options.selectedReason).toBe('unavailable')
  })
})
