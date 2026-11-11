import { Children, isValidElement, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MermaidDiagram } from '@/components/shell/MermaidDiagram'

const markdownComponents = {
  a: MarkdownLink,
  code: MarkdownCode,
  input: MarkdownInput,
  pre: MarkdownPre,
}

export function MarkdownMessage({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </Markdown>
    </div>
  )
}

function linkText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child)
      if (isValidElement<{ children?: ReactNode }>(child)) return linkText(child.props.children)
      return ''
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href) return <>{children}</>
  const external = /^https?:\/\//i.test(href)
  const name = external ? `${linkText(children)} (opens in a new tab)` : undefined
  return (
    <a href={href} target="_blank" rel="noreferrer" aria-label={name}>
      {children}
    </a>
  )
}

function MarkdownCode({ className, children }: { className?: string; children?: ReactNode }) {
  const language = /language-([\w-]+)/.exec(className ?? '')?.[1]
  if (language === 'mermaid') {
    return <MermaidDiagram source={String(children).replace(/\n$/, '')} />
  }
  return <code className={className}>{children}</code>
}

function MarkdownInput({ type, checked }: { type?: string; checked?: boolean }) {
  return <input type={type} checked={checked ?? false} disabled readOnly />
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  const first = Children.toArray(children)[0]
  if (isMermaidNode(first)) return first
  return <pre>{children}</pre>
}

function isMermaidNode(node: ReactNode): boolean {
  return (
    isValidElement<{ 'data-diagram'?: string }>(node) && node.props['data-diagram'] === 'mermaid'
  )
}
