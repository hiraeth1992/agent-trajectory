import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startAgentTrajectoryServer } from './app'
import {
  defaultDataRoot,
  readConfig,
  resolveSourcePaths,
} from './source-paths'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isProduction = process.env.NODE_ENV === 'production'
const dataRoot = path.resolve(
  process.env.AGENT_TRAJECTORY_DATA_DIR ?? defaultDataRoot(),
)
const config = await readConfig(dataRoot)
const sourcePaths = resolveSourcePaths({
  config: config.sources,
  configDirectory: dataRoot,
})
const server = await startAgentTrajectoryServer({
  root,
  host: process.env.HOST,
  port: process.env.PORT === undefined ? 4317 : Number(process.env.PORT),
  development: !isProduction,
  summaryDataRoot: dataRoot,
  sourcePaths,
})

console.log(`Agent Trajectory: ${server.url}`)
console.log(`DSH sessions: ${sourcePaths.dshSessionsDir}`)
console.log(`Codex sessions: ${sourcePaths.codexSessionsDir}`)
console.log(`ZCode database: ${sourcePaths.zcodeDatabase}`)

let closing = false
const close = () => {
  if (closing) return
  closing = true
  void server.close().finally(() => process.exit(0))
}

process.once('SIGINT', close)
process.once('SIGTERM', close)
