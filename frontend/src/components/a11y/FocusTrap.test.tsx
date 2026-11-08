import { StrictMode, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FocusTrap } from '@/components/a11y/FocusTrap'

function ModalHarness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div data-testid="background">
        <button type="button" onClick={() => setOpen(true)}>
          Open drawer
        </button>
      </div>
      <FocusTrap active={open} onClose={() => setOpen(false)} labelId="test-dialog-title">
        <h2 id="test-dialog-title">Test dialog</h2>
        <button type="button">First action</button>
        <button type="button">Last action</button>
      </FocusTrap>
    </>
  )
}

function ReplacementHarness({ first, second }: { first: boolean; second: boolean }) {
  return (
    <>
      <div data-testid="background">Application background</div>
      {first ? (
        <FocusTrap active onClose={() => undefined} labelId="first-title">
          <h2 id="first-title">First dialog</h2>
          <button type="button">First close</button>
        </FocusTrap>
      ) : null}
      {second ? (
        <FocusTrap active onClose={() => undefined} labelId="second-title" layer="above">
          <h2 id="second-title">Second dialog</h2>
          <button type="button">Second close</button>
        </FocusTrap>
      ) : null}
    </>
  )
}

function StackedModalHarness() {
  const [outerOpen, setOuterOpen] = useState(false)
  const [innerOpen, setInnerOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOuterOpen(true)}>
        Open outer
      </button>
      <FocusTrap
        active={outerOpen}
        onClose={() => setOuterOpen(false)}
        labelId="outer-title"
      >
        <h2 id="outer-title">Outer dialog</h2>
        <button type="button" onClick={() => setInnerOpen(true)}>
          Open inner
        </button>
        <button type="button">Outer last</button>
        <FocusTrap
          active={innerOpen}
          onClose={() => setInnerOpen(false)}
          labelId="inner-title"
          layer="above"
        >
          <h2 id="inner-title">Inner dialog</h2>
          <button type="button">Inner first</button>
          <button type="button">Inner last</button>
        </FocusTrap>
      </FocusTrap>
    </>
  )
}

function DynamicModalHarness() {
  const [open, setOpen] = useState(false)
  const [extra, setExtra] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dynamic
      </button>
      <FocusTrap active={open} onClose={() => setOpen(false)} labelId="dynamic-title">
        <h2 id="dynamic-title">Dynamic dialog</h2>
        <button type="button" onClick={() => setExtra(true)}>
          Add action
        </button>
        <button type="button">Existing last</button>
        {extra ? <button type="button">Dynamic last</button> : null}
      </FocusTrap>
    </>
  )
}

function ReplacementInteractionHarness() {
  const [outerOpen, setOuterOpen] = useState(false)
  const [top, setTop] = useState<'none' | 'first' | 'second'>('none')
  return (
    <>
      <button type="button" onClick={() => setOuterOpen(true)}>
        Open replacement outer
      </button>
      <FocusTrap
        active={outerOpen}
        onClose={() => setOuterOpen(false)}
        labelId="replacement-outer-title"
      >
        <h2 id="replacement-outer-title">Replacement outer</h2>
        <button type="button">Outer fallback</button>
        {top === 'none' ? (
          <button type="button" onClick={() => setTop('first')}>
            Open replaceable top
          </button>
        ) : null}
        {top === 'first' ? (
          <FocusTrap
            key="first"
            active
            onClose={() => setTop('none')}
            labelId="first-replacement-title"
            layer="above"
          >
            <h2 id="first-replacement-title">First replacement</h2>
            <button type="button" onClick={() => setTop('second')}>
              Replace top
            </button>
          </FocusTrap>
        ) : null}
        {top === 'second' ? (
          <FocusTrap
            key="second"
            active
            onClose={() => setTop('none')}
            labelId="second-replacement-title"
            layer="above"
          >
            <h2 id="second-replacement-title">Second replacement</h2>
            <button type="button">Second replacement action</button>
          </FocusTrap>
        ) : null}
      </FocusTrap>
    </>
  )
}

