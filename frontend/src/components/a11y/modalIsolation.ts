interface IsolationRecord {
  count: number
  inert: string | null
  ariaHidden: string | null
}

const isolatedElements = new WeakMap<HTMLElement, IsolationRecord>()

export function isolateModalBackground(backdrop: HTMLElement): () => void {
  const children = Array.from(document.body.children).filter(
    (element): element is HTMLElement => element instanceof HTMLElement,
  )
  const backdropIndex = children.indexOf(backdrop)
  const isolated = children.filter((element, index) => {
    if (element === backdrop) return false
    if (element.classList.contains('maia-dialog-backdrop') && index > backdropIndex) return false
    return true
  })

  for (const element of isolated) {
    const record = isolatedElements.get(element)
    if (record) {
      record.count += 1
      continue
    }
    isolatedElements.set(element, {
      count: 1,
      inert: element.getAttribute('inert'),
      ariaHidden: element.getAttribute('aria-hidden'),
    })
    element.setAttribute('inert', '')
    element.setAttribute('aria-hidden', 'true')
  }

  return () => {
    for (const element of isolated) {
      const record = isolatedElements.get(element)
      if (!record) continue
      record.count -= 1
      if (record.count > 0) continue
      if (record.inert === null) element.removeAttribute('inert')
      else element.setAttribute('inert', record.inert)
      if (record.ariaHidden === null) element.removeAttribute('aria-hidden')
      else element.setAttribute('aria-hidden', record.ariaHidden)
      isolatedElements.delete(element)
    }
  }
}
