import { useEffect, useId, useRef, useState } from 'react'

const mermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'dark',
  fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif",
} as const

export function MermaidDiagram({ source }: { source: string }) {
  const host = useRef<HTMLDivElement>(null)
  const reactId = useId().replace(/:/g, '')
  const draw = useRef(0)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const container = host.current
    if (!container) return
    let cancelled = false
    const id = `maia-mermaid-${reactId}-${++draw.current}`
    setFailed(false)
    container.replaceChildren()

    void import('mermaid')
      .then((mod) => {
        mod.default.initialize(mermaidConfig)
        return mod.default.render(id, source, container)
      })
      .then((result) => {
        if (cancelled || !host.current) return
        const parsed = new DOMParser().parseFromString(result.svg, 'image/svg+xml')
        const graphic = parsed.documentElement
        if (graphic.nodeName.toLowerCase() !== 'svg') {
          setFailed(true)
          return
        }
        host.current.replaceChildren(host.current.ownerDocument.importNode(graphic, true))
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
      .finally(() => {
        document.getElementById(`d${id}`)?.remove()
      })

    return () => {
      cancelled = true
      document.getElementById(`d${id}`)?.remove()
    }
  }, [reactId, source])

  return (
    <div className="maia-mermaid" data-diagram="mermaid" ref={host}>
      {failed ? (
        <>
          <p className="maia-mermaid-error">The diagram could not be drawn.</p>
          <pre>
            <code>{source}</code>
          </pre>
        </>
      ) : null}
    </div>
  )
}
