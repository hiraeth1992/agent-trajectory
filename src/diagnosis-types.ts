import type { SourceId } from './types'

export const TRAJECTORY_DIAGNOSIS_PROTOCOL = 'trajectory-diagnosis-v1'

export interface TrajectoryDiagnosisTarget {
  source: SourceId
  sessionId: string
}

export interface TrajectoryDiagnosisPromptRequest {
  target: TrajectoryDiagnosisTarget
}

export interface TrajectoryDiagnosisPromptResult {
  status: 'prepared'
  protocol: typeof TRAJECTORY_DIAGNOSIS_PROTOCOL
  snapshotId: string
  prompt: string
}
