import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hookInstallationFile,
  installAgentHooks,
  pruneHookRuntimeDirectories,
  uninstallAgentHooks,
} from '../server/hook-installation'

const roots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-hooks-'))
  roots.push(root)
  const locations = {
    codexHome: path.join(root, '.codex'),
    dshHome: path.join(root, '.dsh'),
    zcodeHome: path.join(root, '.zcode'),
  }
  const codexFile = path.join(locations.codexHome, 'hooks.json')
  const zcodeFile = path.join(locations.zcodeHome, 'cli', 'config.json')
  const dshPatch = path.join(locations.dshHome, 'profiles', 'desktop', 'cordis.patch.yml')
  await fs.mkdir(path.dirname(codexFile), { recursive: true })
  await fs.mkdir(path.dirname(zcodeFile), { recursive: true })
  await fs.mkdir(path.dirname(dshPatch), { recursive: true })
  await fs.writeFile(codexFile, `${JSON.stringify({
    hooks: {
      SessionStart: [{
        hooks: [{ type: 'command', command: 'existing-codex-hook' }],
      }],
    },
  }, null, 2)}\n`)
  await fs.writeFile(zcodeFile, `${JSON.stringify({
    theme: 'dark',
    hooks: {
      enabled: true,
      events: {
        SessionStart: [{
          matcher: '*',
          hooks: [{ type: 'command', command: 'existing-zcode-hook' }],
        }],
      },
    },
  }, null, 2)}\n`)
  await fs.writeFile(dshPatch, '- id: existing\n  name: existing-plugin\n')
  return { root, locations, codexFile, zcodeFile, dshPatch }
}

