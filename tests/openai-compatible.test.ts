import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiCompatibleAdapter } from '../server/summary/adapters/openai-compatible'
import { MemorySummarySecretStore } from '../server/summary/types'

afterEach(() => {
  vi.unstubAllGlobals()
})

function completionResponse(
  content: Record<string, unknown> = {
    outcome: {
      headline: '执行完成',
      summary: '结果已生成',
      verification: '仍需本地验证',
      unresolved: [],
      evidenceRecordIds: [],
    },
    evidenceRequests: [],
  },
): Response {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify(content),
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function capturedRequest(
  baseUrl: string,
  structuredOutputMode?: 'auto' | 'json-schema' | 'json-object',
  outputSchema: Record<string, unknown> = { type: 'object' },
): Promise<{ url: string; body: Record<string, unknown> }> {
  let url = ''
  let body: Record<string, unknown> = {}
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    url = String(input)
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return completionResponse()
  }))
  const secrets = new MemorySummarySecretStore()
  await secrets.set('probe', 'private-key')
  const adapter = new OpenAiCompatibleAdapter({
    id: 'probe',
    type: 'openai-compatible',
    label: 'Probe',
    baseUrl,
    model: 'probe-model',
    structuredOutputMode,
  }, secrets)
  await adapter.complete({
    model: 'probe-model',
    prompt: 'probe',
    modules: ['outcome'],
    outputSchema,
  })
  return { url, body }
}

describe('OpenAiCompatibleAdapter', () => {
  it('uses the configured human-readable name as the model label', async () => {
    const adapter = new OpenAiCompatibleAdapter({
      id: 'custom-summary',
      type: 'openai-compatible',
      label: 'GLM',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'e75ba9a9c903416caf41c5b5289972c0',
    }, new MemorySummarySecretStore())

    expect(await adapter.listModels()).toEqual([expect.objectContaining({
      id: 'e75ba9a9c903416caf41c5b5289972c0',
      label: 'GLM',
    })])
  })

  it.each([
    [
      'https://open.bigmodel.cn/api/paas/v4',
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    ],
    [
      'https://open.bigmodel.cn/api/coding/paas/v4/',
      'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
    ],
    [
      'https://api.openai.com/v1',
      'https://api.openai.com/v1/chat/completions',
    ],
    [
      'https://example.test/custom/chat/completions',
      'https://example.test/custom/chat/completions',
    ],
  ])('resolves Chat Completions endpoint %s', async (baseUrl, expected) => {
    expect((await capturedRequest(baseUrl)).url).toBe(expected)
  })

  it('uses json_object automatically for BigModel Chat Completions', async () => {
    const { body } = await capturedRequest(
      'https://open.bigmodel.cn/api/paas/v4',
    )

    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('includes the response schema in json_object model instructions', async () => {
    const outputSchema = {
      type: 'object',
      required: ['evidenceRequests'],
      properties: {
        evidenceRequests: {
          type: 'array',
          items: {
            type: 'object',
            required: ['recordId', 'reason'],
          },
        },
      },
    }
    const { body } = await capturedRequest(
      'https://open.bigmodel.cn/api/paas/v4',
      'json-object',
      outputSchema,
    )
    const messages = body.messages as Array<{ content?: unknown }>
    const instructions = messages
      .map(message => typeof message.content === 'string' ? message.content : '')
      .join('\n')

    expect(instructions).toContain(JSON.stringify(outputSchema))
  })

  it('retries once when semantic prose contains a numeric fact', async () => {
    const responses = [
      completionResponse({
        objective: {
          statement: '完成 2 项交付',
          successCriteria: ['相关检查通过'],
          constraints: [],
          evolution: '目标保持稳定',
          evidenceRecordIds: [],
        },
        evidenceRequests: [],
      }),
      completionResponse({
        objective: {
          statement: '完成约定交付',
          successCriteria: ['相关检查通过'],
          constraints: [],
          evolution: '目标保持稳定',
          evidenceRecordIds: [],
        },
        evidenceRequests: [],
      }),
    ]
    const requests: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return responses.shift()!
    }))
    const adapter = new OpenAiCompatibleAdapter({
      id: 'probe',
      type: 'openai-compatible',
      label: 'Probe',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'probe-model',
      structuredOutputMode: 'json-object',
    }, new MemorySummarySecretStore())

    const result = await adapter.complete({
      model: 'probe-model',
      prompt: '生成会话目标',
      modules: ['objective'],
      outputSchema: { type: 'object' },
    })

    expect(result.draft.objective?.statement).toBe('完成约定交付')
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1])).toContain('不得包含任何数字事实')
  })

  it('keeps strict json_schema for compatible providers that support it', async () => {
    const { body } = await capturedRequest(
      'https://example.test/v1',
      'json-schema',
    )

    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'agent_trajectory_summary',
        strict: true,
        schema: { type: 'object' },
      },
    })
  })
})
