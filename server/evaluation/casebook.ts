import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  BadcaseCasebook,
  BadcaseDecision,
  BadcaseEntry,
  BadcaseRetestOutcome,
  EvaluationRun,
} from '../../src/evaluation-types'
import { runFileTransaction, writePrivateJson } from '../file-transaction'

const ENTRY_ID = /^[a-f0-9]{24}$/
const MAX_NOTE_LENGTH = 2_000

function entryId(run: EvaluationRun, caseId: string, subject: string): string {
  return createHash('sha256').update(JSON.stringify({
    datasetHash: run.datasetHash,
    goldHash: run.goldHash,
    caseId,
    subject,
  })).digest('hex').slice(0, 24)
}

function emptyCasebook(updatedAt: string): BadcaseCasebook {
  return {
    schemaVersion: 1,
    kind: 'evaluation-badcase-casebook',
    updatedAt,
    entries: [],
  }
}

function parseCasebook(value: unknown): BadcaseCasebook {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid evaluation casebook')
  }
  const source = value as Partial<BadcaseCasebook>
  if (source.schemaVersion !== 1
    || source.kind !== 'evaluation-badcase-casebook'
    || typeof source.updatedAt !== 'string'
    || !Array.isArray(source.entries)) {
    throw new Error('unsupported evaluation casebook')
  }
  for (const entry of source.entries) {
    if (!ENTRY_ID.test(entry.id)
      || typeof entry.datasetHash !== 'string'
      || typeof entry.goldHash !== 'string'
      || typeof entry.caseId !== 'string'
      || typeof entry.subject !== 'string'
      || !Array.isArray(entry.retests)) {
      throw new Error('invalid evaluation casebook entry')
    }
  }
  return source as BadcaseCasebook
}

function observedSubjects(run: EvaluationRun): Map<string, {
  assertedSubjects: Set<string>
  evaluatorError: boolean
  subjects: Set<string>
}> {
  return new Map(run.cases.map(testCase => [
    testCase.caseId,
    {
      assertedSubjects: new Set(testCase.assertions.map(assertion => assertion.subject)),
      evaluatorError: testCase.error !== undefined,
      subjects: new Set([
        ...testCase.mismatches.map(mismatch => mismatch.criterionId),
        ...(testCase.error === undefined ? [] : ['evaluation-run']),
      ]),
    },
  ]))
}

function retestOutcome(
  entry: BadcaseEntry,
  run: EvaluationRun,
): BadcaseRetestOutcome {
  if (entry.datasetHash !== run.datasetHash || entry.goldHash !== run.goldHash) {
    return 'inconclusive'
  }
  const selected = run.cases.find(testCase => testCase.caseId === entry.caseId)
  if (selected === undefined || selected.error !== undefined) return 'inconclusive'
  const assertion = selected.assertions.find(candidate =>
    candidate.subject === entry.subject && candidate.required)
  if (assertion === undefined) return 'inconclusive'
  return assertion.passed ? 'fixed' : 'not-fixed'
}

export class EvaluationCasebookStore {
  constructor(private readonly file: string) {}

  async read(): Promise<BadcaseCasebook> {
    return runFileTransaction(this.file, async () => this.readUnlocked())
  }

  private async readUnlocked(): Promise<BadcaseCasebook> {
    try {
      return parseCasebook(JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyCasebook(new Date(0).toISOString())
      }
      throw error
    }
  }

  async syncRun(run: EvaluationRun): Promise<BadcaseCasebook> {
    return runFileTransaction(this.file, async () => {
      const current = await this.readUnlocked()
      const observed = observedSubjects(run)
      const now = run.createdAt
      const byId = new Map(current.entries.map(entry => [entry.id, entry]))
      for (const [caseId, result] of observed) {
        for (const entry of byId.values()) {
          if (entry.datasetHash === run.datasetHash
            && entry.goldHash === run.goldHash
            && entry.caseId === caseId
            && !result.evaluatorError
            && result.assertedSubjects.has(entry.subject)
            && !result.subjects.has(entry.subject)) {
            entry.status = 'resolved'
            entry.lastSeenRunId = run.runId
            entry.lastSeenAt = now
          }
        }
        for (const subject of result.subjects) {
          const id = entryId(run, caseId, subject)
          const previous = byId.get(id)
          if (previous === undefined) {
            byId.set(id, {
              id,
              datasetId: run.datasetId,
              datasetVersion: run.datasetVersion,
              datasetHash: run.datasetHash,
              goldHash: run.goldHash,
              candidateManifestHash: run.candidateManifestHash,
              caseId,
              subject,
              status: 'open',
              firstSeenRunId: run.runId,
              lastSeenRunId: run.runId,
              observations: 1,
              firstSeenAt: now,
              lastSeenAt: now,
              evaluatorError: result.evaluatorError || subject === 'evaluation-run',
              retests: [],
            })
          } else {
            previous.status = 'open'
            previous.lastSeenRunId = run.runId
            previous.lastSeenAt = now
            previous.observations++
            previous.evaluatorError ||= result.evaluatorError
          }
        }
      }
      const next: BadcaseCasebook = {
        schemaVersion: 1,
        kind: 'evaluation-badcase-casebook',
        updatedAt: now,
        entries: [...byId.values()].sort((left, right) =>
          right.lastSeenAt.localeCompare(left.lastSeenAt)
          || left.id.localeCompare(right.id)),
      }
      await writePrivateJson(this.file, next)
      return next
    })
  }

  async decide(
    id: string,
    decision: BadcaseDecision,
    note?: string,
    decidedAt = new Date().toISOString(),
  ): Promise<BadcaseCasebook> {
    if (!ENTRY_ID.test(id)) throw new Error('invalid badcase entry id')
    const selectedNote = note?.trim()
    if (selectedNote !== undefined && selectedNote.length > MAX_NOTE_LENGTH) {
      throw new Error(`badcase decision note exceeds ${MAX_NOTE_LENGTH} characters`)
    }
    return runFileTransaction(this.file, async () => {
      const current = await this.readUnlocked()
      const entry = current.entries.find(candidate => candidate.id === id)
      if (entry === undefined) throw new Error('badcase entry not found')
      entry.decision = {
        value: decision,
        decidedAt,
        ...(selectedNote === undefined || selectedNote === '' ? {} : { note: selectedNote }),
      }
      current.updatedAt = decidedAt
      await writePrivateJson(this.file, current)
      return current
    })
  }

  async recordRetest(
    id: string,
    run: EvaluationRun,
  ): Promise<BadcaseCasebook> {
    if (!ENTRY_ID.test(id)) throw new Error('invalid badcase entry id')
    return runFileTransaction(this.file, async () => {
      const current = await this.readUnlocked()
      const entry = current.entries.find(candidate => candidate.id === id)
      if (entry === undefined) throw new Error('badcase entry not found')
      const outcome = retestOutcome(entry, run)
      entry.retests = [
        ...entry.retests.filter(retest => retest.runId !== run.runId),
        { runId: run.runId, testedAt: run.createdAt, outcome },
      ]
      if (outcome === 'fixed') entry.status = 'resolved'
      else if (outcome === 'not-fixed') entry.status = 'open'
      current.updatedAt = run.createdAt
      await writePrivateJson(this.file, current)
      return current
    })
  }
}

export function defaultCasebookFile(dataRoot: string): string {
  return path.join(dataRoot, 'evaluations', 'casebook.json')
}
