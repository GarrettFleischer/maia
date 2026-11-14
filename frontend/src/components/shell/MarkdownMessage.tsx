import { Children, isValidElement, useEffect, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MermaidDiagram } from '@/components/shell/MermaidDiagram'
import { copyText } from '@/lib/copyText'

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

function fenceText(children: ReactNode): string {
  const first = Children.toArray(children)[0]
  if (isValidElement<{ children?: ReactNode }>(first)) {
    return String(first.props.children ?? '').replace(/\n$/, '')
  }
  return String(children ?? '').replace(/\n$/, '')
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  const first = Children.toArray(children)[0]
  if (isMermaidNode(first)) return first
  return <CodeBlock text={fenceText(children)}>{children}</CodeBlock>
}

function CodeBlock({ text, children }: { text: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <div className="maia-code-block">
      <div className="maia-code-toolbar">
        <button
          type="button"
          className="maia-btn"
          aria-label="Copy code"
          onClick={() => {
            const clipboard = globalThis.navigator?.clipboard
            if (!clipboard) return
            void copyText(text, clipboard).then((result) => {
              if (result === 'copied') setCopied(true)
            })
          }}
        >
          Copy
        </button>
        {copied ? <span role="status">Copied</span> : null}
      </div>
      <pre>{children}</pre>
    </div>
  )
}

function isMermaidNode(node: ReactNode): boolean {
  return (
    isValidElement<{ 'data-diagram'?: string }>(node) && node.props['data-diagram'] === 'mermaid'
  )
}
