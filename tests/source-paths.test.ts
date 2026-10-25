import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configFile,
  portablePath,
  readConfig,
  resolveSourcePaths,
  writeConfig,
} from '../server/source-paths'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

describe('source path resolution', () => {
  it('uses the current computer home directory for every default source', () => {
    const home = path.resolve('/tmp/new-computer-user')
    const resolved = resolveSourcePaths({
      configDirectory: path.join(home, '.agent-trajectory'),
      environment: {},
      homeDirectory: home,
    })

    expect(resolved).toEqual({
      codexHome: path.join(home, '.codex'),
      codexSessionIndex: path.join(home, '.codex', 'session_index.jsonl'),
      codexSessionsDir: path.join(home, '.codex', 'sessions'),
      dshSessionsDir: path.join(home, '.dsh', 'sessions'),
      zcodeDatabase: path.join(home, '.zcode', 'cli', 'db', 'db.sqlite'),
    })
  })

  it('applies CLI, config, environment, and defaults in that order', () => {
    const home = path.resolve('/tmp/path-priority-home')
    const resolved = resolveSourcePaths({
      cli: {
        dshSessionsDir: '${HOME}/cli-dsh',
        codexSessionsDir: './cli-codex-sessions',
      },
      config: {
        dshSessionsDir: '${HOME}/config-dsh',
        codexHome: '${HOME}/config-codex',
        zcodeDatabase: '${CONFIG_DIR}/zcode.sqlite',
      },
      configDirectory: path.join(home, 'config'),
      environment: {
        DSH_SESSIONS_DIR: path.join(home, 'env-dsh'),
        CODEX_HOME: path.join(home, 'env-codex'),
        CODEX_SESSIONS_DIR: path.join(home, 'env-codex-sessions'),
        ZCODE_DB: path.join(home, 'env-zcode.sqlite'),
      },
      homeDirectory: home,
    })

    expect(resolved.dshSessionsDir).toBe(path.join(home, 'cli-dsh'))
    expect(resolved.codexHome).toBe(path.join(home, 'config-codex'))
    expect(resolved.codexSessionsDir).toBe(path.join(home, 'config', 'cli-codex-sessions'))
    expect(resolved.zcodeDatabase).toBe(path.join(home, 'config', 'zcode.sqlite'))
    expect(resolved.codexSessionIndex).toBe(
      path.join(home, 'config-codex', 'session_index.jsonl'),
    )
  })

  it('persists portable HOME paths in a versioned private config file', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-config-'))
    roots.push(root)
    const home = path.join(root, 'home')
    const dataRoot = path.join(home, '.agent-trajectory')
    const written = await writeConfig(dataRoot, {
      dshSessionsDir: portablePath(path.join(home, '.dsh', 'sessions'), home),
      zcodeDatabase: portablePath(path.join(root, 'external', 'db.sqlite'), home),
    })

    expect(written).toBe(configFile(dataRoot))
    expect((await fs.stat(written)).mode & 0o777).toBe(0o600)
    expect(await readConfig(dataRoot)).toEqual({
      version: 1,
      sources: {
        dshSessionsDir: '${HOME}/.dsh/sessions',
        zcodeDatabase: path.join(root, 'external', 'db.sqlite'),
      },
    })
  })

  it.each([
    [
      'missing',
      { sources: { dshSessionsDir: '/tmp/dsh' } },
      'invalid source paths config version',
    ],
    [
      'invalid',
      { version: '1', sources: { dshSessionsDir: '/tmp/dsh' } },
      'invalid source paths config version',
    ],
    [
      'future',
      { version: 2, sources: { dshSessionsDir: '/tmp/dsh' } },
      'source paths config version 2 is newer than supported version 1',
    ],
  ])('rejects a %s config version without rewriting the file', async (
    _case,
    value,
    message,
  ) => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-config-version-'))
    roots.push(root)
    const file = configFile(root)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const original = `${JSON.stringify(value, null, 2)}\n`
    await fs.writeFile(file, original)

    await expect(readConfig(root)).rejects.toThrow(message)
    expect(await fs.readFile(file, 'utf8')).toBe(original)
  })
})
