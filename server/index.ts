import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startAgentTrajectoryServer } from './app'
import { sessionsRoot } from './sources/dsh'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isProduction = process.env.NODE_ENV === 'production'
const server = await startAgentTrajectoryServer({
  root,
  host: process.env.HOST,
  port: process.env.PORT === undefined ? 4317 : Number(process.env.PORT),
  development: !isProduction,
})

console.log(`Agent Trajectory: ${server.url}`)
console.log(`Reading sessions from: ${sessionsRoot}`)

let closing = false
const close = () => {
  if (closing) return
  closing = true
  void server.close().finally(() => process.exit(0))
}

process.once('SIGINT', close)
process.once('SIGTERM', close)
