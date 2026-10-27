import { createHash } from 'node:crypto'
import type {
  EvaluationDataset,
  FrozenEvaluationCase,
} from '../../src/evaluation-types'
import {
  EVALUATION_COVERAGE_POLICY_VERSION,
  EVALUATION_FACTS_SCHEMA_VERSION,
  LOCAL_TRAJECTORY_EVALUATOR_ID,
  LOCAL_TRAJECTORY_EVALUATOR_VERSION,
} from '../../src/trajectory-evaluation'

const CRITERIA = [
  'outcome',
  'reliability',
  'recovery',
  'efficiency',
  'observability',
] as const

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function datasetCaseIdentity(testCase: FrozenEvaluationCase): unknown {
  return {
    id: testCase.id,
    split: testCase.split,
    description: testCase.description,
    target: testCase.target,
    detail: testCase.detail,
    sourceStatus: testCase.sourceStatus,
  }
}

function goldCaseIdentity(testCase: FrozenEvaluationCase): unknown {
  return {
    id: testCase.id,
    expected: testCase.expected,
    expectedRequirements: testCase.expectedRequirements,
    expectedChain: testCase.expectedChain,
  }
}

export const LOCAL_TRAJECTORY_CONTRACT_HASH = sha256({
  evaluatorId: LOCAL_TRAJECTORY_EVALUATOR_ID,
  evaluatorVersion: LOCAL_TRAJECTORY_EVALUATOR_VERSION,
  factsSchemaVersion: EVALUATION_FACTS_SCHEMA_VERSION,
  coveragePolicyVersion: EVALUATION_COVERAGE_POLICY_VERSION,
  criteria: CRITERIA,
  verdictClasses: {
    positive: ['fail', 'warning'],
    negative: ['pass'],
    abstain: ['not_applicable', 'insufficient_evidence', 'out_of_scope'],
    error: ['evaluator_error'],
  },
  requirementStates: [
    'misunderstood',
    'understood_unimplemented',
    'implemented',
    'superseded',
    'insufficient_evidence',
    'out_of_scope',
  ],
  requirementKinds: [
    'deliverable',
    'constraint',
    'acceptance',
    'prohibition',
  ],
  requirementLineage: [
    'introducedTurn',
    'sourceRecordId',
    'supersededBy',
    'dependsOn',
  ],
  chainContinuities: [
    'normal',
    'incorrect',
    'missing',
    'insufficient_evidence',
    'not_applicable',
  ],
  chainCarryover: ['input', 'action', 'result', 'requirementIds'],
})

export const LOCAL_TRAJECTORY_CONTEXT_POLICY_HASH = sha256({
  scope: 'session',
  targetModes: ['frozen', 'live'],
  evidencePolicy: 'projected-record-ids',
  coveragePolicyVersion: EVALUATION_COVERAGE_POLICY_VERSION,
})

export const LOCAL_TRAJECTORY_EVALUATOR_BUILD_HASH = sha256({
  evaluatorId: LOCAL_TRAJECTORY_EVALUATOR_ID,
  evaluatorVersion: LOCAL_TRAJECTORY_EVALUATOR_VERSION,
  contractHash: LOCAL_TRAJECTORY_CONTRACT_HASH,
  implementationRevision: 6,
})

export function evaluationDatasetHashes(
  dataset: Pick<EvaluationDataset, 'schemaVersion' | 'id' | 'version' | 'description'
    | 'goldCompleteness' | 'candidateManifestHash' | 'cases'>,
): { datasetHash: string; goldHash: string } {
  return {
    datasetHash: sha256({
      schemaVersion: dataset.schemaVersion,
      id: dataset.id,
      version: dataset.version,
      description: dataset.description,
      candidateManifestHash: dataset.candidateManifestHash,
      cases: dataset.cases.map(datasetCaseIdentity),
    }),
    goldHash: sha256({
      schemaVersion: dataset.schemaVersion,
      id: dataset.id,
      version: dataset.version,
      goldCompleteness: dataset.goldCompleteness,
      cases: dataset.cases.map(goldCaseIdentity),
    }),
  }
}

export function createEvaluationDataset(
  dataset: Omit<EvaluationDataset, 'datasetHash' | 'goldHash'>,
): EvaluationDataset {
  const hashes = evaluationDatasetHashes(dataset)
  return { ...dataset, ...hashes }
}

export function assertEvaluationDatasetIdentity(dataset: EvaluationDataset): void {
  const hashes = evaluationDatasetHashes(dataset)
  if (dataset.datasetHash !== hashes.datasetHash) {
    throw new Error('evaluation dataset content hash mismatch')
  }
  if (dataset.goldHash !== hashes.goldHash) {
    throw new Error('evaluation Gold hash mismatch')
  }
  if (dataset.goldCompleteness !== 'full-gold') return
  for (const testCase of dataset.cases) {
    const criteria = new Set(testCase.expected.map(item => item.criterionId))
    if (testCase.expected.length !== CRITERIA.length
      || criteria.size !== CRITERIA.length
      || CRITERIA.some(criterion => !criteria.has(criterion))) {
      throw new Error(`full Gold case ${testCase.id} must assert every criterion exactly once`)
    }
    if (testCase.expectedRequirements === undefined) {
      throw new Error(`full Gold case ${testCase.id} must assert requirements`)
    }
    if (testCase.expectedChain === undefined) {
      throw new Error(`full Gold case ${testCase.id} must assert chain semantics`)
    }
  }
}
