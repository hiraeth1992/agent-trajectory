import { spawn } from 'node:child_process'

export function openBrowser(url: string): void {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open'
  const arguments_ = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'start', '', url]
    : [url]
  const child = spawn(command, arguments_, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.once('error', () => {})
  child.unref()
}
