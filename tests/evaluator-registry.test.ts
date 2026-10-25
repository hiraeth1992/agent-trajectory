import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createEvaluatorRegistry,
  EvaluatorRegistry,
  LOCAL_TRAJECTORY_EVALUATOR,
  processCheckEvaluatorDefinition,
} from '../server/evaluation/registry'
import type { ProcessCheckSpec } from '../server/evaluation/process-check'

const spec = JSON.parse(readFileSync(
  new URL('../skills/trajectory-diagnosis/process-check.json', import.meta.url),
  'utf8',
)) as ProcessCheckSpec

describe('evaluator registry', () => {
  it('exposes stable, explicit identities and gate levels', () => {
    const registry = createEvaluatorRegistry(spec)
    expect(registry.list()).toEqual([
      expect.objectContaining({
        id: 'human-gold-import',
        calibrationStatus: 'human-authoritative',
        gateLevel: 'input-only',
      }),
      expect.objectContaining({
        id: 'local-trajectory',
        calibrationStatus: 'synthetic-calibrated',
        gateLevel: 'required',
      }),
      expect.objectContaining({
        id: 'trajectory-diagnosis-process',
        calibrationStatus: 'uncalibrated',
        gateLevel: 'advisory',
      }),
    ])
    expect(registry.require('local-trajectory')).toEqual(LOCAL_TRAJECTORY_EVALUATOR)
  })

  it('binds process identity to its complete spec and rejects duplicates', () => {
    const first = processCheckEvaluatorDefinition(spec)
    const changed = processCheckEvaluatorDefinition({
      ...spec,
      scope: { ...spec.scope, context: 'changed-context' },
    })
    expect(changed.contractHash).not.toBe(first.contractHash)
    expect(changed.contextPolicyHash).not.toBe(first.contextPolicyHash)

    expect(() => new EvaluatorRegistry()
      .register(first)
      .register(first)).toThrow(/duplicate evaluator registration/)
  })
})
