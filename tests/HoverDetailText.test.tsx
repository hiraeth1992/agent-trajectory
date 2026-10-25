// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HoverDetailText } from '../src/components/HoverDetailText'

interface Rect {
  bottom: number
  height: number
  left: number
  right: number
  top: number
  width: number
}

function domRect(rect: Rect): DOMRect {
  return {
    ...rect,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  } as DOMRect
}

function geometry(trigger: Rect, tooltip: Rect): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      return domRect(this.classList.contains('hover-detail-tooltip')
        ? tooltip
        : trigger)
    })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('HoverDetailText', () => {
  it('places an objective tooltip below and keeps it inside the viewport width', async () => {
    vi.stubGlobal('innerWidth', 800)
    vi.stubGlobal('innerHeight', 600)
    geometry(
      { top: 20, bottom: 40, left: 760, right: 790, width: 30, height: 20 },
      { top: 0, bottom: 150, left: 0, right: 300, width: 300, height: 150 },
    )
    render(
      <HoverDetailText
        placement="below"
        text="很长的会话目标"
      />,
    )

    fireEvent.mouseEnter(screen.getByLabelText('很长的会话目标'))
    const tooltip = await screen.findByRole('tooltip')

    await waitFor(() => expect(tooltip.dataset.placement).toBe('below'))
    expect(tooltip.style.top).toBe('47px')
    expect(tooltip.style.left).toBe('492px')
    expect(tooltip.style.maxWidth).toBe('420px')
  })

  it('flips an automatic tooltip above when the lower viewport has no room', async () => {
    vi.stubGlobal('innerWidth', 800)
    vi.stubGlobal('innerHeight', 600)
    geometry(
      { top: 560, bottom: 580, left: 120, right: 240, width: 120, height: 20 },
      { top: 0, bottom: 100, left: 0, right: 200, width: 200, height: 100 },
    )
    render(<HoverDetailText text="故事线详情" />)

    fireEvent.focus(screen.getByLabelText('故事线详情'))
    const tooltip = await screen.findByRole('tooltip')

    await waitFor(() => expect(tooltip.dataset.placement).toBe('above'))
    expect(tooltip.style.top).toBe('453px')
    expect(tooltip.style.left).toBe('120px')
  })

  it('limits oversized content to the available viewport height', async () => {
    vi.stubGlobal('innerWidth', 390)
    vi.stubGlobal('innerHeight', 300)
    geometry(
      { top: 100, bottom: 120, left: 20, right: 200, width: 180, height: 20 },
      { top: 0, bottom: 500, left: 0, right: 360, width: 360, height: 500 },
    )
    render(<HoverDetailText text="超长纠错详情" />)

    fireEvent.mouseEnter(screen.getByLabelText('超长纠错详情'))
    const tooltip = await screen.findByRole('tooltip')

    await waitFor(() => expect(tooltip.dataset.placement).toBe('below'))
    expect(tooltip.style.maxHeight).toBe('165px')
    expect(tooltip.style.maxWidth).toBe('374px')
  })
})
