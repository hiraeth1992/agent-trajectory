import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import packageMetadata from '../package.json'
import { startAgentTrajectoryServer, type AgentTrajectoryServer } from './app'
import { openBrowser } from './browser-open'
import { BrowserSession } from './browser-session'
import {
  installedAgentHooks,
  installAgentHooks,
  readHookInstallation,
  uninstallAgentHooks,
  type HookInstallLocations,
} from './hook-installation'
import {
  acquireRuntimeLock,
  readRuntimeState,
  removeRuntimeState,
  requestRuntime,
  writeRuntimeState,
} from './runtime-state'
import { SessionActivationHub, type HookPayload } from './session-activation'
import {
  defaultDataRoot,
  portablePath,
  readConfig,
  resolveSourcePaths,
  writeConfig,
  type ResolvedSourcePaths,
  type SourcePathOverrides,
} from './source-paths'
import { createSourceRegistry } from './sources/registry'
import { isSourceId, type SourceId, type SourceStatus } from '../src/types'
import { SYNTHETIC_CONTRACT_DATASET } from './evaluation/gold-dataset'
import {
  compareHumanAnnotations,
  createAdjudicationTemplate,
  loadAdjudicatedDataset,
  loadCandidateManifest,
  loadHumanAnnotations,
  prepareCalibrationCandidates,
} from './evaluation/calibration'
import {
  compareEvaluationRuns,
  evaluationRunMarkdown,
  runEvaluationDataset,
} from './evaluation/runner'
import { createEvaluationDataset } from './evaluation/identity'
import type {
  EvaluationDataset,
  EvaluationRun,
  EvaluationSplit,
} from '../src/evaluation-types'
import {
  writePrivateJson,
  writePrivateJsonExclusive,
  writePrivateText,
} from './file-transaction'
import {
  defaultCasebookFile,
  EvaluationCasebookStore,
} from './evaluation/casebook'
import type {
  BadcaseDecision,
} from '../src/evaluation-types'

type Command =
  | 'calibrate'
  | 'casebook'
  | 'doctor'
  | 'evaluate'
  | 'hook'
  | 'install-hooks'
  | 'open'
  | 'setup'
  | 'start'
  | 'uninstall-hooks'

interface CliArguments {
  adjudication?: string
  command: Command
  baseline?: string
  allowPartial: boolean
  calibrateAction?: 'agreement' | 'prepare'
  casebookAction?: 'list' | 'decide' | 'retest'
  casebookEntry?: string
  casebookDecision?: BadcaseDecision
  casebookNote?: string
  casebookRun?: string
  count: number
  dataRoot: string
  datasetDirectory?: string
  noOpen: boolean
  outputDirectory?: string
  port?: number
  reviewerA?: string
  reviewerB?: string
  split?: EvaluationSplit | 'all'
  source?: SourceId
  sessionId?: string
  sourcePaths: SourcePathOverrides
}

const distributionRoot = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(distributionRoot, '..')

function configureWorkerLocations(): void {
  process.env.AGENT_TRAJECTORY_PROJECTION_WORKER = path.join(
    distributionRoot,
    'lib',
    'projection-worker.mjs',
  )
  process.env.AGENT_TRAJECTORY_ZCODE_WORKER = path.join(
    distributionRoot,
    'lib',
    'zcode-worker.mjs',
  )
  process.env.AGENT_TRAJECTORY_WORKBUDDY_WORKER = path.join(
    distributionRoot,
    'lib',
    'workbuddy-worker.mjs',
  )
  process.env.AGENT_TRAJECTORY_OPENCODE_WORKER = path.join(
    distributionRoot,
    'lib',
    'opencode-worker.mjs',
  )
}

