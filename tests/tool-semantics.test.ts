import { describe, expect, it } from 'vitest'
import {
  classifyCommand,
  validationSemantics,
} from '../src/tool-semantics'
import type { TrajectoryRecord } from '../src/types'

function commandRecord(
  command: string,
  output: string,
): Pick<TrajectoryRecord,
  'error' | 'input' | 'kind' | 'output' | 'status' | 'title'> {
  return {
    kind: 'tool',
    title: 'exec_command',
    input: { cmd: command },
    output,
    status: 'complete',
  }
}

describe('tool validation semantics', () => {
  it('recognizes explicit Node syntax and inline assertion checks as validation', () => {
    const syntaxAndAssertions = [
      'node --check build-map.js',
      'node build-map.js',
      `node - <<'NODE'
const checks = { root: true, nodes: true }
if (!Object.values(checks).every(Boolean)) process.exit(1)
NODE`,
    ].join(' && ')
    const browserCheck = `NODE_PATH=/runtime/node_modules node - <<'NODE'
const { chromium } = require('playwright')
const errors = []
if (errors.length) process.exit(1)
NODE`

    expect(classifyCommand(syntaxAndAssertions)).toBe('check')
    expect(validationSemantics(commandRecord(
      syntaxAndAssertions,
      '{"checks":{"root":true,"nodes":true}}',
    ))).toMatchObject({ kind: 'check', outcome: 'passed' })
    expect(classifyCommand(browserCheck)).toBe('check')
    expect(validationSemantics(commandRecord(
      browserCheck,
      '{"errors":[]}',
    ))).toMatchObject({ kind: 'check', outcome: 'passed' })
    expect(classifyCommand('node diagnose.js')).toBe('unknown')
  })
})
