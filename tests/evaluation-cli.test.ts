import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCliArguments, runCli } from '../server/cli'
import type {
  EvaluationRun,
  EvaluationRunDiff,
  HumanEvaluationAnnotations,
} from '../src/evaluation-types'
import {
  createAnnotationTemplate,
  prepareCalibrationCandidates,
} from '../server/evaluation/calibration'
import { SYNTHETIC_CONTRACT_DATASET } from '../server/evaluation/gold-dataset'
import { capabilities } from '../server/sources/types'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

describe('evaluate command', () => {
  it('refreshes agreement without overwriting an existing adjudication', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-agreement-'))
    roots.push(root)
    const dataset = path.join(root, 'dataset')
    const details = SYNTHETIC_CONTRACT_DATASET.cases.slice(0, 3).map(testCase =>
      structuredClone(testCase.detail))
    const source = {
      listSources: async () => details.map(detail => ({
        source: detail.summary.source,
        availability: 'available' as const,
        label: detail.summary.source,
        colorToken: 'blue' as const,
        iconToken: 'agent' as const,
        sessionCount: 1,
        capabilities: capabilities('messages', 'tools'),
      })),
      listSessions: async () => details.map(detail => detail.summary),
      fingerprint: async (sourceId: string, sessionId: string) =>
        `${sourceId}:${sessionId}`,
      load: async (sourceId: string, sessionId: string) =>
        structuredClone(details.find(detail =>
          detail.summary.source === sourceId
          && detail.summary.sourceSessionId === sessionId)),
    }
    const prepared = await prepareCalibrationCandidates(source, dataset, {
      count: 3,
      datasetId: 'agreement-refresh-test',
      datasetVersion: '1',
    })
    const complete = (reviewerId: string): HumanEvaluationAnnotations => {
      const template = createAnnotationTemplate(prepared.manifest, reviewerId)
      return {
        ...template,
        cases: template.cases.map(testCase => ({
          ...testCase,
          criteria: testCase.criteria.map(criterion => ({
            ...criterion,
            verdict: 'insufficient_evidence' as const,
            attribution: 'source' as const,
            notes: 'Reviewed.',
          })),
          requirements: [{
            id: 'requirement-001',
            text: 'Review the trajectory',
            required: true,
            state: 'insufficient_evidence' as const,
            evidenceRecordIds: ['record-001'],
            notes: 'Reviewed.',
          }],
          chain: {
            continuity: 'not_applicable' as const,
            evidenceRecordIds: ['record-001'],
            notes: 'Single turn.',
          },
          notes: 'Reviewed.',
        })),
      }
    }
    const reviewerA = path.join(dataset, 'reviewer-a.json')
    const reviewerB = path.join(dataset, 'reviewer-b.json')
    await fs.writeFile(reviewerA, JSON.stringify(complete('reviewer-a')))
    await fs.writeFile(reviewerB, JSON.stringify(complete('reviewer-b')))
    const arguments_ = [
      'calibrate',
      'agreement',
      '--dataset',
      dataset,
      '--reviewer-a',
      reviewerA,
      '--reviewer-b',
      reviewerB,
    ]

    await runCli(arguments_)
    const adjudicationFile = path.join(dataset, 'adjudication.json')
    const adjudication = JSON.parse(await fs.readFile(adjudicationFile, 'utf8'))
    adjudication.cases[0].notes = 'PRESERVE_EXISTING_ADJUDICATION'
    await fs.writeFile(adjudicationFile, JSON.stringify(adjudication))
    const annotations = JSON.parse(await fs.readFile(reviewerA, 'utf8'))
    annotations.cases[0].notes = 'Reviewer correction'
    await fs.writeFile(reviewerA, JSON.stringify(annotations))

    await runCli(arguments_)

    expect(JSON.parse(await fs.readFile(adjudicationFile, 'utf8')).cases[0].notes)
      .toBe('PRESERVE_EXISTING_ADJUDICATION')
  })

  it('parses first-batch source path overrides without changing the command', () => {
    expect(parseCliArguments([
      'doctor',
      '--claude-projects-dir',
      './claude-projects',
      '--doubao-work-sessions-dir',
      './doubao-sessions',
      '--workbuddy-home',
      './workbuddy',
      '--qoder-projects-dir',
      './qoder-projects',
      '--opencode-db',
      './opencode.db',
    ])).toMatchObject({
      command: 'doctor',
      sourcePaths: {
        claudeProjectsDir: './claude-projects',
        doubaoWorkSessionsDir: './doubao-sessions',
        workbuddyHome: './workbuddy',
        qoderProjectsDir: './qoder-projects',
        openCodeDatabase: './opencode.db',
      },
    })
  })

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
      '--allow-partial',
    ])).toMatchObject({
      command: 'calibrate',
      calibrateAction: 'prepare',
      datasetDirectory: path.resolve('./private-gold'),
      count: 30,
      allowPartial: true,
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
      '--allow-partial',
      '--reviewer-a',
      './reviewer-a.json',
      '--reviewer-b',
      './reviewer-b.json',
    ])).toThrow(/only valid with calibrate prepare/)
    expect(() => parseCliArguments([
      'calibrate',
      'agreement',
      '--dataset',
      './private-gold',
    ])).toThrow(/requires --reviewer-a and --reviewer-b/)
  })

  it('parses explicit casebook decisions and retests', () => {
    expect(parseCliArguments([
      'casebook',
      'decide',
      '--entry',
      'a'.repeat(24),
      '--decision',
      'accepted',
      '--note',
      'Adopt this fix',
    ])).toMatchObject({
      command: 'casebook',
      casebookAction: 'decide',
      casebookEntry: 'a'.repeat(24),
      casebookDecision: 'accepted',
      casebookNote: 'Adopt this fix',
    })
    expect(parseCliArguments([
      'casebook',
      'retest',
      '--entry',
      'b'.repeat(24),
      '--run',
      './candidate.json',
    ])).toMatchObject({
      command: 'casebook',
      casebookAction: 'retest',
      casebookEntry: 'b'.repeat(24),
      casebookRun: path.resolve('./candidate.json'),
    })
    expect(() => parseCliArguments([
      'casebook',
      'decide',
      '--entry',
      'a'.repeat(24),
    ])).toThrow(/requires --entry and --decision/)
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
      file.startsWith('agent-trajectory-synthetic-contract-')
      && file.endsWith('.json')
      && !file.endsWith('.diff.json'))
    const markdownFile = firstFiles.find(file => file.endsWith('.md'))
    expect(jsonFile).toBeDefined()
    expect(markdownFile).toBeDefined()

    const jsonPath = path.join(output, jsonFile!)
    const run = JSON.parse(await fs.readFile(jsonPath, 'utf8')) as EvaluationRun
    const markdown = await fs.readFile(path.join(output, markdownFile!), 'utf8')
    expect(run.aggregate).toMatchObject({
      cases: 12,
      assertionsPassed: 31,
      assertionsTotal: 31,
      assertionAgreement: 1,
      exactEligibleCases: 0,
      exactCases: 0,
      falsePositives: 0,
      falseNegatives: 0,
    })
    expect(run.aggregate.exactAgreement).toBeUndefined()
    expect(markdown).toContain('Assertion agreement: 31/31 (100.0%)')
    expect(markdown).toContain('Full-Gold exact agreement: N/A (partial contract)')
    expect(messages.join('\n')).toContain('Assertion agreement: 31/31; FP/FN: 0/0')
    expect(messages.join('\n')).toContain('Casebook: 0 open / 0 total.')
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
      gateDecision: 'pass',
      improvedCaseIds: [],
      regressedCaseIds: [],
      mixedCaseIds: [],
      inconclusiveCaseIds: [],
    })
    expect(diff.unchangedCaseIds).toHaveLength(12)
    expect(messages.join('\n'))
      .toContain('Improved/regressed/mixed/unchanged/inconclusive: 0/0/0/12/0; gate=pass.')
  })
})