describe('agent hook installation', () => {
  it('retains only the current and previous immutable Hook runtimes', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-runtime-'))
    roots.push(root)
    const runtimeBase = path.join(root, 'runtime')
    const runtimes = ['oldest', 'previous', 'current'].map(name =>
      path.join(runtimeBase, name))
    await Promise.all(runtimes.map(async (runtime, index) => {
      await fs.mkdir(runtime, { recursive: true })
      await fs.writeFile(path.join(runtime, 'agent-trajectory.mjs'), '')
      const time = new Date(1_000 + index * 1_000)
      await fs.utimes(runtime, time, time)
    }))

    const removed = await pruneHookRuntimeDirectories(
      runtimeBase,
      runtimes[2]!,
    )

    expect(removed).toEqual([runtimes[0]])
    expect(await fs.readdir(runtimeBase)).toEqual(['current', 'previous'])
  })

  it('records the current machine paths and refreshes them when hooks are reinstalled', async () => {
    const { root, locations } = await fixture()
    const dataRoot = path.join(root, 'data')
    const firstNode = path.join(root, 'old', 'node')
    const firstRuntime = path.join(root, 'old', 'agent-trajectory.mjs')
    const currentNode = path.join(root, 'current', 'node')
    const currentRuntime = path.join(root, 'current', 'agent-trajectory.mjs')

    await installAgentHooks(
      locations,
      firstNode,
      firstRuntime,
      dataRoot,
      'darwin',
      {
        installedAt: '2026-01-02T03:04:05.000Z',
        packageVersion: '0.1.0',
      },
    )
    await installAgentHooks(
      locations,
      currentNode,
      currentRuntime,
      dataRoot,
      'linux',
      {
        installedAt: '2026-02-03T04:05:06.000Z',
        packageVersion: '0.2.0',
      },
    )

    const file = hookInstallationFile(dataRoot)
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
      version: 1,
      packageVersion: '0.2.0',
      platform: 'linux',
      nodeExecutable: currentNode,
      runtimeFile: currentRuntime,
      dataRoot,
      installedAt: '2026-02-03T04:05:06.000Z',
    })
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  it('does not create configuration when uninstalling before installation', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-hooks-empty-'))
    roots.push(root)
    const dataRoot = path.join(root, 'data')
    const locations = {
      codexHome: path.join(root, '.codex'),
      dshHome: path.join(root, '.dsh'),
      zcodeHome: path.join(root, '.zcode'),
    }

    const results = await uninstallAgentHooks(locations, dataRoot)

    expect(results.map(result => result.action)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
    ])
    expect(await fs.readdir(root)).toEqual([])
  })

  it('adds and updates one marked SessionStart hook without replacing existing hooks', async () => {
    const {
      root,
      locations,
      codexFile,
      zcodeFile,
      dshPatch,
    } = await fixture()
    const cli = path.join(root, 'cli with spaces.mjs')
    const dataRoot = path.join(root, 'portable data')

    await installAgentHooks(locations, process.execPath, cli, dataRoot)
    await installAgentHooks(locations, process.execPath, cli, dataRoot)

    const codex = JSON.parse(await fs.readFile(codexFile, 'utf8')) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> }
    }
    const zcode = JSON.parse(await fs.readFile(zcodeFile, 'utf8')) as {
      theme: string
      hooks: {
        events: { SessionStart: Array<{ hooks: Array<{ command: string }> }> }
      }
    }
    const codexCommands = codex.hooks.SessionStart.flatMap(group =>
      group.hooks.map(hook => hook.command))
    const zcodeCommands = zcode.hooks.events.SessionStart.flatMap(group =>
      group.hooks.map(hook => hook.command))
    expect(codexCommands).toContain('existing-codex-hook')
    expect(zcodeCommands).toContain('existing-zcode-hook')
    expect(codexCommands.filter(command =>
      command.includes('AGENT_TRAJECTORY_HOOK=1'))).toHaveLength(1)
    expect(zcodeCommands.filter(command =>
      command.includes('AGENT_TRAJECTORY_HOOK=1'))).toHaveLength(1)
    expect(codexCommands.join('\n')).toContain(`--data-dir '${dataRoot}'`)
    expect(zcode.theme).toBe('dark')

    const dsh = await fs.readFile(dshPatch, 'utf8')
    expect(dsh).toContain('- id: existing')
    expect(dsh.match(/Agent Trajectory session hook/g)).toHaveLength(2)
    expect(await fs.readFile(
      path.join(locations.dshHome, 'agent-trajectory-plugin.mjs'),
      'utf8',
    )).toContain('agent/session-start')
  })

  it('quotes POSIX hook paths without command substitution or shell expansion', async () => {
    const { root, locations, codexFile } = await fixture()
    const marker = path.join(root, 'exploit-marker')
    const backtickMarker = path.join(root, 'backtick-marker')
    const argsFile = path.join(root, 'args.json')
    const cli = path.join(root, "cli $(touch exploit-marker) 'quoted'.mjs")
    const dataRoot = path.join(root, 'data `touch backtick-marker` $VALUE')
    await fs.writeFile(
      cli,
      `import { writeFileSync } from 'node:fs'\n`
        + `writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)))\n`,
    )

    await installAgentHooks(
      locations,
      process.execPath,
      cli,
      dataRoot,
      'darwin',
    )

    const codex = JSON.parse(await fs.readFile(codexFile, 'utf8')) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> }
    }
    const command = codex.hooks.SessionStart
      .flatMap(group => group.hooks)
      .find(hook => hook.command.includes('AGENT_TRAJECTORY_HOOK=1'))!
      .command
    expect(command).toContain(`'${cli.replaceAll("'", "'\"'\"'")}'`)
    expect(command).toContain(`'${dataRoot}'`)
    await execFileAsync('/bin/sh', ['-c', command], {
      cwd: root,
      env: { ...process.env, VALUE: 'expanded-value' },
    })
    expect(await fs.access(marker).then(() => true, () => false)).toBe(false)
    expect(await fs.access(backtickMarker).then(() => true, () => false)).toBe(false)
    expect(JSON.parse(await fs.readFile(argsFile, 'utf8'))).toEqual([
      'hook',
      'codex',
      '--data-dir',
      dataRoot,
    ])

    const plugin = await fs.readFile(
      path.join(locations.dshHome, 'agent-trajectory-plugin.mjs'),
      'utf8',
    )
    expect(plugin).toContain('spawn(executable, args')
    expect(plugin).not.toContain('shell: true')
  })

  it('removes only Agent Trajectory entries and leaves backups recoverable', async () => {
    const { root, locations, codexFile, zcodeFile, dshPatch } = await fixture()
    const dataRoot = path.join(root, 'data')
    await installAgentHooks(
      locations,
      process.execPath,
      path.join(root, 'cli.mjs'),
      dataRoot,
    )
    const removed = await uninstallAgentHooks(locations, dataRoot)

    expect(removed.map(result => result.action)).toEqual([
      'removed',
      'removed',
      'removed',
    ])
    const codex = await fs.readFile(codexFile, 'utf8')
    const zcode = await fs.readFile(zcodeFile, 'utf8')
    const dsh = await fs.readFile(dshPatch, 'utf8')
    expect(codex).toContain('existing-codex-hook')
    expect(zcode).toContain('existing-zcode-hook')
    expect(dsh).toContain('existing-plugin')
    expect(`${codex}${zcode}${dsh}`).not.toContain('AGENT_TRAJECTORY_HOOK=1')
    expect(await fs.access(`${codexFile}.agent-trajectory.bak`)
      .then(() => true, () => false)).toBe(true)
    expect(await fs.access(`${zcodeFile}.agent-trajectory.bak`)
      .then(() => true, () => false)).toBe(true)
    expect(await fs.access(`${dshPatch}.agent-trajectory.bak`)
      .then(() => true, () => false)).toBe(true)
    expect(await fs.access(hookInstallationFile(dataRoot))
      .then(() => true, () => false)).toBe(false)
  })

  it('rolls back every file when installation fails after a partial write', async () => {
    const { root, locations, codexFile, zcodeFile, dshPatch } = await fixture()
    const dataRoot = path.join(root, 'data')
    const before = {
      codex: await fs.readFile(codexFile),
      zcode: await fs.readFile(zcodeFile),
      dsh: await fs.readFile(dshPatch),
    }
    const blockedHome = path.join(root, 'blocked-zcode-home')
    await fs.writeFile(blockedHome, 'not a directory')

    await expect(installAgentHooks(
      { ...locations, zcodeHome: blockedHome },
      process.execPath,
      path.join(root, 'cli.mjs'),
      dataRoot,
    )).rejects.toBeDefined()

    expect(await fs.readFile(codexFile)).toEqual(before.codex)
    expect(await fs.readFile(zcodeFile)).toEqual(before.zcode)
    expect(await fs.readFile(dshPatch)).toEqual(before.dsh)
    for (const file of [
      `${codexFile}.agent-trajectory.bak`,
      `${zcodeFile}.agent-trajectory.bak`,
      `${dshPatch}.agent-trajectory.bak`,
      path.join(locations.dshHome, 'agent-trajectory-plugin.mjs'),
      hookInstallationFile(dataRoot),
    ]) {
      expect(await fs.access(file).then(() => true, () => false)).toBe(false)
    }
  })

  it('rolls back every file when uninstallation fails after a partial removal', async () => {
    const { root, locations, codexFile, zcodeFile, dshPatch } = await fixture()
    const dataRoot = path.join(root, 'data')
    await installAgentHooks(
      locations,
      process.execPath,
      path.join(root, 'cli.mjs'),
      dataRoot,
    )
    const plugin = path.join(locations.dshHome, 'agent-trajectory-plugin.mjs')
    const installation = hookInstallationFile(dataRoot)
    const before = {
      codex: await fs.readFile(codexFile),
      zcode: await fs.readFile(zcodeFile),
      dsh: await fs.readFile(dshPatch),
      plugin: await fs.readFile(plugin),
      installation: await fs.readFile(installation),
    }
    const blockedHome = path.join(root, 'blocked-zcode-home')
    await fs.writeFile(blockedHome, 'not a directory')

    await expect(uninstallAgentHooks(
      { ...locations, zcodeHome: blockedHome },
      dataRoot,
    )).rejects.toBeDefined()

    expect(await fs.readFile(codexFile)).toEqual(before.codex)
    expect(await fs.readFile(zcodeFile)).toEqual(before.zcode)
    expect(await fs.readFile(dshPatch)).toEqual(before.dsh)
    expect(await fs.readFile(plugin)).toEqual(before.plugin)
    expect(await fs.readFile(installation)).toEqual(before.installation)
  })
})
