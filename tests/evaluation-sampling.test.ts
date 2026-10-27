import { describe, expect, it } from 'vitest'
import {
  candidateGroupKeys,
  groupAwareSplits,
  type SamplingCandidate,
} from '../server/evaluation/sampling'
import { capabilities, sessionKey } from '../server/sources/types'
import type { SessionDetail, SourceId } from '../src/types'

function candidate(
  id: string,
  cwd: string,
  parentSessionId?: string,
): SamplingCandidate {
  const source: SourceId = 'codex'
  const summary = {
    id: sessionKey(source, id),
    source,
    sourceSessionId: id,
    format: 'sampling-test',
    capabilities: capabilities('messages'),
    cwd,
    title: id,
    createdAt: 1,
    updatedAt: 2,
    size: 1,
  }
  const detail: SessionDetail = {
    summary,
    projection: {
      header: {
        source,
        format: summary.format,
        id,
        createdAt: 1,
        cwd,
        parentSessionId,
      },
      records: [],
      turns: [],
      lanes: [],
      startTime: 1,
      endTime: 2,
      eventCount: 0,
      eventTypeCounts: {},
      unknownEventTypes: [],
      turnEnds: {},
    },
  }
  return { detail, summary, fingerprint: `fingerprint:${id}` }
}

describe('evaluation sampling groups', () => {
  it('keeps parent, child, and descendants in one split even across workspaces', () => {
    const parent = candidate('parent', '/workspace/root')
    const child = candidate('child', '/workspace/child', 'parent')
    const grandchild = candidate('grandchild', '/workspace/other', 'child')
    const values = [
      parent,
      child,
      grandchild,
      candidate('independent-a', '/workspace/a'),
      candidate('independent-b', '/workspace/b'),
    ]

    const keys = candidateGroupKeys(values)
    expect(keys.get(parent)).toBe(keys.get(child))
    expect(keys.get(child)).toBe(keys.get(grandchild))

    for (const seed of ['one', 'two', 'three', 'four']) {
      const splits = groupAwareSplits(values, seed)
      expect(splits.get(parent)).toBe(splits.get(child))
      expect(splits.get(child)).toBe(splits.get(grandchild))
    }
  })
})
