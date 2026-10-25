import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SummarySettingsStore } from '../server/summary/settings'
import { MemorySummarySecretStore } from '../server/summary/types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

describe('SummarySettingsStore', () => {
  it('persists ordinary settings without credentials and enforces URL policy', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-settings-'))
    roots.push(root)
    const file = path.join(root, 'settings.json')
    const secrets = new MemorySummarySecretStore()
    const store = new SummarySettingsStore(file, secrets)

    const settings = await store.update({
      defaultSelection: { adapterId: 'local', model: 'qwen' },
      mappings: [{
        source: 'zcode',
        sessionProvider: 'provider',
        sessionModel: 'model',
        selection: { adapterId: 'local', model: 'qwen' },
      }],
      openAiCompatible: [
        {
          id: 'local',
          label: '本地模型',
          baseUrl: 'http://127.0.0.1:11434',
          model: 'qwen',
          apiKey: 'must-not-persist',
        },
        {
          id: 'unsafe',
          label: '不安全远程地址',
          baseUrl: 'http://example.com',
          model: 'bad',
        },
      ],
    })
    await store.setCredential('local', 'private-key')
    const text = await fs.readFile(file, 'utf8')

    expect(settings.openAiCompatible).toHaveLength(1)
    expect(settings.openAiCompatible[0]).toMatchObject({
      id: 'local',
      baseUrl: 'http://127.0.0.1:11434',
      hasCredential: false,
    })
    expect(text).not.toContain('must-not-persist')
    expect(text).not.toContain('private-key')
    expect((await store.read()).openAiCompatible[0]?.hasCredential).toBe(true)
    expect(settings.lastModules).toEqual([
      'outcome', 'objective', 'story', 'evaluation', 'optimization',
    ])
  })

  it('persists an explicit default summary model without an agent-model mapping', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-settings-default-'))
    roots.push(root)
    const store = new SummarySettingsStore(
      path.join(root, 'settings.json'),
      new MemorySummarySecretStore(),
    )

    const settings = await store.update({
      defaultSelection: { adapterId: 'custom', model: 'summary-model' },
      mappings: [],
      openAiCompatible: [{
        id: 'custom',
        label: '用户总结模型',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'summary-model',
        structuredOutputMode: 'json-object',
      }],
    })

    expect(settings.defaultSelection).toEqual({
      adapterId: 'custom',
      model: 'summary-model',
    })
    expect(settings.mappings).toEqual([])
    expect(settings.openAiCompatible[0]?.structuredOutputMode).toBe('json-object')
  })

  it('remembers the last successful enhancement scope', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-settings-scope-'))
    roots.push(root)
    const store = new SummarySettingsStore(
      path.join(root, 'settings.json'),
      new MemorySummarySecretStore(),
    )

    await store.rememberRun(
      'codex',
      { adapterId: 'codex-current', model: 'model-a' },
      ['outcome', 'optimization'],
    )
    await store.update({
      mappings: [],
      openAiCompatible: [],
    })

    expect((await store.read()).lastModules).toEqual([
      'outcome', 'optimization',
    ])
  })

  it('serializes concurrent read-modify-write updates without losing mappings', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-settings-race-'))
    roots.push(root)
    const file = path.join(root, 'settings.json')
    const store = new SummarySettingsStore(file, new MemorySummarySecretStore())
    await store.update({ mappings: [], openAiCompatible: [] })

    await Promise.all([
      store.remember(
        'codex',
        undefined,
        undefined,
        { adapterId: 'adapter-a', model: 'model-a' },
      ),
      store.remember(
        'zcode',
        undefined,
        undefined,
        { adapterId: 'adapter-b', model: 'model-b' },
      ),
    ])

    expect((await store.read()).mappings.map(mapping => mapping.source).sort())
      .toEqual(['codex', 'zcode'])
    const persisted = JSON.parse(await fs.readFile(file, 'utf8')) as {
      mappings: Array<{ source: string }>
    }
    expect(persisted.mappings.map(mapping => mapping.source).sort())
      .toEqual(['codex', 'zcode'])
  })

  it('removes custom models, hides discovered models, and clears their selections', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-settings-remove-'))
    roots.push(root)
    const secrets = new MemorySummarySecretStore()
    const store = new SummarySettingsStore(path.join(root, 'settings.json'), secrets)
    await store.update({
      defaultSelection: { adapterId: 'custom', model: 'custom-model' },
      mappings: [
        {
          source: 'codex',
          selection: { adapterId: 'custom', model: 'custom-model' },
        },
        {
          source: 'zcode',
          selection: { adapterId: 'codex-current', model: 'gpt-5' },
        },
      ],
      openAiCompatible: [{
        id: 'custom',
        label: '用户模型',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'custom-model',
      }],
      hiddenModels: [],
    })
    await store.setCredential('custom', 'private-key')

    const afterCustom = await store.removeModel({
      adapterId: 'custom',
      model: 'custom-model',
      label: '用户模型',
      adapterType: 'openai-compatible',
    })
    expect(afterCustom.defaultSelection).toBeUndefined()
    expect(afterCustom.mappings).toHaveLength(1)
    expect(afterCustom.openAiCompatible).toEqual([])
    expect(await secrets.get('custom')).toBeUndefined()

    const afterCodex = await store.removeModel({
      adapterId: 'codex-current',
      model: 'gpt-5',
      label: 'GPT-5',
      adapterType: 'codex-app-server',
    })
    expect(afterCodex.mappings).toEqual([])
    expect(afterCodex.hiddenModels).toContainEqual({
      adapterId: 'codex-current',
      model: 'gpt-5',
      label: 'GPT-5',
      adapterType: 'codex-app-server',
    })
    expect((await fs.readFile(path.join(root, 'settings.json'), 'utf8')))
      .not.toContain('private-key')
  })

  it('restores a hidden discovered model without changing Codex configuration', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-settings-restore-'))
    roots.push(root)
    const store = new SummarySettingsStore(
      path.join(root, 'settings.json'),
      new MemorySummarySecretStore(),
    )
    await store.update({
      mappings: [],
      openAiCompatible: [],
      hiddenModels: [{
        adapterId: 'codex-current',
        model: 'gpt-5',
        label: 'GPT-5',
        adapterType: 'codex-app-server',
      }],
    })

    expect((await store.restoreModel({
      adapterId: 'codex-current',
      model: 'gpt-5',
    })).hiddenModels).toEqual([])
  })

  it.each([
    [
      'missing',
      { mappings: [], openAiCompatible: [] },
      'invalid summary settings version',
    ],
    [
      'invalid',
      { version: '2', mappings: [], openAiCompatible: [] },
      'invalid summary settings version',
    ],
    [
      'older',
      { version: 1, mappings: [], openAiCompatible: [] },
      'summary settings version 1 requires migration to version 2',
    ],
    [
      'future',
      { version: 3, mappings: [], openAiCompatible: [] },
      'summary settings version 3 is newer than supported version 2',
    ],
  ])('rejects a %s persisted version without rewriting the file', async (
    _case,
    value,
    message,
  ) => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-settings-version-'))
    roots.push(root)
    const file = path.join(root, 'settings.json')
    const original = `${JSON.stringify(value, null, 2)}\n`
    await fs.writeFile(file, original)
    const store = new SummarySettingsStore(file, new MemorySummarySecretStore())

    await expect(store.read()).rejects.toThrow(message)
    expect(await fs.readFile(file, 'utf8')).toBe(original)
  })
})
