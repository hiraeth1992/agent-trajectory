import { useCallback, useEffect, useRef } from 'react'

export interface SessionRequestLease {
  controller: AbortController
  id: number
  sessionKey: string
}

export function useSessionRequestScope(sessionKey: string) {
  const state = useRef<{
    active?: AbortController
    nextId: number
    sessionKey: string
  }>({
    nextId: 0,
    sessionKey,
  })
  state.current.sessionKey = sessionKey

  const cancel = useCallback(() => {
    state.current.nextId++
    state.current.active?.abort()
    state.current.active = undefined
  }, [])

  useEffect(() => {
    cancel()
    return cancel
  }, [cancel, sessionKey])

  const begin = useCallback((): SessionRequestLease => {
    state.current.active?.abort()
    const controller = new AbortController()
    const lease = {
      controller,
      id: ++state.current.nextId,
      sessionKey: state.current.sessionKey,
    }
    state.current.active = controller
    return lease
  }, [])

  const isCurrent = useCallback((lease: SessionRequestLease): boolean =>
    lease.id === state.current.nextId
    && lease.sessionKey === state.current.sessionKey
    && state.current.active === lease.controller, [])

  const finish = useCallback((lease: SessionRequestLease): boolean => {
    if (!isCurrent(lease)) return false
    state.current.active = undefined
    return true
  }, [isCurrent])

  return { begin, cancel, finish, isCurrent }
}
