import type {
  JsonObject,
  SourceId,
  TrajectoryRecord,
} from './types'

export type ProjectedRecordCache = Map<string, TrajectoryRecord>

let activeProjectedRecordCache: ProjectedRecordCache | undefined

export function withProjectedRecordCache<T>(
  cache: ProjectedRecordCache,
  project: () => T,
): T {
  const previous = activeProjectedRecordCache
  activeProjectedRecordCache = cache
  try {
    return project()
  } finally {
    activeProjectedRecordCache = previous
  }
}

export function asJsonObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function compactText(value: string, limit = 180): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 1)}…`
}

export function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function parseStructured(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function redactSensitiveString(value: string): string {
  return value
    .replace(
      /(?<![\w+.-])([a-z][a-z\d+.-]{0,31}:\/\/)[^/\s:@]{1,256}:[^/\s@]{1,256}@/gi,
      '$1<redacted>@',
    )
    .replace(
      /(\bAuthorization\s*:\s*)(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
      '$1<redacted>',
    )
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '<redacted>')
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}\b/g, '<redacted>')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '<redacted>')
    .replace(
      /(["']?(?:password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie)["']?\s*[:=]\s*["']?)([^"',;\s}\]]+)/gi,
      '$1<redacted>',
    )
}

function redactSensitiveArray(value: unknown[]): unknown[] {
  const safe = value.map(item => redactSensitive(item))
  for (let index = 0; index < value.length; index++) {
    const item = value[index]
    if (typeof item !== 'string') continue
    const header = item.match(/^\s*Authorization\s*:\s*(Basic|Bearer)?\s*$/i)
    if (header === null) continue
    if (header[1] !== undefined) {
      if (typeof value[index + 1] === 'string') safe[index + 1] = '<redacted>'
      continue
    }
    const next = value[index + 1]
    if (typeof next !== 'string') continue
    const scheme = next.match(/^\s*(Basic|Bearer)(?:\s+(.+))?\s*$/i)
    if (scheme === null) {
      safe[index + 1] = '<redacted>'
    } else if (scheme[2] !== undefined) {
      safe[index + 1] = `${scheme[1]} <redacted>`
    } else if (typeof value[index + 2] === 'string') {
      safe[index + 2] = '<redacted>'
    }
  }
  return safe
}

export function redactSensitive(value: unknown, key = ''): unknown {
  if (/encrypted_(content|function_args)/i.test(key)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const marker = value as JsonObject
      if (typeof marker.present === 'boolean' && Object.keys(marker).length === 1) {
        return { present: marker.present }
      }
    }
    if (value === null || value === undefined) return { present: false }
    return { present: Array.isArray(value) ? value.length > 0 : true }
  }
  if (/password|passwd|secret|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie/i.test(key)
    || /^token$/i.test(key)) {
    return '<redacted>'
  }
  if (typeof value === 'string' && /arguments|input|output/i.test(key)) {
    const parsed = parseStructured(value)
    if (parsed !== value) return redactSensitive(parsed, key)
  }
  if (typeof value === 'string') return redactSensitiveString(value)
  if (Array.isArray(value)) return redactSensitiveArray(value)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonObject).map(([childKey, child]) => [
        childKey,
        redactSensitive(child, childKey),
      ]),
    )
  }
  return value
}

export function projectedRecord(
  source: SourceId,
  record: Omit<TrajectoryRecord, 'searchText' | 'source'>,
): TrajectoryRecord {
  const recordCache = activeProjectedRecordCache
  const cacheKey = recordCache === undefined
    ? undefined
    : [
        source,
        record.id,
        record.sourceEventIds.join(','),
        record.status,
        record.endTime,
        record.endSeq,
        record.summary,
        jsonText(record.usage),
        jsonText(record.metrics),
        jsonText(record.error),
      ].join('|')
  const cached = cacheKey === undefined || recordCache === undefined
    ? undefined
    : recordCache.get(cacheKey)
  if (cached !== undefined) return cached
  const safe = redactSensitive(record) as Omit<TrajectoryRecord, 'searchText' | 'source'>
  const projected = { ...safe, source, searchText: recordSearchText(safe) }
  if (cacheKey !== undefined && recordCache !== undefined) {
    recordCache.set(cacheKey, projected)
  }
  return projected
}

export function recordSearchText(
  record: Omit<TrajectoryRecord, 'searchText' | 'source'> & { source?: SourceId },
): string {
  const content = record.kind === 'user'
    || record.kind === 'steering'
    || record.kind === 'context'
    || record.kind === 'system'
    ? [record.input]
    : record.kind === 'tool' || record.kind === 'subtool'
      ? [record.input, record.output]
      : [record.output]
  return redactSensitiveString([
    record.kind,
    record.title,
    record.summary,
    record.callId,
    record.parentCallId,
    record.provider,
    record.model,
    ...content.map(jsonText),
    jsonText(record.error),
  ].filter(Boolean).join(' ')).slice(0, 16 * 1024).toLowerCase()
}
