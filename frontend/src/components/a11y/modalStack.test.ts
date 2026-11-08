import { afterEach, describe, expect, it } from 'vitest'
import { modalFocusableElements } from '@/components/a11y/modalStack'

const mounted: HTMLElement[] = []

afterEach(() => {
  for (const element of mounted.splice(0)) element.remove()
})

describe('modalFocusableElements', () => {
  it('keeps only visible enabled controls with non-negative resolved tab order', () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <button id="visible">Visible</button>
      <button id="inactive-tab" tabindex="-1">Inactive tab</button>
      <button id="disabled" disabled>Disabled</button>
      <button id="display-none" style="display:none">Display none</button>
      <div hidden><button id="hidden-ancestor">Hidden ancestor</button></div>
      <div inert><button id="inert-ancestor">Inert ancestor</button></div>
      <div aria-hidden="true"><button id="aria-hidden-ancestor">Aria hidden ancestor</button></div>
      <details>
        <summary id="closed-summary">Closed summary</summary>
        <button id="closed-details">Closed details</button>
      </details>
      <fieldset disabled>
        <legend><button id="legend-control">Legend control</button></legend>
        <button id="disabled-fieldset">Disabled fieldset</button>
      </fieldset>
    `
    document.body.append(container)
    mounted.push(container)

    expect(modalFocusableElements(container).map((element) => element.id)).toEqual([
      'visible',
      'closed-summary',
      'legend-control',
    ])
  })
})