function value(arguments_: readonly string[], index: number, option: string): string {
  const selected = arguments_[index + 1]
  if (selected === undefined || selected.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return selected
}

function sourceId(value: string): SourceId | undefined {
  return isSourceId(value) ? value : undefined
}

export function parseCliArguments(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): CliArguments {
  const positionals: string[] = []
  const sourcePaths: SourcePathOverrides = {}
  let adjudication: string | undefined
  let allowPartial = false
  let baseline: string | undefined
  let count = 30
  let countProvided = false
  let dataRoot = path.resolve(
    environment.AGENT_TRAJECTORY_DATA_DIR ?? defaultDataRoot(homeDirectory),
  )
  let noOpen = false
  let outputDirectory: string | undefined
  let port: number | undefined
  let datasetDirectory: string | undefined
  let reviewerA: string | undefined
  let reviewerB: string | undefined
  let split: EvaluationSplit | 'all' | undefined
  let casebookEntry: string | undefined
  let casebookDecision: BadcaseDecision | undefined
  let casebookNote: string | undefined
  let casebookRun: string | undefined
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!
    if (!argument.startsWith('--')) {
      positionals.push(argument)
      continue
    }
    if (argument === '--no-open') {
      noOpen = true
      continue
    }
    if (argument === '--allow-partial') {
      allowPartial = true
      continue
    }
    const selected = value(arguments_, index, argument)
    index++
    if (argument === '--data-dir') dataRoot = path.resolve(selected)
    else if (argument === '--port') {
      port = Number(selected)
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error('--port must be an integer from 0 to 65535')
      }
    } else if (argument === '--dsh-dir') sourcePaths.dshSessionsDir = selected
    else if (argument === '--claude-projects-dir') sourcePaths.claudeProjectsDir = selected
    else if (argument === '--codex-home') sourcePaths.codexHome = selected
    else if (argument === '--codex-sessions-dir') sourcePaths.codexSessionsDir = selected
    else if (argument === '--doubao-work-sessions-dir') {
      sourcePaths.doubaoWorkSessionsDir = selected
    }
    else if (argument === '--workbuddy-home') sourcePaths.workbuddyHome = selected
    else if (argument === '--qoder-projects-dir') sourcePaths.qoderProjectsDir = selected
    else if (argument === '--opencode-db') sourcePaths.openCodeDatabase = selected
    else if (argument === '--zcode-db') sourcePaths.zcodeDatabase = selected
    else if (argument === '--baseline') baseline = path.resolve(selected)
    else if (argument === '--output-dir') outputDirectory = path.resolve(selected)
    else if (argument === '--dataset') datasetDirectory = path.resolve(selected)
    else if (argument === '--adjudication') adjudication = path.resolve(selected)
    else if (argument === '--reviewer-a') reviewerA = path.resolve(selected)
    else if (argument === '--reviewer-b') reviewerB = path.resolve(selected)
    else if (argument === '--entry') casebookEntry = selected
    else if (argument === '--decision') {
      if (selected !== 'accepted' && selected !== 'rejected' && selected !== 'deferred') {
        throw new Error('--decision must be accepted, rejected, or deferred')
      }
      casebookDecision = selected
    }
    else if (argument === '--note') casebookNote = selected
    else if (argument === '--run') casebookRun = path.resolve(selected)
    else if (argument === '--split') {
      if (selected !== 'all'
        && selected !== 'calibration'
        && selected !== 'regression'
        && selected !== 'independent') {
        throw new Error(
          '--split must be all, calibration, regression, or independent',
        )
      }
      split = selected
    }
    else if (argument === '--count') {
      countProvided = true
      count = Number(selected)
      if (!Number.isInteger(count) || count < 3 || count > 120) {
        throw new Error('--count must be an integer from 3 to 120')
      }
    }
    else throw new Error(`unknown option: ${argument}`)
  }
  const commandValue = positionals[0] ?? 'start'
  if (![
    'calibrate',
    'casebook',
    'doctor',
    'evaluate',
    'hook',
    'install-hooks',
    'open',
    'setup',
    'start',
    'uninstall-hooks',
  ].includes(commandValue)) {
    throw new Error(`unknown command: ${commandValue}`)
  }
  const command = commandValue as Command
  const calibrateAction = command === 'calibrate'
    && (positionals[1] === 'prepare' || positionals[1] === 'agreement')
    ? positionals[1]
    : undefined
  const casebookAction = command === 'casebook'
    && (positionals[1] === 'list'
      || positionals[1] === 'decide'
      || positionals[1] === 'retest')
    ? positionals[1]
    : undefined
  if (command === 'calibrate' && calibrateAction === undefined) {
    throw new Error('calibrate requires prepare or agreement')
  }
  if (command === 'casebook' && casebookAction === undefined) {
    throw new Error('casebook requires list, decide, or retest')
  }
  if (command !== 'casebook'
    && (casebookEntry !== undefined
      || casebookDecision !== undefined
      || casebookNote !== undefined
      || casebookRun !== undefined)) {
    throw new Error('--entry, --decision, --note, and --run are only valid with casebook')
  }
  if (casebookAction === 'decide'
    && (casebookEntry === undefined || casebookDecision === undefined)) {
    throw new Error('casebook decide requires --entry and --decision')
  }
  if (casebookAction === 'retest'
    && (casebookEntry === undefined || casebookRun === undefined)) {
    throw new Error('casebook retest requires --entry and --run')
  }
  if (casebookAction === 'list'
    && (casebookEntry !== undefined
      || casebookDecision !== undefined
      || casebookNote !== undefined
      || casebookRun !== undefined)) {
    throw new Error('casebook list does not accept entry options')
  }
  if (command !== 'evaluate' && (baseline !== undefined || adjudication !== undefined)) {
    throw new Error('--baseline and --adjudication are only valid with evaluate')
  }
  if (command !== 'evaluate' && split !== undefined) {
    throw new Error('--split is only valid with evaluate')
  }
  if (command !== 'evaluate' && command !== 'calibrate' && datasetDirectory !== undefined) {
    throw new Error('--dataset is only valid with evaluate or calibrate')
  }
  if (command !== 'evaluate' && outputDirectory !== undefined) {
    throw new Error('--output-dir is only valid with evaluate')
  }
  if (command !== 'calibrate' && (reviewerA !== undefined || reviewerB !== undefined)) {
    throw new Error('--reviewer-a and --reviewer-b are only valid with calibrate')
  }
  if (command !== 'calibrate' && countProvided) {
    throw new Error('--count is only valid with calibrate prepare')
  }
  if (calibrateAction === 'agreement' && countProvided) {
    throw new Error('--count is only valid with calibrate prepare')
  }
  if (calibrateAction !== 'prepare' && allowPartial) {
    throw new Error('--allow-partial is only valid with calibrate prepare')
  }
  if (calibrateAction === 'prepare' && (reviewerA !== undefined || reviewerB !== undefined)) {
    throw new Error('reviewer files are only valid with calibrate agreement')
  }
  if (calibrateAction === 'agreement'
    && (reviewerA === undefined || reviewerB === undefined)) {
    throw new Error('calibrate agreement requires --reviewer-a and --reviewer-b')
  }
  if (command === 'evaluate'
    && (datasetDirectory === undefined) !== (adjudication === undefined)) {
    throw new Error('--dataset and --adjudication must be supplied together')
  }
  if (command === 'evaluate' && datasetDirectory !== undefined && split === undefined) {
    throw new Error('external datasets require an explicit --split')
  }
  if (command === 'calibrate' && datasetDirectory === undefined) {
    throw new Error('calibrate requires --dataset')
  }
  const selectedSource = command === 'hook' || command === 'open'
    ? sourceId(positionals[1] ?? '')
    : undefined
  if ((command === 'hook' || command === 'open') && selectedSource === undefined) {
    throw new Error(`${command} requires a source: codex, dsh, or zcode`)
  }
  const sessionId = positionals[2]
  if (command === 'open' && sessionId === undefined) {
    throw new Error('open requires a session id')
  }
  return {
    adjudication,
    allowPartial,
    command,
    baseline,
    calibrateAction,
    casebookAction,
    casebookEntry,
    casebookDecision,
    casebookNote,
    casebookRun,
    count,
    dataRoot,
    datasetDirectory,
    noOpen,
    outputDirectory,
    port,
    reviewerA,
    reviewerB,
    split,
    source: selectedSource,
    sessionId,
    sourcePaths,
  }
}

