import { chmod, cp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'dist-cli')
const shared = {
  bundle: true,
  format: 'esm',
  logLevel: 'info',
  minify: false,
  platform: 'node',
  sourcemap: false,
  target: 'node22',
}

await rm(output, { recursive: true, force: true })
await mkdir(path.join(output, 'lib'), { recursive: true })
await cp(path.join(root, 'dist'), path.join(output, 'dist'), {
  recursive: true,
})
await cp(
  path.join(root, 'skills', 'trajectory-diagnosis'),
  path.join(output, 'skills', 'trajectory-diagnosis'),
  { recursive: true },
)
await Promise.all([
  build({
    ...shared,
    banner: { js: '#!/usr/bin/env node' },
    entryPoints: [path.join(root, 'server/cli-main.ts')],
    external: ['vite'],
    outfile: path.join(output, 'agent-trajectory.mjs'),
  }),
  build({
    ...shared,
    entryPoints: [path.join(root, 'server/projection-worker.ts')],
    outfile: path.join(output, 'lib', 'projection-worker.mjs'),
  }),
  build({
    ...shared,
    entryPoints: [path.join(root, 'server/sources/zcode-worker.ts')],
    outfile: path.join(output, 'lib', 'zcode-worker.mjs'),
  }),
  build({
    ...shared,
    entryPoints: [path.join(root, 'server/sources/workbuddy-worker.ts')],
    outfile: path.join(output, 'lib', 'workbuddy-worker.mjs'),
  }),
  build({
    ...shared,
    entryPoints: [path.join(root, 'server/sources/opencode-worker.ts')],
    outfile: path.join(output, 'lib', 'opencode-worker.mjs'),
  }),
  build({
    ...shared,
    banner: { js: '#!/usr/bin/env node' },
    entryPoints: [path.join(root, 'server/diagnosis/evidence-cli.ts')],
    outfile: path.join(output, 'lib', 'diagnosis-evidence.mjs'),
  }),
])
await chmod(path.join(output, 'agent-trajectory.mjs'), 0o755)
await chmod(path.join(output, 'lib', 'diagnosis-evidence.mjs'), 0o755)
