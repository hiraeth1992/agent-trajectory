import { createHash } from 'node:crypto'
import type { EvaluationSplit } from '../../src/evaluation-types'
import type { SessionDetail } from '../../src/types'

export const SAMPLING_POLICY_VERSION = 4

export interface SamplingCandidate {
  detail: SessionDetail
  fingerprint: string
  summary: SessionDetail['summary']
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function visibleCandidateTraits(detail: SessionDetail): string[] {
  const records = detail.projection.records
  const userRecords = records.filter(record =>
    record.kind === 'user' || record.kind === 'steering')
  return [
    records.some(record => record.status === 'running') ? 'running' : undefined,
    records.some(record => record.status === 'error') ? 'error-present' : undefined,
    detail.projection.turns.length >= 4 ? 'long-multiturn' : undefined,
    records.length >= 50 ? 'long-records' : undefined,
    records.filter(record =>
      record.kind === 'tool' || record.kind === 'subtool').length >= 10
      ? 'tool-dense'
      : undefined,
    userRecords.length >= 2 ? 'multiple-user-messages' : undefined,
    detail.projection.unknownEventTypes.length > 0 ? 'coverage-gap' : undefined,
    detail.projection.modelContextRecordIds !== undefined ? 'model-context' : undefined,
    detail.projection.usage !== undefined ? 'usage-visible' : undefined,
  ].filter((value): value is string => value !== undefined)
}

export function seededRank(seed: string, value: string): string {
  return sha256(`${seed}\0${value}`)
}

export function candidateGroupKey(detail: SessionDetail): string {
  const parent = detail.projection.header.parentSessionId
  const workspace = detail.summary.cwd.replaceAll('\\', '/').replace(/\/+$/, '')
  return parent === undefined || parent === ''
    ? `${detail.summary.source}:workspace:${workspace || '<unknown>'}`
    : `${detail.summary.source}:parent:${parent}`
}

export function candidateGroupKeys<T extends SamplingCandidate>(
  values: readonly T[],
): Map<T, string> {
  const parents = values.map((_value, index) => index)
  const root = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]!]!
      index = parents[index]!
    }
    return index
  }
  const union = (left: number, right: number) => {
    const leftRoot = root(left)
    const rightRoot = root(right)
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot
  }
  const bySession = new Map<string, number>()
  const byWorkspace = new Map<string, number>()
  const byMissingParent = new Map<string, number>()
  values.forEach((value, index) => {
    bySession.set(`${value.summary.source}:${value.summary.sourceSessionId}`, index)
    const workspace = value.summary.cwd.replaceAll('\\', '/').replace(/\/+$/, '')
    const workspaceKey = `${value.summary.source}:${workspace || '<unknown>'}`
    const previous = byWorkspace.get(workspaceKey)
    if (previous === undefined) byWorkspace.set(workspaceKey, index)
    else union(previous, index)
  })
  values.forEach((value, index) => {
    const parentId = value.detail.projection.header.parentSessionId
    if (parentId === undefined || parentId === '') return
    const parentKey = `${value.summary.source}:${parentId}`
    const parentIndex = bySession.get(parentKey)
    if (parentIndex !== undefined) {
      union(parentIndex, index)
      return
    }
    const sibling = byMissingParent.get(parentKey)
    if (sibling === undefined) byMissingParent.set(parentKey, index)
    else union(sibling, index)
  })
  const members = new Map<number, string[]>()
  values.forEach((value, index) => {
    const selectedRoot = root(index)
    const group = members.get(selectedRoot) ?? []
    group.push(`${value.summary.source}:${value.summary.sourceSessionId}`)
    members.set(selectedRoot, group)
  })
  return new Map(values.map((value, index) => {
    const identities = members.get(root(index))!.sort()
    return [
      value,
      `${value.summary.source}:lineage-workspace:${sha256(identities.join('\0'))}`,
    ]
  }))
}

export function candidatePoolHash(
  values: SamplingCandidate[],
  groupKeys = candidateGroupKeys(values),
): string {
  return sha256(JSON.stringify(values
    .map(value => ({
      source: value.summary.source,
      fingerprint: sha256(value.fingerprint),
      groupHash: sha256(groupKeys.get(value) ?? candidateGroupKey(value.detail)),
      traits: visibleCandidateTraits(value.detail),
      records: value.detail.projection.records.length,
      turns: value.detail.projection.turns.length,
    }))
    .sort((left, right) =>
      left.source.localeCompare(right.source)
      || left.fingerprint.localeCompare(right.fingerprint))))
}

export function rankCandidates<T extends SamplingCandidate>(
  values: T[],
  count: number,
  seed: string,
): T[] {
  const selected: T[] = []
  const remaining = [...values]
  const seenTraits = new Set<string>()
  while (selected.length < count && remaining.length > 0) {
    remaining.sort((left, right) => {
      const leftNew = visibleCandidateTraits(left.detail).filter(
        trait => !seenTraits.has(trait),
      ).length
      const rightNew = visibleCandidateTraits(right.detail).filter(
        trait => !seenTraits.has(trait),
      ).length
      return rightNew - leftNew
        || right.detail.projection.records.length - left.detail.projection.records.length
        || seededRank(seed, left.fingerprint)
          .localeCompare(seededRank(seed, right.fingerprint))
    })
    const next = remaining.shift()!
    selected.push(next)
    visibleCandidateTraits(next.detail).forEach(trait => seenTraits.add(trait))
  }
  return selected
}

function splitTargets(total: number): Record<EvaluationSplit, number> {
  if (total < 3) {
    return {
      calibration: total,
      regression: 0,
      independent: 0,
    }
  }
  const calibration = Math.ceil(total * 0.5)
  const regression = Math.max(1, Math.floor(total * 0.2))
  return {
    calibration: Math.min(calibration, total - 2),
    regression,
    independent: total - Math.min(calibration, total - 2) - regression,
  }
}

export function groupAwareSplits<T extends SamplingCandidate>(
  values: T[],
  seed: string,
  providedGroupKeys?: ReadonlyMap<T, string>,
): Map<T, EvaluationSplit> {
  const groupKeys = providedGroupKeys ?? candidateGroupKeys(values)
  const groups = new Map<string, T[]>()
  for (const value of values) {
    const key = groupKeys.get(value) ?? candidateGroupKey(value.detail)
    const group = groups.get(key) ?? []
    group.push(value)
    groups.set(key, group)
  }
  const targets = splitTargets(values.length)
  const counts: Record<EvaluationSplit, number> = {
    calibration: 0,
    regression: 0,
    independent: 0,
  }
  const assignments = new Map<T, EvaluationSplit>()
  const ordered = [...groups].sort(([leftKey, left], [rightKey, right]) =>
    right.length - left.length
    || seededRank(seed, leftKey).localeCompare(seededRank(seed, rightKey)))
  if (values.length >= 3 && ordered.length < 3) {
    throw new Error(
      `at least 3 independent candidate groups are required for calibration, regression, and independent splits; found ${ordered.length}`,
    )
  }
  const requiredSplits: EvaluationSplit[] = [
    'calibration',
    'independent',
    'regression',
  ]
  for (const [index, [, group]] of ordered.entries()) {
    const required = requiredSplits[index]
    const split = [...(['calibration', 'regression', 'independent'] as const)]
      .sort((left, right) => {
        const leftNeed = targets[left] - counts[left]
        const rightNeed = targets[right] - counts[right]
        return rightNeed - leftNeed || left.localeCompare(right)
      })[0]
    const selected = required ?? split
    for (const value of group) assignments.set(value, selected)
    counts[selected] += group.length
  }
  return assignments
}
