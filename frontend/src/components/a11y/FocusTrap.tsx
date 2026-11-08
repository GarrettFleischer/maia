import { useEffect, useEffectEvent, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isolateModalBackground } from '@/components/a11y/modalIsolation'
import {
  modalFocusableElements,
  modalStack,
  type ModalStackEntry,
} from '@/components/a11y/modalStack'

type DialogLayer = 'base' | 'above'

const MODAL_KEY_HANDLED = Symbol('modal-key-handled')
type ModalKeyboardEvent = KeyboardEvent & { [MODAL_KEY_HANDLED]?: true }

export function FocusTrap({
  active,
  onClose,
  labelId,
  children,
  layer = 'base',
}: {
  active: boolean
  onClose: () => void
  labelId: string
  children: ReactNode
  layer?: DialogLayer
}) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const closeFromEffect = useEffectEvent(onClose)

  useEffect(() => {
    if (!active) {
      return
    }
    const container = containerRef.current
    const backdrop = backdropRef.current
    if (!container || !backdrop) {
      return
    }
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const restoreBackground = isolateModalBackground(backdrop)
    const entry: ModalStackEntry = {
      backdrop,
      container,
      trigger,
      lastFocused: null,
    }
    const unregister = modalStack.register(entry)
    const initialFocus = modalFocusableElements(container)[0] ?? container
    initialFocus.focus()
    modalStack.recordFocus(backdrop, initialFocus)

    const onKeyDown = (event: KeyboardEvent) => {
      const modalEvent = event as ModalKeyboardEvent
      if (modalEvent[MODAL_KEY_HANDLED] || !modalStack.isTop(backdrop)) return
      if (event.key === 'Escape') {
        modalEvent[MODAL_KEY_HANDLED] = true
        event.preventDefault()
        closeFromEffect()
        return
      }
      if (event.key !== 'Tab') return
      modalEvent[MODAL_KEY_HANDLED] = true
      const focusables = modalFocusableElements(container)
      if (focusables.length === 0) {
        event.preventDefault()
        container.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (!container.contains(document.activeElement)) {
        event.preventDefault()
        const boundary = event.shiftKey ? last : first
        boundary?.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }

    const onFocusIn = (event: FocusEvent) => {
      if (!modalStack.isTop(backdrop)) return
      if (event.target instanceof Node && !container.contains(event.target)) {
        const first = modalFocusableElements(container)[0] ?? container
        first.focus()
        return
      }
      modalStack.recordFocus(backdrop, event.target instanceof Element ? event.target : null)
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', onFocusIn)
      unregister()
      restoreBackground()
      modalStack.restorationTarget(trigger)?.focus()
    }
  }, [active])

  if (!active) {
    return null
  }

  const backdropClass =
    layer === 'above' ? 'maia-dialog-backdrop maia-dialog-backdrop--above' : 'maia-dialog-backdrop'
  return createPortal(
    <div
      ref={backdropRef}
      className={backdropClass}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && modalStack.isTop(event.currentTarget)) {
          onClose()
        }
      }}
    >
      <div
        ref={containerRef}
        className="maia-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={labelId}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
