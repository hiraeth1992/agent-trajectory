import type {
  TrajectoryDiagnosisPromptRequest,
  TrajectoryDiagnosisPromptResult,
  TrajectoryDiagnosisTarget,
} from '../../src/diagnosis-types'
import { TRAJECTORY_DIAGNOSIS_PROTOCOL } from '../../src/diagnosis-types'
import type { SessionDetail, SourceId } from '../../src/types'
import type { DiagnosisEvidenceStore } from './evidence-store'
import { buildDiagnosisTask } from './task'

export interface DiagnosisSource {
  load(source: SourceId, sourceSessionId: string): Promise<SessionDetail | undefined>
  fingerprint(source: SourceId, sourceSessionId: string): Promise<string | undefined>
}

export class DiagnosisRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 503,
  ) {
    super(message)
  }
}

export class TrajectoryDiagnosisService {
  constructor(
    private readonly source: DiagnosisSource,
    private readonly evidence: DiagnosisEvidenceStore,
    private readonly evidenceCommand: string,
    private readonly skillPath: string,
  ) {}

  private async freeze(
    target: TrajectoryDiagnosisTarget,
  ) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await this.source.fingerprint(target.source, target.sessionId)
      if (before === undefined) {
        throw new DiagnosisRequestError('diagnosis target session not found', 404)
      }
      const detail = await this.source.load(target.source, target.sessionId)
      if (detail === undefined) {
        throw new DiagnosisRequestError('diagnosis target session not found', 404)
      }
      const after = await this.source.fingerprint(target.source, target.sessionId)
      if (after === before) {
        return {
          detail,
          snapshot: await this.evidence.create(target, after, detail),
        }
      }
    }
    throw new DiagnosisRequestError(
      'diagnosis target changed while freezing evidence; retry when the session is idle',
      409,
    )
  }

  async preparePrompt(
    request: TrajectoryDiagnosisPromptRequest,
  ): Promise<TrajectoryDiagnosisPromptResult> {
    const frozen = await this.freeze(request.target)
    return {
      status: 'prepared',
      protocol: TRAJECTORY_DIAGNOSIS_PROTOCOL,
      snapshotId: frozen.snapshot.snapshotId,
      prompt: buildDiagnosisTask({
        target: request.target,
        snapshotId: frozen.snapshot.snapshotId,
        evidenceCommand: this.evidenceCommand,
        evidenceRoot: this.evidence.directory,
        skillPath: this.skillPath,
      }),
    }
  }
}
