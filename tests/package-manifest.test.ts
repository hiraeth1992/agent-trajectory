import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import packageMetadata from '../package.json'

function localMarkdownTargets(source: string): string[] {
  return [...source.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)]
    .map(match => match[1]!)
    .filter(target =>
      !target.includes('://')
      && !target.startsWith('#'))
}

describe('npm package documentation', () => {
  it('includes every local file linked by the packaged READMEs', async () => {
    const included = new Set(packageMetadata.files)
    const readmes = ['README.md', 'README.en.md']
    const links = (await Promise.all(readmes.map(async file =>
      localMarkdownTargets(await fs.readFile(file, 'utf8'))))).flat()

    for (const target of links) {
      expect(
        included.has(target) || target === 'LICENSE' || target === 'LICENSE.zh-CN.md',
        `package is missing README target: ${target}`,
      ).toBe(true)
      await expect(fs.stat(path.resolve(target))).resolves.toMatchObject({
        size: expect.any(Number),
      })
    }
  })
})
