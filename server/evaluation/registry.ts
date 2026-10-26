import { createHash } from 'node:crypto'
import {
  LOCAL_TRAJECTORY_CONTEXT_POLICY_HASH,
  LOCAL_TRAJECTORY_CONTRACT_HASH,
  LOCAL_TRAJECTORY_EVALUATOR_BUILD_HASH,
} from './identity'

export interface EvaluatorDefinition {
  id: string
  version: string
  kind: 'rule' | 'process' | 'human-import'
  contractHash: string
  buildHash: string
  contextPolicyHash: string
  dependencies: string[]
  calibrationStatus: 'synthetic-calibrated' | 'uncalibrated' | 'human-authoritative'
  gateLevel: 'required' | 'advisory' | 'input-only'
}

interface ProcessEvaluatorSpec {
  evaluatorId: string
  evaluatorVersion: string
  scope: unknown
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export class EvaluatorRegistry {
  private readonly definitions = new Map<string, EvaluatorDefinition>()

  register(definition: EvaluatorDefinition): this {
    const current = this.definitions.get(definition.id)
    if (current !== undefined) {
      throw new Error(`duplicate evaluator registration: ${definition.id}`)
    }
    this.definitions.set(definition.id, Object.freeze({
      ...definition,
      dependencies: [...definition.dependencies],
    }))
    return this
  }

  require(id: string): EvaluatorDefinition {
    const definition = this.definitions.get(id)
    if (definition === undefined) throw new Error(`evaluator is not registered: ${id}`)
    return definition
  }

  list(): EvaluatorDefinition[] {
    return [...this.definitions.values()]
      .map(definition => ({ ...definition, dependencies: [...definition.dependencies] }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }
}

export const LOCAL_TRAJECTORY_EVALUATOR = Object.freeze({
  id: 'local-trajectory',
  version: '1',
  kind: 'rule',
  contractHash: LOCAL_TRAJECTORY_CONTRACT_HASH,
  buildHash: LOCAL_TRAJECTORY_EVALUATOR_BUILD_HASH,
  contextPolicyHash: LOCAL_TRAJECTORY_CONTEXT_POLICY_HASH,
  dependencies: [
    'trajectory-analysis',
    'facts-quality-v4',
    'coverage-policy-v3',
  ],
  calibrationStatus: 'synthetic-calibrated',
  gateLevel: 'required',
} satisfies EvaluatorDefinition)

export const HUMAN_GOLD_IMPORT_EVALUATOR = Object.freeze({
  id: 'human-gold-import',
  version: '1',
  kind: 'human-import',
  contractHash: hash({
    criteria: 'complete',
    requirements: 'complete',
    chain: 'complete',
    evidence: 'record-grounded',
  }),
  buildHash: hash({ implementation: 'adjudication-parser-v2' }),
  contextPolicyHash: hash({ context: 'frozen-candidate-manifest' }),
  dependencies: ['candidate-manifest-v2', 'privacy-audit-v2', 'adjudication-v1'],
  calibrationStatus: 'human-authoritative',
  gateLevel: 'input-only',
} satisfies EvaluatorDefinition)

export function processCheckEvaluatorDefinition(
  spec: ProcessEvaluatorSpec,
): EvaluatorDefinition {
  return {
    id: spec.evaluatorId,
    version: spec.evaluatorVersion,
    kind: 'process',
    contractHash: hash(spec),
    buildHash: hash({
      evaluatorId: spec.evaluatorId,
      evaluatorVersion: spec.evaluatorVersion,
      implementation: 'trajectory-diagnosis-process-v1',
    }),
    contextPolicyHash: hash(spec.scope),
    dependencies: [
      'diagnosis-access-ledger-v1',
      'frozen-diagnosis-snapshot-v1',
      'diagnosis-report-v1',
    ],
    calibrationStatus: 'uncalibrated',
    gateLevel: 'advisory',
  }
}

export function createEvaluatorRegistry(
  processCheckSpec?: ProcessEvaluatorSpec,
): EvaluatorRegistry {
  const registry = new EvaluatorRegistry()
    .register(LOCAL_TRAJECTORY_EVALUATOR)
    .register(HUMAN_GOLD_IMPORT_EVALUATOR)
  if (processCheckSpec !== undefined) {
    registry.register(processCheckEvaluatorDefinition(processCheckSpec))
  }
  return registry
}
