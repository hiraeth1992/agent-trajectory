import type {
  TrajectoryDiagnosisTarget,
} from '../../src/diagnosis-types'
import { TRAJECTORY_DIAGNOSIS_PROTOCOL } from '../../src/diagnosis-types'

interface DiagnosisTaskTarget {
  target: TrajectoryDiagnosisTarget
  snapshotId: string
  evidenceCommand: string
  evidenceRoot: string
  skillPath: string
}

export function buildDiagnosisTask(target: DiagnosisTaskTarget): string {
  const descriptor = JSON.stringify({
    protocol: TRAJECTORY_DIAGNOSIS_PROTOCOL,
    source: target.target.source,
    session_id: target.target.sessionId,
    snapshot_id: target.snapshotId,
    evidence_command: target.evidenceCommand,
    evidence_root: target.evidenceRoot,
  })
  return [
    '请加载并使用 $trajectory-diagnosis 诊断以下冻结轨迹。',
    `skill_path: ${JSON.stringify(target.skillPath)}`,
    `diagnosis_target: ${descriptor}`,
  ].join('\n')
}
