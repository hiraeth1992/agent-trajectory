import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCliArguments, runCli } from '../server/cli'
import type {
  EvaluationRun,
  EvaluationRunDiff,
} from '../src/evaluation-types'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

describe('evaluate command', () => {
  it('parses evaluation paths outside source configuration', () => {
    const parsed = parseCliArguments([
      'evaluate',
      '--data-dir',
      './private-data',
      '--output-dir',
      './reports',
      '--baseline',
      './baseline.json',
    ], {}, '/tmp/home')

    expect(parsed).toMatchObject({
      command: 'evaluate',
      dataRoot: path.resolve('./private-data'),
      outputDirectory: path.resolve('./reports'),
      baseline: path.resolve('./baseline.json'),
      sourcePaths: {},
    })
  })

  it('requires explicit private calibration inputs', () => {
    expect(parseCliArguments([
      'calibrate',
      'prepare',
      '--dataset',
      './private-gold',
      '--count',
      '30',
    ])).toMatchObject({
      command: 'calibrate',
      calibrateAction: 'prepare',
      datasetDirectory: path.resolve('./private-gold'),
      count: 30,
    })
    expect(parseCliArguments([
      'calibrate',
      'agreement',
      '--dataset',
      './private-gold',
      '--reviewer-a',
      './reviewer-a.json',
      '--reviewer-b',
      './reviewer-b.json',
    ])).toMatchObject({
      command: 'calibrate',
      calibrateAction: 'agreement',
      reviewerA: path.resolve('./reviewer-a.json'),
      reviewerB: path.resolve('./reviewer-b.json'),
    })
    expect(parseCliArguments([
      'evaluate',
      '--dataset',
      './private-gold',
      '--adjudication',
      './adjudication.json',
      '--split',
      'calibration',
    ])).toMatchObject({
      command: 'evaluate',
      datasetDirectory: path.resolve('./private-gold'),
      adjudication: path.resolve('./adjudication.json'),
      split: 'calibration',
    })
    expect(() => parseCliArguments([
      'evaluate',
      '--dataset',
      './private-gold',
    ])).toThrow(/must be supplied together/)
    expect(() => parseCliArguments([
      'evaluate',
      '--dataset',
      './private-gold',
      '--adjudication',
      './adjudication.json',
    ])).toThrow(/explicit --split/)
    expect(() => parseCliArguments([
      'calibrate',
      'agreement',
      '--dataset',
      './private-gold',
    ])).toThrow(/requires --reviewer-a and --reviewer-b/)
  })

  it('rejects evaluation-only paths for unrelated commands', () => {
    expect(() => parseCliArguments([
      'doctor',
      '--baseline',
      './baseline.json',
    ])).toThrow(/only valid with evaluate/)
  })

  it('writes private JSON and Markdown reports and compares a baseline', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-evaluate-'))
    roots.push(root)
    const output = path.join(root, 'reports')
    const messages: string[] = []
    vi.spyOn(console, 'log').mockImplementation(message => {
      messages.push(String(message))
    })

    await runCli(['evaluate', '--output-dir', output])
    const firstFiles = await fs.readdir(output)
    const jsonFile = firstFiles.find(file =>
      file.endsWith('.json') && !file.endsWith('.diff.json'))
    const markdownFile = firstFiles.find(file => file.endsWith('.md'))
    expect(jsonFile).toBeDefined()
    expect(markdownFile).toBeDefined()

    const jsonPath = path.join(output, jsonFile!)
    const run = JSON.parse(await fs.readFile(jsonPath, 'utf8')) as EvaluationRun
    const markdown = await fs.readFile(path.join(output, markdownFile!), 'utf8')
    expect(run.aggregate).toMatchObject({
      cases: 12,
      exactCases: 12,
      exactAgreement: 1,
      falsePositives: 0,
      falseNegatives: 0,
    })
    expect(markdown).toContain('Exact agreement: 12/12 (100.0%)')
    expect(messages.join('\n')).toContain('FP/FN: 0/0')
    if (process.platform !== 'win32') {
      expect((await fs.stat(jsonPath)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(path.join(output, markdownFile!))).mode & 0o777)
        .toBe(0o600)
    }

    messages.length = 0
    await runCli([
      'evaluate',
      '--output-dir',
      output,
      '--baseline',
      jsonPath,
    ])
    const diffFile = (await fs.readdir(output)).find(file =>
      file.endsWith('.diff.json'))
    expect(diffFile).toBeDefined()
    const diff = JSON.parse(
      await fs.readFile(path.join(output, diffFile!), 'utf8'),
    ) as EvaluationRunDiff
    expect(diff).toMatchObject({
      comparable: true,
      improvedCaseIds: [],
      regressedCaseIds: [],
    })
    expect(diff.unchangedCaseIds).toHaveLength(12)
    expect(messages.join('\n')).toContain('Improved/regressed/unchanged: 0/0/12')
  })
})
