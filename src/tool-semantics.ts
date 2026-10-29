import type { TrajectoryRecord } from './types'

export type CommandPurpose =
  | 'build'
  | 'check'
  | 'dev-server'
  | 'diff'
  | 'read'
  | 'request'
  | 'search'
  | 'test'
  | 'typecheck'
  | 'unknown'

export interface ValidationSemantics {
  kind: 'build' | 'check' | 'test' | 'typecheck'
  outcome: 'failed' | 'passed'
  summary?: string
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function toolCommand(record: Pick<TrajectoryRecord, 'input'>): string {
  const input = object(record.input)
  const value = input.cmd ?? input.command ?? input.program
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
    return value.join(' ')
  }
  if (typeof value === 'string') return value
  return typeof record.input === 'string' ? record.input : ''
}

function commandSegments(command: string): string[][] {
  const segments: string[][] = []
  let current: string[] = []
  let token = ''
  let quote: "'" | '"' | undefined
  let escaped = false
  const pushToken = () => {
    if (token !== '') current.push(token)
    token = ''
  }
  const pushSegment = () => {
    pushToken()
    if (current.length > 0) segments.push(current)
    current = []
  }
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!
    if (escaped) {
      token += character
      escaped = false
      continue
    }
    if (character === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else token += character
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      pushToken()
      continue
    }
    if (character === ';' || character === '\n'
      || character === '&' && command[index + 1] === '&'
      || character === '|' && command[index + 1] === '|') {
      pushSegment()
      if ((character === '&' || character === '|')
        && command[index + 1] === character) index++
      continue
    }
    token += character
  }
  pushSegment()
  return segments
}

function executableTokens(tokens: readonly string[]): string[] {
  let index = 0
  while (index < tokens.length
    && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index]!)) index++
  if (tokens[index] === 'env') {
    index++
    while (index < tokens.length && (
      tokens[index]!.startsWith('-')
      || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index]!)
    )) index++
  }
  return tokens.slice(index)
}

function segmentPurpose(tokens: readonly string[]): CommandPurpose {
  const selected = executableTokens(tokens)
  const executable = selected[0]
    ?.replaceAll('\\', '/')
    .split('/')
    .at(-1)
    ?.toLowerCase()
  const args = selected.slice(1).map(value => value.toLowerCase())
  if (executable === undefined) return 'unknown'
  if (executable === 'npm' || executable === 'pnpm'
    || executable === 'yarn' || executable === 'bun') {
    const script = args[0] === 'run' ? args[1] : args[0]
    if (script === 'test' || script?.startsWith('test:')) return 'test'
    if (script === 'build' || script?.startsWith('build:')) return 'build'
    if (script === 'typecheck' || script === 'type-check'
      || script === 'check:types') return 'typecheck'
    if (script === 'lint' || script === 'check' || script === 'verify'
      || script?.startsWith('lint:') || script?.startsWith('check:')
      || script?.startsWith('verify:')) return 'check'
    if (script === 'dev' || script === 'preview' || script === 'desktop') {
      return 'dev-server'
    }
  }
  if (executable === 'npx' || executable === 'pnpx' || executable === 'bunx') {
    return segmentPurpose(selected.slice(1))
  }
  if ((executable === 'python' || executable === 'python3')
    && args[0] === '-m' && args[1] === 'pytest') return 'test'
  if (['pytest', 'vitest', 'jest'].includes(executable)
    || executable === 'cargo' && args[0] === 'test'
    || executable === 'go' && args[0] === 'test') return 'test'
  if (executable === 'vite' && args[0] === 'build'
    || executable === 'cargo' && args[0] === 'build'
    || executable === 'go' && args[0] === 'build'
    || executable === 'electron-builder') return 'build'
  if (executable === 'tsc' || executable === 'mypy'
    || executable === 'pyright') return 'typecheck'
  if (executable === 'eslint' || executable === 'ruff'
    || executable === 'biome') return 'check'
  if (executable === 'node' && args.includes('--check')) return 'check'
  if (executable === 'git'
    && (args[0] === 'status' || args[0] === 'diff')) return 'diff'
  if (['rg', 'grep', 'find'].includes(executable)) return 'search'
  if (['sed', 'cat', 'head', 'tail'].includes(executable)) return 'read'
  if (executable === 'curl' || executable === 'wget') return 'request'
  if (executable === 'vite'
    || executable === 'tsx' && args[0] === 'server/index') return 'dev-server'
  return 'unknown'
}

