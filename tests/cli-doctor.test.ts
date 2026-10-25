import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import packageMetadata from '../package.json'
import { runCli } from '../server/cli'
import { hookInstallationFile } from '../server/hook-installation'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

describe('doctor command', () => {
  it('reports Hooks installed by an older version without a machine record as stale', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-doctor-legacy-'))
    roots.push(root)
    const dataRoot = path.join(root, 'data')
    const codexHome = path.join(root, '.codex')
    await fs.mkdir(codexHome, { recursive: true })
    await fs.writeFile(path.join(codexHome, 'hooks.json'), `${JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            command: 'AGENT_TRAJECTORY_HOOK=1 old-machine-command',
          }],
        }],
      },
    }, null, 2)}\n`)
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation(message => {
      output.push(String(message))
    })

    await runCli([
      'doctor',
      '--data-dir',
      dataRoot,
      '--codex-home',
      codexHome,
      '--codex-sessions-dir',
      path.join(root, 'codex-sessions'),
      '--dsh-dir',
      path.join(root, 'dsh-sessions'),
      '--zcode-db',
      path.join(root, 'zcode.sqlite'),
    ])

    const report = output.join('\n')
    expect(report).toContain('hooks  stale')
    expect(report).toContain('Hook installation record is missing')
    expect(report).toContain('Detected installed Hooks: codex')
    expect(report.match(/Repair: agent-trajectory install-hooks/g)).toHaveLength(1)
  })

  it('reports missing Hook executables from an old installation with one repair command', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-doctor-'))
    roots.push(root)
    const dataRoot = path.join(root, 'data')
    const oldNode = path.join(root, 'old-machine', 'node')
    const oldRuntime = path.join(root, 'old-machine', 'agent-trajectory.mjs')
    await fs.mkdir(dataRoot, { recursive: true })
    await fs.writeFile(hookInstallationFile(dataRoot), `${JSON.stringify({
      version: 1,
      packageVersion: '0.1.0',
      platform: process.platform,
      nodeExecutable: oldNode,
      runtimeFile: oldRuntime,
      dataRoot,
      installedAt: '2026-01-02T03:04:05.000Z',
    }, null, 2)}\n`)
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation(message => {
      output.push(String(message))
    })

    await runCli([
      'doctor',
      '--data-dir',
      dataRoot,
      '--codex-home',
      path.join(root, '.codex'),
      '--codex-sessions-dir',
      path.join(root, 'codex-sessions'),
      '--dsh-dir',
      path.join(root, 'dsh-sessions'),
      '--zcode-db',
      path.join(root, 'zcode.sqlite'),
    ])

    const report = output.join('\n')
    expect(report).toContain('hooks  stale')
    expect(report).toContain(`Node executable is missing: ${oldNode}`)
    expect(report).toContain(`Hook runtime is missing: ${oldRuntime}`)
    expect(report.match(/Repair: agent-trajectory install-hooks/g)).toHaveLength(1)
    expect(report).toContain(`--data-dir '${dataRoot}'`)
  })

  it('reports an intact Hook installation copied from another environment as stale', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-doctor-copy-'))
    roots.push(root)
    const dataRoot = path.join(root, 'data')
    const oldDataRoot = path.join(root, 'old-data')
    const oldNode = path.join(root, 'old-node')
    const oldRuntime = path.join(root, 'old-runtime.mjs')
    await fs.mkdir(dataRoot, { recursive: true })
    await fs.writeFile(oldNode, '')
    await fs.writeFile(oldRuntime, '')
    const oldPlatform = process.platform === 'win32' ? 'darwin' : 'win32'
    await fs.writeFile(hookInstallationFile(dataRoot), `${JSON.stringify({
      version: 1,
      packageVersion: '9.9.9',
      platform: oldPlatform,
      nodeExecutable: oldNode,
      runtimeFile: oldRuntime,
      dataRoot: oldDataRoot,
      installedAt: '2026-01-02T03:04:05.000Z',
    }, null, 2)}\n`)
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation(message => {
      output.push(String(message))
    })

    await runCli([
      'doctor',
      '--data-dir',
      dataRoot,
      '--codex-home',
      path.join(root, '.codex'),
      '--codex-sessions-dir',
      path.join(root, 'codex-sessions'),
      '--dsh-dir',
      path.join(root, 'dsh-sessions'),
      '--zcode-db',
      path.join(root, 'zcode.sqlite'),
    ])

    const report = output.join('\n')
    expect(report).toContain(`Platform changed: installed ${oldPlatform}, current ${process.platform}`)
    expect(report).toContain(`Node executable changed: installed ${oldNode}, current ${process.execPath}`)
    expect(report).toContain(`Hook runtime location changed: installed ${oldRuntime}`)
    expect(report).toContain(`Data directory changed: installed ${oldDataRoot}, current ${dataRoot}`)
    expect(report).toContain(
      `Package version changed: installed 9.9.9, current ${packageMetadata.version}`,
    )
    expect(report.match(/Repair: agent-trajectory install-hooks/g)).toHaveLength(1)
  })
})
