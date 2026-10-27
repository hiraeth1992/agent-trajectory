// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrajectoryDiagnosisButton } from '../src/components/TrajectoryDiagnosisButton'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function prepared(prompt = 'diagnosis prompt'): Response {
  return new Response(JSON.stringify({
    status: 'prepared',
    protocol: 'trajectory-diagnosis-v1',
    snapshotId: 'snapshot-12345678901234567890',
    prompt,
  }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubClipboard(writeText: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { writeText },
  })
}

describe('TrajectoryDiagnosisButton', () => {
  it('does not copy a prompt prepared for a previous target', async () => {
    let resolve!: (value: Response) => void
    const pending = new Promise<Response>(fulfill => {
      resolve = fulfill
    })
    const writeText = vi.fn(async () => {})
    stubClipboard(writeText)
    vi.stubGlobal('fetch', vi.fn(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => new Promise<Response>((fulfill, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), {
        name: 'AbortError',
      }))
      init?.signal?.addEventListener('abort', abort, { once: true })
      void pending.then(fulfill, reject)
    })))
    const view = render(
      <TrajectoryDiagnosisButton
        source="codex"
        sourceSessionId="old-session"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '本地 Agent 诊断' }))
    view.rerender(
      <TrajectoryDiagnosisButton
        source="codex"
        sourceSessionId="new-session"
      />,
    )
    resolve(prepared('old prompt'))
    await new Promise(resolveTick => setTimeout(resolveTick, 0))

    expect(writeText).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '已复制 Prompt' })).toBeNull()
  })

  it('copies the prepared prompt and tells the user to open a new session', async () => {
    const writeText = vi.fn(async () => {})
    const fetchMock = vi.fn(async () => prepared())
    stubClipboard(writeText)
    vi.stubGlobal('fetch', fetchMock)
    render(
      <TrajectoryDiagnosisButton
        source="codex"
        sourceSessionId="source/thread"
      />,
    )

    const trigger = screen.getByRole('button', { name: '本地 Agent 诊断' })
    expect(trigger.querySelector('svg')).not.toBeNull()
    fireEvent.click(trigger)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/diagnosis/prompt',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: { source: 'codex', sessionId: 'source/thread' },
        }),
        signal: expect.any(AbortSignal),
      }),
    ))
    expect(writeText).toHaveBeenCalledWith('diagnosis prompt')
    const dialog = await screen.findByRole('dialog', { name: '已复制 Prompt' })
    expect(dialog.textContent).toContain('打开新会话开启诊断')
    expect(screen.queryByRole('link')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(screen.queryByRole('dialog', { name: '已复制 Prompt' })).toBeNull()
  })

  it('shows a compact API error and allows retrying', async () => {
    const writeText = vi.fn(async () => {})
    stubClipboard(writeText)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'ZCode unavailable',
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })))
    render(
      <TrajectoryDiagnosisButton
        source="zcode"
        sourceSessionId="session-1"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '本地 Agent 诊断' }))

    expect((await screen.findByRole('alert')).textContent).toContain('ZCode unavailable')
    await waitFor(() => expect(
      (screen.getByRole('button', {
        name: '本地 Agent 诊断',
      }) as HTMLButtonElement).disabled,
    ).toBe(false))
    expect(writeText).not.toHaveBeenCalled()
  })

  it('shows a clipboard failure and allows retrying', async () => {
    const writeText = vi.fn()
      .mockRejectedValueOnce(new Error('clipboard unavailable'))
      .mockResolvedValueOnce(undefined)
    const fetchMock = vi.fn(async () => prepared('retry prompt'))
    stubClipboard(writeText)
    vi.stubGlobal('fetch', fetchMock)
    render(
      <TrajectoryDiagnosisButton
        source="dsh"
        sourceSessionId="session-2"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '本地 Agent 诊断' }))
    expect((await screen.findByRole('alert')).textContent)
      .toContain('clipboard unavailable')
    fireEvent.click(screen.getByRole('button', { name: '本地 Agent 诊断' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('dialog', { name: '已复制 Prompt' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
