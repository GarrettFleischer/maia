const FOCUSABLE_SELECTOR =
  'button, summary, [href], input, select, textarea, [contenteditable="true"], [tabindex]'

export interface ModalStackEntry {
  backdrop: HTMLElement
  container: HTMLElement
  trigger: HTMLElement | null
  lastFocused: HTMLElement | null
}

export function isRestorableFocusTarget(target: Element | null): target is HTMLElement {
  if (!(target instanceof HTMLElement) || !target.isConnected) return false
  if (target === document.body || target === document.documentElement) return false
  if (target.closest('[inert], [aria-hidden="true"], [hidden]')) return false
  return true
}

export function modalFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled') &&
      isModalElementVisible(element, container),
  )
}

export function isModalElementVisible(
  element: HTMLElement,
  container: HTMLElement,
): boolean {
  if (
    typeof element.checkVisibility === 'function' &&
    !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  ) {
    return false
  }
  let current: HTMLElement | null = element
  while (current) {
    if (current.hasAttribute('hidden') || current.hasAttribute('inert')) return false
    if (current.getAttribute('aria-hidden') === 'true') return false
    const style = getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return false
    }
    if (current instanceof HTMLDetailsElement && !current.open) {
      const summary = Array.from(current.children).find(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && child.tagName === 'SUMMARY',
      )
      if (!summary?.contains(element)) return false
    }
    if (current === container) return true
    current = current.parentElement
  }
  return false
}

export class ModalStackRegistry {
  readonly #entries: ModalStackEntry[] = []

  register(entry: ModalStackEntry): () => void {
    this.#entries.push(entry)
    let registered = true
    return () => {
      if (!registered) return
      registered = false
      const index = this.#entries.lastIndexOf(entry)
      if (index >= 0) this.#entries.splice(index, 1)
    }
  }

  isTop(backdrop: HTMLElement): boolean {
    return this.#entries.at(-1)?.backdrop === backdrop
  }

  recordFocus(backdrop: HTMLElement, target: Element | null): void {
    const entry = this.#entries.find((candidate) => candidate.backdrop === backdrop)
    if (!entry || !isRestorableFocusTarget(target) || !entry.container.contains(target)) return
    entry.lastFocused = target
  }

  restorationTarget(trigger: Element | null): HTMLElement | null {
    if (isRestorableFocusTarget(trigger)) return trigger
    const underlying = this.#entries.at(-1)
    if (!underlying) return null
    if (
      isRestorableFocusTarget(underlying.lastFocused) &&
      underlying.container.contains(underlying.lastFocused)
    ) {
      return underlying.lastFocused
    }
    return (
      modalFocusableElements(underlying.container)[0] ??
      (isRestorableFocusTarget(underlying.container) ? underlying.container : null)
    )
  }
}

export const modalStack = new ModalStackRegistry()
