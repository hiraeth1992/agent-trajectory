import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  RecordKind,
  SourceId,
  TrajectoryProjection,
} from '../src/types'
import { codexSource } from '../server/sources/codex'
import { dshSource } from '../server/sources/dsh'
import type { SessionSource } from '../server/sources/types'
import { zcodeSource } from '../server/sources/zcode'

const RECORD_KINDS: readonly RecordKind[] = [
  'system',
  'user',
  'steering',
  'context',
  'assistant',
  'model',
  'tool',
  'subtool',
  'compaction',
]

export interface VerificationInput {
  source: SourceId
  sourceSessionId: string
  digestInput: string
  projection: TrajectoryProjection
}

export type SelectionMode = 'latest' | 'explicit'

export interface VerificationArguments {
  selectionMode: SelectionMode
  sessions: Partial<Record<SourceId, string>>
  output?: string
}

export interface SourceVerification {
  sourceSessionSha256: string
  sha256: string
  events: number
  records: number
  kinds: Partial<Record<RecordKind, number>>
  turns: number
  completedTurns: number
  tools: number
  nestedTools: number
  usagePresent: boolean
  unknownEventTypes: number
}

export interface RealSourceVerification {
  generatedAt: string
  contentPolicy: 'counts-and-sha256-only'
  selectionMode: SelectionMode
  dsh: SourceVerification
  codex: SourceVerification
  zcode: SourceVerification
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function summarize({
  sourceSessionId,
  digestInput,
  projection,
}: VerificationInput): SourceVerification {
  const kinds = Object.fromEntries(RECORD_KINDS.flatMap((kind) => {
    const count = projection.records.filter(record => record.kind === kind).length
    return count === 0 ? [] : [[kind, count]]
  })) as Partial<Record<RecordKind, number>>
  return {
    sourceSessionSha256: sha256(sourceSessionId),
    sha256: sha256(digestInput),
    events: projection.eventCount,
    records: projection.records.length,
    kinds,
    turns: projection.turns.length,
    completedTurns: projection.turns.filter(turn => turn.status === 'complete').length,
    tools: (kinds.tool ?? 0) + (kinds.subtool ?? 0),
    nestedTools: kinds.subtool ?? 0,
    usagePresent: projection.usage !== undefined,
    unknownEventTypes: projection.unknownEventTypes.length,
  }
}

function assertTurnEvidence({ source, projection }: VerificationInput): void {
  const hasEvidence = source === 'dsh'
    ? (projection.eventTypeCounts['turn/start'] ?? 0) > 0
      || (projection.eventTypeCounts['turn/end'] ?? 0) > 0
    : source === 'zcode'
      ? Object.entries(projection.eventTypeCounts).some(
          ([type, count]) => type.startsWith('turn_usage/') && count > 0,
        )
      : false
  if (hasEvidence && projection.turns.length === 0) {
    throw new Error(`${source} projection has turn evidence but no turns`)
  }
}

export function buildVerification(
  inputs: readonly VerificationInput[],
  generatedAt = new Date(),
  selectionMode: SelectionMode = 'latest',
): RealSourceVerification {
  inputs.forEach(assertTurnEvidence)
  const bySource = new Map(inputs.map(input => [input.source, summarize(input)]))
  const required = (source: SourceId): SourceVerification => {
    const value = bySource.get(source)
    if (value === undefined) throw new Error(`missing verification input for ${source}`)
    return value
  }
  return {
    generatedAt: generatedAt.toISOString(),
    contentPolicy: 'counts-and-sha256-only',
    selectionMode,
    dsh: required('dsh'),
    codex: required('codex'),
    zcode: required('zcode'),
  }
}

async function readSelected(
  source: SessionSource,
  sourceSessionId?: string,
): Promise<VerificationInput> {
  const refs = await source.list()
  const ref = sourceSessionId === undefined
    ? refs[0]
    : refs.find(candidate => candidate.sourceSessionId === sourceSessionId)
  if (ref === undefined) {
    throw new Error(sourceSessionId === undefined
      ? `no ${source.id} sessions available`
      : `requested ${source.id} session was not found`)
  }
  const detail = await source.load(ref)
  return {
    source: source.id,
    sourceSessionId: ref.sourceSessionId,
    digestInput: JSON.stringify(detail),
    projection: detail.projection,
  }
}

const SESSION_ARGUMENTS: Readonly<Record<string, SourceId>> = {
  '--dsh-session': 'dsh',
  '--codex-session': 'codex',
  '--zcode-session': 'zcode',
}

export function parseVerificationArguments(
  arguments_: readonly string[],
): VerificationArguments {
  const sessions: Partial<Record<SourceId, string>> = {}
  let output: string | undefined
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!
    const source = SESSION_ARGUMENTS[argument]
    if (source === undefined && argument !== '--output') {
      throw new Error(`unknown argument: ${argument}`)
    }
    const value = arguments_[++index]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`)
    }
    if (source !== undefined) {
      if (sessions[source] !== undefined) {
        throw new Error(`${argument} may only be specified once`)
      }
      sessions[source] = value
    } else {
      if (output !== undefined) throw new Error('--output may only be specified once')
      output = path.resolve(value)
    }
  }
  const selectedCount = Object.keys(sessions).length
  if (selectedCount !== 0 && selectedCount !== 3) {
    throw new Error('all three source session ids are required for explicit selection')
  }
  return {
    selectionMode: selectedCount === 3 ? 'explicit' : 'latest',
    sessions,
    ...(output === undefined ? {} : { output }),
  }
}

export async function verifyRealSources(
  arguments_: VerificationArguments = {
    selectionMode: 'latest',
    sessions: {},
  },
  generatedAt = new Date(),
): Promise<RealSourceVerification> {
  try {
    const inputs = await Promise.all([
      readSelected(dshSource, arguments_.sessions.dsh),
      readSelected(codexSource, arguments_.sessions.codex),
      readSelected(zcodeSource, arguments_.sessions.zcode),
    ])
    return buildVerification(inputs, generatedAt, arguments_.selectionMode)
  } finally {
    await zcodeSource.close()
  }
}

export async function writeVerification(
  output: string,
  serialized: string,
): Promise<void> {
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, serialized, { encoding: 'utf8', mode: 0o600 })
  await fs.chmod(output, 0o600)
}

async function main(): Promise<void> {
  const arguments_ = parseVerificationArguments(process.argv.slice(2))
  const result = await verifyRealSources(arguments_)
  const serialized = `${JSON.stringify(result, null, 2)}\n`
  if (arguments_.output === undefined) {
    process.stdout.write(serialized)
    return
  }
  await writeVerification(arguments_.output, serialized)
}

const executedFile = process.argv[1] === undefined
  ? undefined
  : path.resolve(process.argv[1])

if (executedFile === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`real-source verification failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`)
    process.exitCode = 1
  })
}