async function resolvedPaths(arguments_: CliArguments): Promise<ResolvedSourcePaths> {
  const config = await readConfig(arguments_.dataRoot)
  return resolveSourcePaths({
    cli: arguments_.sourcePaths,
    config: config.sources,
    configDirectory: arguments_.dataRoot,
  })
}

function sessionPath(source: SourceId, sessionId: string): string {
  const search = new URLSearchParams({
    source,
    session: sessionId,
  })
  return `/?${search}`
}

async function runningState(dataRoot: string) {
  const state = await readRuntimeState(dataRoot)
  if (state === undefined) return undefined
  try {
    const response = await requestRuntime(
      state,
      '/api/integrations/ping',
    )
    return response.ok ? state : undefined
  } catch {
    return undefined
  }
}

async function waitForRuntime(dataRoot: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const state = await runningState(dataRoot)
    if (state !== undefined) return state
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return undefined
}

function spawnRuntime(dataRoot: string): void {
  const child = spawn(process.execPath, [
    process.argv[1]!,
    'start',
    '--no-open',
    '--data-dir',
    dataRoot,
  ], {
    detached: true,
    stdio: 'ignore',
  })
  child.once('error', () => {})
  child.unref()
}

async function hookPayload(): Promise<HookPayload> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of input) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 64 * 1024) throw new Error('hook payload too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('hook payload must be an object')
  }
  return parsed as HookPayload
}