export function classifyCommand(command: string): CommandPurpose {
  const purposes = commandSegments(command).map(segmentPurpose)
  for (const purpose of ['test', 'build', 'typecheck', 'check'] as const) {
    if (purposes.includes(purpose)) return purpose
  }
  const explicitBrowserCheck = /\bplaywright\b/i.test(command)
    && /process\.exit\s*\(\s*1\s*\)|\bassert(?:\.|\s*\()|throw\s+new\s+Error\b/.test(command)
  if (explicitBrowserCheck) return 'check'
  return purposes.find(purpose => purpose !== 'unknown') ?? 'unknown'
}

function visibleText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(visibleText).filter(Boolean).join('\n')
  if (value === null || typeof value !== 'object') return ''
  const source = value as Record<string, unknown>
  return [
    source.text,
    source.output,
    source.stdout,
    source.stderr,
    source.preview,
    source.result,
    source.content,
  ].map(visibleText).filter(Boolean).join('\n')
}

function failureSummary(output: string): string | undefined {
  const normalized = output.replace(/\s+/g, ' ')
  const count = normalized.match(/\b(?:Tests?|Test Files)\s+(\d+)\s+failed\b/i)?.[1]
    ?? normalized.match(/\b(\d+)\s+(?:tests?|项测试)\s+(?:failed|失败)\b/i)?.[1]
  if (count !== undefined && Number(count) > 0) return `${count} 项测试失败`
  return /(?:^|\s)(?:FAIL|FAILED)(?:\s|:|$)|tests?.{0,30}(?:failed|失败)|(?:failed|失败).{0,30}tests?/i
    .test(normalized)
    ? '验证输出包含失败结果'
    : undefined
}

function successSummary(output: string): string | undefined {
  const files = output.match(/Test Files\s+(\d+)\s+passed/i)?.[1]
  const tests = output.match(/Tests\s+(\d+)\s+passed/i)?.[1]
  if (files !== undefined || tests !== undefined) {
    return `测试通过${files === undefined ? '' : `：${files} 个测试文件`}${
      tests === undefined ? '' : `、${tests} 项测试`
    }全部通过`
  }
  const generic = output.match(/(\d+)\s+(?:tests?|项测试)\s+passed/i)?.[1]
  return generic === undefined ? undefined : `测试通过：${generic} 项全部通过`
}

export function validationSemantics(
  record: Pick<TrajectoryRecord,
    'error' | 'input' | 'kind' | 'output' | 'status' | 'title'>,
): ValidationSemantics | undefined {
  if (record.kind !== 'tool' && record.kind !== 'subtool') return undefined
  const purpose = classifyCommand(toolCommand(record))
  const titlePurpose = /^(?:test|run_tests|pytest|typecheck|lint|build|verify)$/i
    .test(record.title)
    ? /typecheck/i.test(record.title)
      ? 'typecheck'
      : /build/i.test(record.title)
        ? 'build'
        : /lint|verify/i.test(record.title) ? 'check' : 'test'
    : undefined
  const kind = purpose === 'test' || purpose === 'build'
    || purpose === 'typecheck' || purpose === 'check'
    ? purpose
    : titlePurpose
  if (kind === undefined) return undefined
  const output = visibleText(record.output)
  const failure = failureSummary(output)
  if (record.status === 'error' || record.status === 'interrupted'
    || record.error !== undefined || failure !== undefined) {
    return {
      kind,
      outcome: 'failed',
      summary: failure ?? record.error?.reason ?? '验证执行失败',
    }
  }
  return { kind, outcome: 'passed', summary: successSummary(output) }
}