describe('FocusTrap modal boundary', () => {
  it('makes background inert and restores it with exact trigger focus on Escape and backdrop', async () => {
    const user = userEvent.setup()
    render(<ModalHarness />)
    const trigger = screen.getByRole('button', { name: 'Open drawer' })
    const background = screen.getByTestId('background')

    await user.click(trigger)
    expect(background.closest('[inert]')).not.toBeNull()
    expect(background.closest('[aria-hidden="true"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'First action' })).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Test dialog' })).not.toBeInTheDocument()
    expect(background.closest('[inert]')).toBeNull()
    expect(background.closest('[aria-hidden="true"]')).toBeNull()
    expect(trigger).toHaveFocus()

    await user.click(trigger)
    await user.click(document.querySelector('.maia-dialog-backdrop')!)
    expect(screen.queryByRole('dialog', { name: 'Test dialog' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('keeps background isolated across nested replacement and restores it on cleanup', () => {
    const { rerender } = render(
      <StrictMode>
        <ReplacementHarness first second={false} />
      </StrictMode>,
    )
    const background = screen.getByTestId('background')
    expect(background.closest('[inert]')).not.toBeNull()

    rerender(
      <StrictMode>
        <ReplacementHarness first second />
      </StrictMode>,
    )
    expect(background.closest('[inert]')).not.toBeNull()

    rerender(
      <StrictMode>
        <ReplacementHarness first={false} second />
      </StrictMode>,
    )
    expect(background.closest('[inert]')).not.toBeNull()
    expect(screen.getByRole('dialog', { name: 'Second dialog' })).not.toHaveAttribute(
      'aria-hidden',
    )

    rerender(
      <StrictMode>
        <ReplacementHarness first={false} second={false} />
      </StrictMode>,
    )
    expect(background.closest('[inert]')).toBeNull()
    expect(background.closest('[aria-hidden="true"]')).toBeNull()
  })

  it('lets only the top trap own backdrop and Escape while restoring through the stack', async () => {
    const user = userEvent.setup()
    render(<StackedModalHarness />)
    const originalTrigger = screen.getByRole('button', { name: 'Open outer' })

    await user.click(originalTrigger)
    const innerTrigger = screen.getByRole('button', { name: 'Open inner' })
    await user.click(innerTrigger)
    expect(screen.getByRole('dialog', { name: 'Inner dialog' })).toBeVisible()

    const backdrops = document.querySelectorAll<HTMLElement>('.maia-dialog-backdrop')
    await user.click(backdrops[0]!)
    expect(screen.getByRole('dialog', { name: 'Outer dialog', hidden: true })).toBeVisible()
    expect(screen.getByRole('dialog', { name: 'Inner dialog' })).toBeVisible()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Inner dialog' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Outer dialog' })).toBeVisible()
    expect(innerTrigger).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Outer dialog' })).not.toBeInTheDocument()
    expect(originalTrigger).toHaveFocus()
  })

  it('includes dynamically added controls in forward and reverse tab wrapping', async () => {
    const user = userEvent.setup()
    render(<DynamicModalHarness />)
    await user.click(screen.getByRole('button', { name: 'Open dynamic' }))
    const first = screen.getByRole('button', { name: 'Add action' })
    await user.click(first)
    const dynamicLast = screen.getByRole('button', { name: 'Dynamic last' })

    dynamicLast.focus()
    await user.keyboard('{Tab}')
    expect(first).toHaveFocus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(dynamicLast).toHaveFocus()
  })

  it('defers disconnected replacement focus to the nearest connected modal target', async () => {
    const user = userEvent.setup()
    render(<ReplacementInteractionHarness />)
    const originalTrigger = screen.getByRole('button', { name: 'Open replacement outer' })

    await user.click(originalTrigger)
    await user.click(screen.getByRole('button', { name: 'Open replaceable top' }))
    await user.click(screen.getByRole('button', { name: 'Replace top' }))
    expect(screen.getByRole('button', { name: 'Second replacement action' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Second replacement' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Replacement outer' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Outer fallback' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(originalTrigger).toHaveFocus()
  })

  it('restores exact pre-existing inert and aria-hidden attributes after nested cleanup', () => {
    const existing = document.createElement('section')
    existing.setAttribute('inert', 'legacy')
    existing.setAttribute('aria-hidden', 'false')
    document.body.append(existing)
    try {
      const { rerender } = render(<ReplacementHarness first second />)
      expect(existing).toHaveAttribute('inert', '')
      expect(existing).toHaveAttribute('aria-hidden', 'true')

      rerender(<ReplacementHarness first={false} second={false} />)
      expect(existing).toHaveAttribute('inert', 'legacy')
      expect(existing).toHaveAttribute('aria-hidden', 'false')
    } finally {
      existing.remove()
    }
  })

  it('uses the latest onClose callback after an active rerender', async () => {
    const user = userEvent.setup()
    const firstClose = vi.fn()
    const latestClose = vi.fn()
    const modal = (onClose: () => void) => (
      <FocusTrap active onClose={onClose} labelId="callback-title">
        <h2 id="callback-title">Callback dialog</h2>
        <button type="button">Callback action</button>
      </FocusTrap>
    )
    const { rerender } = render(modal(firstClose))

    rerender(modal(latestClose))
    await user.keyboard('{Escape}')

    expect(firstClose).not.toHaveBeenCalled()
    expect(latestClose).toHaveBeenCalledOnce()
  })
})
