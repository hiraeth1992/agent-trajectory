import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'dist-electron')

await rm(output, { recursive: true, force: true })

const shared = {
  bundle: true,
  format: 'esm',
  logLevel: 'info',
  minify: false,
  platform: 'node',
  sourcemap: false,
  target: 'node22',
}

await Promise.all([
  build({
    ...shared,
    entryPoints: [path.join(root, 'desktop/main.ts')],
    external: ['electron', 'vite'],
    outfile: path.join(output, 'main.mjs'),
  }),
  build({
    ...shared,
    entryPoints: [path.join(root, 'server/projection-worker.ts')],
    outfile: path.join(output, 'projection-worker.mjs'),
  }),
  build({
    ...shared,
    entryPoints: [path.join(root, 'server/sources/zcode-worker.ts')],
    outfile: path.join(output, 'zcode-worker.mjs'),
  }),
])
