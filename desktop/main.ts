import { app, BrowserWindow, dialog, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  startAgentTrajectoryServer,
  type AgentTrajectoryServer,
} from '../server/app'

const developmentRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

let mainWindow: BrowserWindow | undefined
let localServer: AgentTrajectoryServer | undefined
let quitting = false

function applicationRoot(): string {
  return app.isPackaged ? app.getAppPath() : developmentRoot
}

function configureWorkerLocations(): void {
  const workerRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'workers')
    : path.join(developmentRoot, 'dist-electron')
  process.env.AGENT_TRAJECTORY_PROJECTION_WORKER = path.join(
    workerRoot,
    'projection-worker.mjs',
  )
  process.env.AGENT_TRAJECTORY_ZCODE_WORKER = path.join(
    workerRoot,
    'zcode-worker.mjs',
  )
}

function openExternalUrl(url: string): void {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return
  }
  if (target.protocol === 'https:' || target.protocol === 'http:') {
    void shell.openExternal(target.href)
  }
}

function createWindow(url: string): BrowserWindow {
  const allowedOrigin = new URL(url).origin
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f4f1ea',
    title: 'Agent Trajectory',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternalUrl(target)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin === allowedOrigin) return
    event.preventDefault()
    openExternalUrl(target)
  })
  window.once('ready-to-show', () => window.show())
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  void window.loadURL(url)
  return window
}

async function start(): Promise<void> {
  configureWorkerLocations()
  app.setAppUserModelId('com.agenttrajectory.desktop')
  app.setAboutPanelOptions({
    applicationName: 'Agent Trajectory',
    applicationVersion: app.getVersion(),
  })
  app.on('web-contents-created', (_event, contents) => {
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })
  })

  localServer = await startAgentTrajectoryServer({
    root: applicationRoot(),
    staticRoot: path.join(applicationRoot(), 'dist'),
    host: '127.0.0.1',
    port: 0,
    development: false,
  })
  mainWindow = createWindow(localServer.url)
}

app.on('activate', () => {
  if (mainWindow === undefined && localServer !== undefined) {
    mainWindow = createWindow(localServer.url)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (localServer === undefined || quitting) return
  event.preventDefault()
  quitting = true
  const server = localServer
  localServer = undefined
  void server.close().finally(() => app.quit())
})

app.whenReady()
  .then(start)
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    dialog.showErrorBox('Agent Trajectory 无法启动', message)
    app.quit()
  })
