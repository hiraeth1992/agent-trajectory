import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { queryDiagnosisEvidence, type DiagnosisEvidenceView } from './evidence-query'

interface Arguments {
  root?: string
  snapshotId?: string
  view?: DiagnosisEvidenceView
  recordId?: string
  turn?: number
  kind?: string
  status?: string
  query?: string
  offset?: number
  limit?: number
  maxBytes?: number
}

function value(arguments_: readonly string[], index: number, option: string): string {
  const selected = arguments_[index + 1]
  if (selected === undefined || selected.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return selected
}

function integer(selected: string, option: string): number {
  const parsed = Number(selected)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${option} requires a non-negative integer`)
  }
  return parsed
}

export function parseDiagnosisEvidenceArguments(arguments_: readonly string[]): Arguments {
  const result: Arguments = {}
  const positionals: string[] = []
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!
    if (!argument.startsWith('--')) {
      positionals.push(argument)
      continue
    }
    const selected = value(arguments_, index, argument)
    index++
    if (argument === '--root') result.root = selected
    else if (argument === '--record-id') result.recordId = selected
    else if (argument === '--turn') result.turn = integer(selected, argument)
    else if (argument === '--kind') result.kind = selected
    else if (argument === '--status') result.status = selected
    else if (argument === '--query') result.query = selected
    else if (argument === '--offset') result.offset = integer(selected, argument)
    else if (argument === '--limit') result.limit = integer(selected, argument)
    else if (argument === '--max-bytes') result.maxBytes = integer(selected, argument)
    else throw new Error(`unknown option: ${argument}`)
  }
  const view = positionals[0]
  if (view === 'overview' || view === 'records' || view === 'record' || view === 'findings') {
    result.view = view
  } else {
    throw new Error('view must be overview, records, record, or findings')
  }
  result.snapshotId = positionals[1]
  return result
}

async function main(): Promise<void> {
  const arguments_ = parseDiagnosisEvidenceArguments(process.argv.slice(2))
  if (arguments_.root === undefined || arguments_.snapshotId === undefined
    || arguments_.view === undefined) {
    throw new Error('usage: diagnosis-evidence --root DIR VIEW SNAPSHOT_ID [options]')
  }
  const result = await queryDiagnosisEvidence({
    root: arguments_.root,
    snapshotId: arguments_.snapshotId,
    view: arguments_.view,
    recordId: arguments_.recordId,
    turn: arguments_.turn,
    kind: arguments_.kind,
    status: arguments_.status,
    query: arguments_.query,
    offset: arguments_.offset,
    limit: arguments_.limit,
    maxBytes: arguments_.maxBytes,
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
