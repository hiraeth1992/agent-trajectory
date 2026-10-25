import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

type HoverDetailPlacement = 'auto' | 'below'

interface HoverDetailTextProps {
  ariaLabel?: string
  className?: string
  display?: ReactNode
  enabled?: boolean
  placement?: HoverDetailPlacement
  text: string
  visibleClassName?: string
}

interface TooltipPosition {
  left: number
  maxHeight: number
  maxWidth: number
  placement: 'above' | 'below'
  top: number
}

const VIEWPORT_MARGIN = 8
const TOOLTIP_GAP = 7
const TOOLTIP_MAX_WIDTH = 420
const MIN_USEFUL_HEIGHT = 96

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

export function HoverDetailText({
  ariaLabel,
  className = 'summary-hover-detail',
  display,
  enabled = true,
  placement = 'auto',
  text,
  visibleClassName = 'summary-hover-visible',
}: HoverDetailTextProps) {
  const tooltipId = useId()
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLSpanElement>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<TooltipPosition>()

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== undefined) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = undefined
    }
  }, [])

  const show = useCallback(() => {
    if (!enabled) return
    cancelClose()
    setOpen(true)
  }, [cancelClose, enabled])

  const hide = useCallback(() => {
    cancelClose()
    setOpen(false)
  }, [cancelClose])

  const scheduleHide = useCallback(() => {
    cancelClose()
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = undefined
      setOpen(false)
    }, 100)
  }, [cancelClose])

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    const tooltip = tooltipRef.current
    if (trigger === null || tooltip === null) return

    const triggerRect = trigger.getBoundingClientRect()
    const tooltipRect = tooltip.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const maxWidth = Math.max(
      0,
      Math.min(TOOLTIP_MAX_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2),
    )
    const measuredHeight = Math.min(
      tooltipRect.height,
      viewportHeight - VIEWPORT_MARGIN * 2,
    )
    const belowSpace = Math.max(
      0,
      viewportHeight - triggerRect.bottom - TOOLTIP_GAP - VIEWPORT_MARGIN,
    )
    const aboveSpace = Math.max(
      0,
      triggerRect.top - TOOLTIP_GAP - VIEWPORT_MARGIN,
    )
    const preferBelow = placement === 'below'
    const belowFits = belowSpace >= measuredHeight
    const aboveFits = aboveSpace >= measuredHeight
    const useBelow = preferBelow
      ? belowFits || belowSpace >= MIN_USEFUL_HEIGHT || belowSpace >= aboveSpace
      : belowFits || (!aboveFits && belowSpace >= aboveSpace)
    const availableHeight = useBelow ? belowSpace : aboveSpace
    const maxHeight = Math.max(
      0,
      Math.min(viewportHeight - VIEWPORT_MARGIN * 2, availableHeight),
    )
    const renderedHeight = Math.min(tooltipRect.height, maxHeight)
    const renderedWidth = Math.min(tooltipRect.width, maxWidth)
    const left = clamp(
      triggerRect.left,
      VIEWPORT_MARGIN,
      Math.max(VIEWPORT_MARGIN, viewportWidth - renderedWidth - VIEWPORT_MARGIN),
    )
    const top = useBelow
      ? triggerRect.bottom + TOOLTIP_GAP
      : Math.max(VIEWPORT_MARGIN, triggerRect.top - TOOLTIP_GAP - renderedHeight)

    setPosition({
      left,
      maxHeight,
      maxWidth,
      placement: useBelow ? 'below' : 'above',
      top,
    })
  }, [placement])

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
  }, [open, text, updatePosition])

  useEffect(() => {
    if (!open) return
    const reposition = () => updatePosition()
    window.addEventListener('resize', reposition)
    document.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      document.removeEventListener('scroll', reposition, true)
    }
  }, [open, updatePosition])

  useEffect(() => {
    if (enabled) return
    hide()
  }, [enabled, hide])

  useEffect(() => () => cancelClose(), [cancelClose])

  const tooltip = open && enabled
    ? createPortal(
        <span
          ref={tooltipRef}
          id={tooltipId}
          className="hover-detail-tooltip"
          role="tooltip"
          data-placement={position?.placement}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleHide}
          style={{
            left: position?.left ?? 0,
            maxHeight: position?.maxHeight,
            maxWidth: position?.maxWidth,
            top: position?.top ?? 0,
            visibility: position === undefined ? 'hidden' : 'visible',
          }}
        >
          {text}
        </span>,
        document.body,
      )
    : null

  return (
    <>
      <span
        ref={triggerRef}
        className={className}
        tabIndex={enabled ? 0 : undefined}
        data-tooltip-enabled={enabled || undefined}
        aria-describedby={open && enabled ? tooltipId : undefined}
        aria-label={ariaLabel ?? (enabled ? text : undefined)}
        onBlur={scheduleHide}
        onFocus={show}
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
      >
        <span className={visibleClassName}>{display ?? text}</span>
      </span>
      {tooltip}
    </>
  )
}
