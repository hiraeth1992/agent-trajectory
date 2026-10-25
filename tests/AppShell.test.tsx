// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppHeader } from '../src/components/AppHeader'
import { HeaderActionMenu } from '../src/components/HeaderActionMenu'
import { StateView } from '../src/components/StateView'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('shared application shell', () => {
  it('keeps workspace navigation, flexible context, and actions behind one interface', () => {
    const onWorkspaceChange = vi.fn()
    render(
      <AppHeader
        workspace="sessions"
        onWorkspaceChange={onWorkspaceChange}
        context={<select aria-label="当前上下文"><option>会话一</option></select>}
        actions={<button type="button">刷新</button>}
      />,
    )

    expect(document.querySelector('.app-header')?.className).toContain('with-context')
    expect(screen.getByRole('combobox', { name: '当前上下文' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '评测中心' }))
    expect(onWorkspaceChange).toHaveBeenCalledWith('evaluation')
  })

  it('exposes secondary actions through an accessible menu', () => {
    render(
      <HeaderActionMenu>
        <a href="/export" role="menuitem">导出</a>
      </HeaderActionMenu>,
    )

    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '导出' })).toBeTruthy()
  })

  it('uses one state surface for neutral and error feedback', () => {
    const { rerender } = render(
      <StateView title="正在加载" description="请稍候" />,
    )
    expect(screen.getByRole('status').textContent).toContain('正在加载')

    rerender(
      <StateView tone="danger" title="加载失败" description="请重试" />,
    )
    expect(screen.getByRole('alert').textContent).toContain('加载失败')
  })
})
