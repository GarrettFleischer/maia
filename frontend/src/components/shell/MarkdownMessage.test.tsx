import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownMessage } from '@/components/shell/MarkdownMessage'

const initialize = vi.hoisted(() => vi.fn())
const renderDiagram = vi.hoisted(() =>
  vi.fn(async () => ({
    svg: '<svg xmlns="http://www.w3.org/2000/svg" data-testid="diagram"></svg>',
  })),
)

vi.mock('mermaid', () => ({
  default: {
    initialize,
    render: renderDiagram,
  },
}))

const toolReply =
  "I'm the coordinator — I don't do the work myself, I hand it off. My tools: - **spawn_task** – kick off a new subagent."

describe('MarkdownMessage', () => {
  beforeEach(() => {
    initialize.mockClear()
    renderDiagram.mockReset()
    renderDiagram.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" data-testid="diagram"></svg>',
    })
  })

  it('renders strong text with the markdown library and leaves the markers out', () => {
    render(<MarkdownMessage text={toolReply} />)

    expect(screen.getByText('spawn_task').tagName).toBe('STRONG')
    expect(screen.queryByText(/\*\*spawn_task\*\*/)).toBeNull()
    expect(screen.getByText(/kick off a new subagent/)).toBeInTheDocument()
  })

  it('shows html as text and does not create a script element', () => {
    const source = '<script>globalThis.compromised = true</script>'
    const { container } = render(<MarkdownMessage text={source} className="maia-transcript-body" />)

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('.maia-transcript-body')?.textContent).toBe(source)
  })

  it('links https urls and drops a javascript url', () => {
    render(
      <MarkdownMessage text="see [docs](https://example.com/maia) and [x](javascript:alert(1))" />,
    )

    expect(screen.getByRole('link', { name: 'docs (opens in a new tab)' })).toHaveAttribute(
      'href',
      'https://example.com/maia',
    )
    expect(screen.queryByRole('link', { name: 'x' })).toBeNull()
    expect(document.body.innerHTML).not.toContain('javascript:')
  })

  it('renders a gfm table and a disabled task checkbox', () => {
    render(<MarkdownMessage text={'| A | B |\n| - | - |\n| 1 | 2 |\n\n- [ ] open'} />)

    expect(screen.getByRole('cell', { name: '1' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeDisabled()
  })

  it('draws a mermaid fence with the strict diagram renderer', async () => {
    render(<MarkdownMessage text={'```mermaid\ngraph TD\n  A-->B\n```'} />)

    expect(await screen.findByTestId('diagram')).toBeInTheDocument()
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict' }))
    expect(renderDiagram).toHaveBeenCalledWith(
      expect.any(String),
      'graph TD\n  A-->B',
      expect.any(HTMLElement),
    )
  })

  it('keeps the diagram source visible when mermaid cannot draw it', async () => {
    renderDiagram.mockRejectedValue(new Error('bad diagram'))
    render(<MarkdownMessage text={'```mermaid\ngraph TD\n  A-->B\n```'} />)

    expect(await screen.findByText('The diagram could not be drawn.')).toBeInTheDocument()
    expect(screen.getByText(/graph TD/)).toBeInTheDocument()
    await waitFor(() => expect(renderDiagram).toHaveBeenCalled())
  })
})