async function forwardHook(
  arguments_: CliArguments,
  payload: HookPayload,
): Promise<void> {
  let state = await runningState(arguments_.dataRoot)
  if (state === undefined) {
    spawnRuntime(arguments_.dataRoot)
    state = await waitForRuntime(arguments_.dataRoot)
  }
  if (state === undefined) throw new Error('Agent Trajectory did not start')
  const response = await requestRuntime(
    state,
    '/api/integrations/session-start',
    payload,
    arguments_.source,
  )
  if (!response.ok) throw new Error(`session activation failed (${response.status})`)
}

async function start(arguments_: CliArguments): Promise<void> {
  const existing = await runningState(arguments_.dataRoot)
  if (existing !== undefined) {
    if (!arguments_.noOpen) {
      await requestRuntime(existing, '/api/integrations/show')
    }
    console.log(`Agent Trajectory is already running: ${existing.url}`)
    return
  }
  const lock = await acquireRuntimeLock(arguments_.dataRoot)
  if (lock === undefined) {
    const started = await waitForRuntime(arguments_.dataRoot)
    if (started === undefined) {
      throw new Error('Agent Trajectory is already starting but did not become ready')
    }
    if (!arguments_.noOpen) {
      await requestRuntime(started, '/api/integrations/show')
    }
    console.log(`Agent Trajectory is already running: ${started.url}`)
    return
  }
  try {
    const rechecked = await runningState(arguments_.dataRoot)
    if (rechecked !== undefined) {
      if (!arguments_.noOpen) {
        await requestRuntime(rechecked, '/api/integrations/show')
      }
      console.log(`Agent Trajectory is already running: ${rechecked.url}`)
      return
    }
    const paths = await resolvedPaths(arguments_)
    const hookToken = randomBytes(32).toString('base64url')
    const browserSession = new BrowserSession()
    const activations = new SessionActivationHub(hookToken)
    configureWorkerLocations()
    let server: AgentTrajectoryServer | undefined
    const show = (source?: SourceId, sessionId?: string) => {
      if (server === undefined) return
      openBrowser(browserSession.createLaunchUrl(
        server.url,
        source === undefined || sessionId === undefined
          ? '/'
          : sessionPath(source, sessionId),
      ))
    }
    activations.setShowHandler(activation =>
      show(activation?.source, activation?.sessionId))
    server = await startAgentTrajectoryServer({
      root,
      staticRoot: path.join(distributionRoot, 'dist'),
      host: '127.0.0.1',
      port: arguments_.port ?? 0,
      development: false,
      dataRoot: arguments_.dataRoot,
      sourcePaths: paths,
      browserSession,
      diagnosisEvidenceCommand: JSON.stringify(path.join(
        distributionRoot,
        'lib',
        'diagnosis-evidence.mjs',
      )),
      diagnosisSkillPath: path.join(
        distributionRoot,
        'skills',
        'trajectory-diagnosis',
        'SKILL.md',
      ),
      sessionActivationHub: activations,
    })
    await writeRuntimeState(arguments_.dataRoot, {
      pid: process.pid,
      url: server.url,
      hookToken,
      startedAt: new Date().toISOString(),
    })
    console.log(`Agent Trajectory: ${server.url}`)
    if (!arguments_.noOpen) show()

    await new Promise<void>((resolve, reject) => {
      let closing = false
      const close = () => {
        if (closing) return
        closing = true
        void server!.close()
          .then(() => removeRuntimeState(arguments_.dataRoot, process.pid))
          .then(resolve, reject)
      }
      process.once('SIGINT', close)
      process.once('SIGTERM', close)
    })
  } finally {
    await lock.release()
  }
}

function statusLine(status: SourceStatus, sourcePath: string): string {
  const state = status.availability.padEnd(9)
  const sessions = `${status.sessionCount} sessions`.padEnd(13)
  return `${status.source.padEnd(6)} ${state} ${sessions} ${sourcePath}${
    status.detail === undefined ? '' : `\n       ${status.detail}`}`
}

function hookLocations(paths: ResolvedSourcePaths): HookInstallLocations {
  return {
    codexHome: paths.codexHome,
    dshHome: path.resolve(process.env.DSH_HOME ?? path.join(homedir(), '.dsh')),
    zcodeHome: path.resolve(process.env.ZCODE_HOME ?? path.join(homedir(), '.zcode')),
  }
}

async function doctor(arguments_: CliArguments): Promise<void> {
  configureWorkerLocations()
  const paths = await resolvedPaths(arguments_)
  const registry = createSourceRegistry(paths)
  try {
    const statuses = await registry.listSources(true)
    const bySource: Record<SourceId, string> = {
      codex: paths.codexSessionsDir,
      dsh: paths.dshSessionsDir,
      zcode: paths.zcodeDatabase,
      claude: paths.claudeProjectsDir,
      'doubao-work': paths.doubaoWorkSessionsDir,
      workbuddy: paths.workbuddyHome,
      qoder: paths.qoderProjectsDir,
      opencode: paths.openCodeDatabase,
    }
    for (const status of statuses) {
      console.log(statusLine(status, bySource[status.source]))
    }
  } finally {
    await registry.close()
  }
  const hookIssues: string[] = []
  try {
    const [installation, installedHooks] = await Promise.all([
      readHookInstallation(arguments_.dataRoot),
      installedAgentHooks(hookLocations(paths)),
    ])
    if (installation === undefined && installedHooks.length > 0) {
      hookIssues.push('Hook installation record is missing')
      hookIssues.push(`Detected installed Hooks: ${installedHooks.join(', ')}`)
    } else if (installation !== undefined) {
      const missingHooks = (['codex', 'zcode', 'dsh'] as const)
        .filter(source => !installedHooks.includes(source))
      if (missingHooks.length > 0) {
        hookIssues.push(`Installed Hook entries are missing: ${missingHooks.join(', ')}`)
      }
      const expectedRuntime = path.join(
        arguments_.dataRoot,
        'runtime',
        'agent-trajectory.mjs',
      )
      if (installation.platform !== process.platform) {
        hookIssues.push(
          `Platform changed: installed ${installation.platform}, current ${process.platform}`,
        )
      }
      if (path.resolve(installation.nodeExecutable) !== path.resolve(process.execPath)) {
        hookIssues.push(
          `Node executable changed: installed ${installation.nodeExecutable}, current ${process.execPath}`,
        )
      }
      if (path.resolve(installation.runtimeFile) !== path.resolve(expectedRuntime)) {
        hookIssues.push(
          `Hook runtime location changed: installed ${installation.runtimeFile}, current ${expectedRuntime}`,
        )
      }
      if (path.resolve(installation.dataRoot) !== path.resolve(arguments_.dataRoot)) {
        hookIssues.push(
          `Data directory changed: installed ${installation.dataRoot}, current ${arguments_.dataRoot}`,
        )
      }
      if (installation.packageVersion !== packageMetadata.version) {
        hookIssues.push(
          `Package version changed: installed ${installation.packageVersion}, current ${packageMetadata.version}`,
        )
      }
      try {
        await fs.access(installation.nodeExecutable)
      } catch {
        hookIssues.push(`Node executable is missing: ${installation.nodeExecutable}`)
      }
      try {
        await fs.access(installation.runtimeFile)
      } catch {
        hookIssues.push(`Hook runtime is missing: ${installation.runtimeFile}`)
      }
    }
  } catch (error) {
    hookIssues.push(
      `Hook installation record is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (hookIssues.length > 0) {
    const quotedDataRoot = process.platform === 'win32'
      ? `"${arguments_.dataRoot.replaceAll('"', '""').replaceAll('%', '%%')}"`
      : `'${arguments_.dataRoot.replaceAll("'", "'\"'\"'")}'`
    console.log([
      'hooks  stale',
      ...hookIssues.map(issue => `       ${issue}`),
      `       Repair: agent-trajectory install-hooks --data-dir ${quotedDataRoot}`,
    ].join('\n'))
  }
}

async function calibrate(arguments_: CliArguments): Promise<void> {
  const datasetDirectory = arguments_.datasetDirectory!
  if (arguments_.calibrateAction === 'prepare') {
    configureWorkerLocations()
    const paths = await resolvedPaths(arguments_)
    const registry = createSourceRegistry(paths)
    try {
      const prepared = await prepareCalibrationCandidates(
        registry,
        datasetDirectory,
        {
          count: arguments_.count,
          allowPartial: arguments_.allowPartial,
        },
      )
      console.log(`Calibration manifest: ${prepared.manifestFile}`)
      console.log(`Annotation guide: ${prepared.annotationGuideFile}`)
      console.log(`Reviewer A template: ${prepared.reviewerATemplate}`)
      console.log(`Reviewer B template: ${prepared.reviewerBTemplate}`)
      console.log(
        `Prepared ${prepared.manifest.cases.length} private cases; `
        + `skipped ${prepared.skipped.length}.`,
      )
    } finally {
      await registry.close()
    }
    return
  }
  const manifest = await loadCandidateManifest(datasetDirectory)
  const [reviewerA, reviewerB] = await Promise.all([
    loadHumanAnnotations(arguments_.reviewerA!, manifest, { complete: true }),
    loadHumanAnnotations(arguments_.reviewerB!, manifest, { complete: true }),
  ])
  const report = compareHumanAnnotations(manifest, reviewerA, reviewerB)
  const agreementFile = path.join(datasetDirectory, 'agreement.json')
  const adjudicationFile = path.join(datasetDirectory, 'adjudication.json')
  await writePrivateJsonExclusive(agreementFile, report)
  await writePrivateJsonExclusive(
    adjudicationFile,
    createAdjudicationTemplate(manifest, 'adjudicator'),
  )
  console.log(`Agreement report: ${agreementFile}`)
  console.log(`Adjudication template: ${adjudicationFile}`)
  console.log(
    `Criterion agreement/Kappa: ${
      report.criterionExactAgreement === undefined
        ? 'N/A'
        : `${(report.criterionExactAgreement * 100).toFixed(1)}%`
    }/${
      report.criterionKappa === undefined
        ? 'N/A'
        : report.criterionKappa.toFixed(3)
    }; disagreements: ${report.disagreements.length}.`,
  )
}

async function evaluate(arguments_: CliArguments): Promise<void> {
  const baseline = arguments_.baseline === undefined
    ? undefined
    : JSON.parse(await fs.readFile(arguments_.baseline, 'utf8')) as EvaluationRun
  const loadedDataset: EvaluationDataset = arguments_.datasetDirectory === undefined
    ? SYNTHETIC_CONTRACT_DATASET
    : await loadAdjudicatedDataset(
        arguments_.datasetDirectory,
        arguments_.adjudication!,
      )
  const selectedSplit = arguments_.split ?? 'all'
  const dataset: EvaluationDataset = selectedSplit === 'all'
    ? loadedDataset
    : createEvaluationDataset({
        schemaVersion: loadedDataset.schemaVersion,
        id: loadedDataset.id,
        version: loadedDataset.version,
        description: loadedDataset.description,
        goldCompleteness: loadedDataset.goldCompleteness,
        candidateManifestHash: loadedDataset.candidateManifestHash,
        cases: loadedDataset.cases.filter(testCase =>
          testCase.split === selectedSplit),
      })
  if (dataset.cases.length === 0) {
    throw new Error(`dataset has no ${selectedSplit} cases`)
  }
  const run = runEvaluationDataset(dataset)
  const outputDirectory = arguments_.outputDirectory
    ?? path.join(arguments_.dataRoot, 'evaluations')
  const baseName = [
    dataset.id,
    dataset.version,
    selectedSplit,
    run.runId,
  ].join('-')
  const jsonFile = path.join(outputDirectory, `${baseName}.json`)
  const markdownFile = path.join(outputDirectory, `${baseName}.md`)
  await Promise.all([
    writePrivateJson(jsonFile, run),
    writePrivateText(markdownFile, evaluationRunMarkdown(run)),
  ])
  const casebook = await new EvaluationCasebookStore(
    defaultCasebookFile(arguments_.dataRoot),
  ).syncRun(run)
  console.log(`Evaluation JSON: ${jsonFile}`)
  console.log(`Evaluation report: ${markdownFile}`)
  console.log(
    `Casebook: ${casebook.entries.filter(entry => entry.status === 'open').length} open / ${
      casebook.entries.length
    } total.`,
  )
  console.log(
    `Assertion agreement: ${run.aggregate.assertionsPassed}/${
      run.aggregate.assertionsTotal
    }; `
    + `FP/FN: ${run.aggregate.falsePositives}/${run.aggregate.falseNegatives}`,
  )
  if (run.aggregate.exactAgreement !== undefined) {
    console.log(
      `Full-Gold exact agreement: ${run.aggregate.exactCases}/${
        run.aggregate.exactEligibleCases
      }.`,
    )
  }
  if (baseline !== undefined) {
    const diff = compareEvaluationRuns(baseline, run)
    const diffFile = path.join(outputDirectory, `${baseName}.diff.json`)
    await writePrivateJson(diffFile, diff)
    console.log(`Evaluation diff: ${diffFile}`)
    if (!diff.comparable) {
      throw new Error(`baseline is not comparable: ${diff.reasons.join('; ')}`)
    }
    console.log(
      `Improved/regressed/mixed/unchanged/inconclusive: ${diff.improvedCaseIds.length}/${
        diff.regressedCaseIds.length
      }/${diff.mixedCaseIds.length}/${diff.unchangedCaseIds.length}/${
        diff.inconclusiveCaseIds.length
      }; gate=${diff.gateDecision}.`,
    )
  }
}

async function casebook(arguments_: CliArguments): Promise<void> {
  const store = new EvaluationCasebookStore(defaultCasebookFile(arguments_.dataRoot))
  if (arguments_.casebookAction === 'decide') {
    const result = await store.decide(
      arguments_.casebookEntry!,
      arguments_.casebookDecision!,
      arguments_.casebookNote,
    )
    const entry = result.entries.find(candidate =>
      candidate.id === arguments_.casebookEntry)!
    console.log(`${entry.id} decision=${entry.decision?.value} status=${entry.status}`)
    return
  }
  if (arguments_.casebookAction === 'retest') {
    const run = JSON.parse(
      await fs.readFile(arguments_.casebookRun!, 'utf8'),
    ) as EvaluationRun
    const result = await store.recordRetest(arguments_.casebookEntry!, run)
    const entry = result.entries.find(candidate =>
      candidate.id === arguments_.casebookEntry)!
    const retest = entry.retests.find(candidate => candidate.runId === run.runId)!
    console.log(`${entry.id} retest=${retest.outcome} run=${run.runId}`)
    return
  }
  const result = await store.read()
  if (result.entries.length === 0) {
    console.log('Casebook is empty.')
    return
  }
  for (const entry of result.entries) {
    console.log([
      entry.id,
      entry.status,
      entry.decision?.value ?? 'undecided',
      `${entry.datasetId}@${entry.datasetVersion}`,
      entry.caseId,
      entry.subject,
      `seen=${entry.observations}`,
    ].join(' '))
  }
}

async function setup(arguments_: CliArguments): Promise<void> {
  const current = await readConfig(arguments_.dataRoot)
  let next: SourcePathOverrides = {
    ...current.sources,
    ...arguments_.sourcePaths,
  }
  if (input.isTTY && Object.keys(arguments_.sourcePaths).length === 0) {
    const defaults = resolveSourcePaths({
      config: current.sources,
      configDirectory: arguments_.dataRoot,
    })
    const prompt = createInterface({ input, output })
    try {
      const ask = async (label: string, fallback: string): Promise<string> =>
        (await prompt.question(`${label} [${fallback}]: `)).trim() || fallback
      next = {
        claudeProjectsDir: portablePath(
          await ask('Claude Code projects', defaults.claudeProjectsDir),
        ),
        dshSessionsDir: portablePath(await ask('DSH sessions', defaults.dshSessionsDir)),
        codexHome: portablePath(await ask('Codex home', defaults.codexHome)),
        codexSessionsDir: portablePath(
          await ask('Codex sessions', defaults.codexSessionsDir),
        ),
        doubaoWorkSessionsDir: portablePath(
          await ask('Doubao Work sessions', defaults.doubaoWorkSessionsDir),
        ),
        workbuddyHome: portablePath(
          await ask('WorkBuddy home', defaults.workbuddyHome),
        ),
        qoderProjectsDir: portablePath(
          await ask('Qoder projects', defaults.qoderProjectsDir),
        ),
        openCodeDatabase: portablePath(
          await ask('OpenCode database', defaults.openCodeDatabase),
        ),
        zcodeDatabase: portablePath(await ask('ZCode database', defaults.zcodeDatabase)),
      }
    } finally {
      prompt.close()
    }
  }
  const file = await writeConfig(arguments_.dataRoot, next)
  console.log(`Saved source configuration: ${file}`)
  await doctor({ ...arguments_, sourcePaths: {} })
}

async function updateHooks(
  arguments_: CliArguments,
  remove: boolean,
): Promise<void> {
  const paths = await resolvedPaths(arguments_)
  const runtimeRoot = path.join(arguments_.dataRoot, 'runtime')
  const sourceRuntime = path.resolve(process.argv[1]!) === path.resolve(
    path.join(runtimeRoot, 'agent-trajectory.mjs'),
  )
    ? runtimeRoot
    : distributionRoot
  if (!remove && sourceRuntime !== runtimeRoot) {
    const temporary = `${runtimeRoot}.${process.pid}.tmp`
    await fs.rm(temporary, { recursive: true, force: true })
    await fs.cp(sourceRuntime, temporary, { recursive: true })
    await fs.rm(runtimeRoot, { recursive: true, force: true })
    await fs.rename(temporary, runtimeRoot)
  }
  const locations = hookLocations(paths)
  const results = remove
    ? await uninstallAgentHooks(locations, arguments_.dataRoot)
    : await installAgentHooks(
        locations,
        process.execPath,
        path.join(runtimeRoot, 'agent-trajectory.mjs'),
        arguments_.dataRoot,
        process.platform,
        { packageVersion: packageMetadata.version },
      )
  for (const result of results) {
    console.log(`${result.source.padEnd(6)} ${result.action.padEnd(9)} ${result.file}`)
  }
  if (!remove) {
    console.log('Restart DSH and ZCode, and review/trust the new Codex hook with /hooks.')
  } else {
    await fs.rm(runtimeRoot, { recursive: true, force: true })
  }
}

export async function runCli(arguments_ = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArguments(arguments_)
  if (parsed.command === 'start') await start(parsed)
  else if (parsed.command === 'doctor') await doctor(parsed)
  else if (parsed.command === 'calibrate') await calibrate(parsed)
  else if (parsed.command === 'casebook') await casebook(parsed)
  else if (parsed.command === 'evaluate') await evaluate(parsed)
  else if (parsed.command === 'setup') await setup(parsed)
  else if (parsed.command === 'install-hooks') await updateHooks(parsed, false)
  else if (parsed.command === 'uninstall-hooks') await updateHooks(parsed, true)
  else if (parsed.command === 'open') {
    await forwardHook(parsed, {
      hook_event_name: 'SessionStart',
      session_id: parsed.sessionId,
      session_start_source: 'startup',
    })
  } else {
    await forwardHook(parsed, await hookPayload())
  }
}
