import { memo, useMemo, useRef, useState } from 'react'
import { NODE_KINDS, plural, type MapNode, type SystemMap } from '../../../shared/sysmap'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { EDGE_VERB, KINDS, freshLabel, matches, useRects, type Fresh, type Rect, type Selection } from './kinds'
import { FreshBadge } from './parts'

interface End {
  x: number
  y: number
  /** Which way the line leaves the card: 1 below it, -1 above it. */
  dir: 1 | -1
}

/** A curve from one card to another: out of the bottom when the target is lower, out of the top when it is higher, under both when they share a row. */
function route(a: Rect, b: Rect): { d: string; from: End; to: End } {
  const ax = a.x + a.w / 2
  const bx = b.x + b.w / 2
  // Lines leave a little off-centre, towards where they are going, so several from one card fan out.
  const lean = (from: number, to: number, w: number): number => Math.max(-w * 0.32, Math.min(w * 0.32, (to - from) / 7))
  const sx = ax + lean(ax, bx, a.w)
  const tx = bx + lean(bx, ax, b.w)
  if (b.y >= a.y + a.h - 1) {
    const sy = a.y + a.h
    const ty = b.y
    const k = Math.max(16, (ty - sy) * 0.5)
    return { d: `M${sx} ${sy} C${sx} ${sy + k} ${tx} ${ty - k} ${tx} ${ty}`, from: { x: sx, y: sy, dir: 1 }, to: { x: tx, y: ty, dir: -1 } }
  }
  if (a.y >= b.y + b.h - 1) {
    const sy = a.y
    const ty = b.y + b.h
    const k = Math.max(16, (sy - ty) * 0.5)
    return { d: `M${sx} ${sy} C${sx} ${sy - k} ${tx} ${ty + k} ${tx} ${ty}`, from: { x: sx, y: sy, dir: -1 }, to: { x: tx, y: ty, dir: 1 } }
  }
  const sy = a.y + a.h
  const ty = b.y + b.h
  const dip = Math.min(30, 16 + Math.abs(tx - sx) / 24)
  return { d: `M${sx} ${sy} C${sx} ${sy + dip} ${tx} ${ty + dip} ${tx} ${ty}`, from: { x: sx, y: sy, dir: 1 }, to: { x: tx, y: ty, dir: 1 } }
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

function EdgeLabel({ at, text }: { at: End; text: string }) {
  return (
    <text
      x={at.x}
      y={at.dir === 1 ? at.y + 15 : at.y - 7}
      textAnchor="middle"
      className="fill-foreground text-[10.5px] font-medium"
      style={{ paintOrder: 'stroke', stroke: 'var(--color-background)', strokeWidth: 4, strokeLinejoin: 'round' }}
    >
      {clip(text, 36)}
    </text>
  )
}

/**
 * The system as layers: ways in at the top, the services and jobs that do the work in the middle,
 * the stores and outside services they lean on at the bottom, with a line for everything one part
 * does to another. Picking a part lights up its connections; picking a feature lights up its path.
 */
export const SystemView = memo(function SystemView({
  map,
  selection,
  onSelect,
  fresh,
  query,
  connections
}: {
  map: SystemMap
  selection: Selection
  onSelect: (s: Selection) => void
  fresh: Fresh
  query: string
  /** Whether to draw every connection faintly, or only those of the part in focus. */
  connections: boolean
}) {
  const container = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const { rects, width, height } = useRects(container, [map])

  const feature = selection?.type === 'feature' ? map.features.find((f) => f.id === selection.id) : undefined
  const selectedNode = selection?.type === 'node' ? selection.id : null
  // Pointing at a part shows its connections for as long as the pointer stays, whatever is picked.
  const focus = hovered ?? (feature ? null : selectedNode)
  const mode: 'node' | 'feature' | 'idle' = focus ? 'node' : feature ? 'feature' : 'idle'

  /** For the picked feature: at which of its steps each component acts. */
  const steps = useMemo(() => {
    const at = new Map<string, number[]>()
    feature?.steps.forEach((s, i) => at.set(s.node, [...(at.get(s.node) ?? []), i + 1]))
    return at
  }, [feature])
  /** The feature's path: one hop for each time the work moves from one component to another. */
  const hops = useMemo(() => {
    const seen = new Set<string>()
    const list: { from: string; to: string }[] = []
    feature?.steps.forEach((s, i) => {
      const next = feature.steps[i + 1]
      if (!next || next.node === s.node || seen.has(`${s.node}>${next.node}`)) return
      seen.add(`${s.node}>${next.node}`)
      list.push({ from: s.node, to: next.node })
    })
    return list
  }, [feature])
  const lit = useMemo<Set<string> | null>(() => {
    if (mode === 'node') return new Set([focus!, ...map.edges.flatMap((e) => (e.from === focus ? [e.to] : e.to === focus ? [e.from] : []))])
    if (mode === 'feature') return new Set(steps.keys())
    return null
  }, [mode, focus, map.edges, steps])
  // Worked out when the map or the search changes, not on every hover.
  const hidden = useMemo(
    () => new Set(map.nodes.filter((n) => !matches(query, n.name, n.summary, n.tech, n.paths, n.contents.map((i) => i.name))).map((n) => n.id)),
    [map.nodes, query]
  )
  /** Each connection's curve, worked out again only when the cards move. */
  const routes = useMemo(() => {
    const out = new Map<string, ReturnType<typeof route>>()
    const add = (from: string, to: string): void => {
      const a = rects[from]
      const b = rects[to]
      if (a && b && !out.has(`${from}>${to}`)) out.set(`${from}>${to}`, route(a, b))
    }
    for (const e of map.edges) add(e.from, e.to)
    for (const f of map.features) f.steps.forEach((s, i) => f.steps[i + 1] && add(s.node, f.steps[i + 1].node))
    return out
  }, [rects, map.edges, map.features])
  const featuresThrough = useMemo(() => {
    const count = new Map<string, number>()
    for (const f of map.features) for (const id of new Set(f.steps.map((s) => s.node))) count.set(id, (count.get(id) ?? 0) + 1)
    return count
  }, [map.features])

  const card = (n: MapNode) => {
    const kind = KINDS[n.kind]
    const picked = selectedNode === n.id
    const dim = (lit && !lit.has(n.id)) || hidden.has(n.id)
    // A store shows its tables, an app its screens: the first few by name, the rest counted.
    const shown = n.contents.slice(0, n.kind === 'data' ? 4 : 3)
    const through = featuresThrough.get(n.id) ?? 0
    return (
      <Button
        key={n.id}
        variant="outline"
        data-rect={n.id}
        title={n.name}
        aria-pressed={picked}
        onClick={() => onSelect(picked ? null : { type: 'node', id: n.id })}
        onMouseEnter={() => setHovered(n.id)}
        onMouseLeave={() => setHovered((h) => (h === n.id ? null : h))}
        className={cn(
          'relative h-auto w-full flex-col items-stretch justify-start gap-1 bg-card p-2.5 text-left font-normal whitespace-normal shadow-none transition-[opacity,box-shadow,border-color] dark:bg-card',
          kind.border,
          picked && 'border-primary ring-2 ring-primary/40',
          dim && 'opacity-30'
        )}
      >
        <span className="flex items-center gap-1.5">
          <kind.Icon className={cn('size-3.5', kind.text)} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{n.name}</span>
          <FreshBadge label={freshLabel(fresh, 'node', n.id)} className="px-1.5 py-0 text-[10px]" />
        </span>
        <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">{n.summary}</span>
        {shown.length > 0 && (
          <span className="flex flex-wrap items-center gap-1 py-0.5">
            {shown.map((i) => (
              <span key={i.name} className={cn('max-w-[9.5rem] truncate rounded px-1 py-px font-mono text-[10px]', kind.bg, kind.text)} title={i.note}>
                {i.name}
              </span>
            ))}
            {n.contents.length > shown.length && <span className="text-[10px] text-muted-foreground">+{n.contents.length - shown.length}</span>}
          </span>
        )}
        {(n.tech || through > 0) && (
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground/80">
            <span className="min-w-0 flex-1 truncate">{n.tech}</span>
            {through > 0 && <span className="shrink-0">{plural(through, 'feature')}</span>}
          </span>
        )}
        {steps.has(n.id) && mode === 'feature' && (
          <span className="absolute -top-2.5 -right-2 flex gap-0.5" aria-label={`Step ${steps.get(n.id)!.join(' and ')} of ${feature!.name}`}>
            {steps.get(n.id)!.map((i) => (
              <span key={i} className="grid size-5 place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground shadow-sm">
                {i}
              </span>
            ))}
          </span>
        )}
      </Button>
    )
  }

  return (
    <div ref={container} className="relative grid gap-4">
      {/* Every connection, faintly, behind the cards: they show in the gaps and never cross a card's text. */}
      {connections && (
        <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width={width} height={height} aria-hidden>
          {map.edges.map((e) => {
            const r = routes.get(`${e.from}>${e.to}`)
            if (!r || (mode === 'node' && (e.from === focus || e.to === focus))) return null
            return (
              <path
                key={`${e.from}>${e.to}`}
                d={r.d}
                fill="none"
                markerEnd="url(#map-arrow)"
                strokeWidth={1}
                className={cn('stroke-muted-foreground transition-opacity', mode === 'idle' ? 'opacity-35' : 'opacity-10')}
              />
            )
          })}
        </svg>
      )}
      {NODE_KINDS.map((k) => {
        const kind = KINDS[k]
        const nodes = map.nodes.filter((n) => n.kind === k)
        return (
          <section key={k} aria-label={kind.plural} className={cn('relative rounded-xl border bg-muted/40 px-3.5 pt-2.5', nodes.length ? 'pb-7' : 'pb-2.5')}>
            <header className={cn('flex flex-wrap items-baseline gap-x-2', nodes.length > 0 && 'mb-2.5')}>
              <h3 className={cn('flex items-center gap-1.5 text-xs font-semibold', kind.text)}>
                <kind.Icon className="size-3.5" aria-hidden />
                {kind.plural}
                {nodes.length > 0 && <span className="font-normal opacity-70">{nodes.length}</span>}
              </h3>
              <p className="text-[11px] text-muted-foreground">{nodes.length ? kind.hint : 'None found on this branch.'}</p>
            </header>
            {nodes.length > 0 && <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] content-start gap-x-3 gap-y-8">{nodes.map(card)}</div>}
          </section>
        )
      })}

      {/* The connections of the part in focus, or the picked feature's path, in front of everything. */}
      <svg className="pointer-events-none absolute top-0 left-0 z-10 overflow-visible" width={width} height={height} aria-hidden>
        <defs>
          <marker id="map-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0.8 L7.5 4 L0 7.2 z" fill="context-stroke" />
          </marker>
        </defs>
        {map.edges.map((e) => {
          const r = routes.get(`${e.from}>${e.to}`)
          const out = mode === 'node' && e.from === focus
          const into = mode === 'node' && e.to === focus
          if (!r || (!out && !into)) return null
          const { d, from, to } = r
          const text = `${EDGE_VERB[e.kind]}${e.label ? `: ${e.label}` : ''}`
          return (
            <g key={`${e.from}>${e.to}`}>
              <path
                d={d}
                fill="none"
                markerEnd="url(#map-arrow)"
                strokeWidth={1.6}
                className={out ? 'stroke-primary' : 'stroke-foreground/60'}
              />
              {/* Named at the far end, so the labels of one part's connections do not pile up on it. */}
              {out && <EdgeLabel at={to} text={text} />}
              {into && <EdgeLabel at={from} text={text} />}
            </g>
          )
        })}
        {mode === 'feature' &&
          hops.map((h) => {
            const r = routes.get(`${h.from}>${h.to}`)
            if (!r) return null
            return <path key={`${h.from}>${h.to}`} d={r.d} fill="none" markerEnd="url(#map-arrow)" strokeWidth={1.8} strokeDasharray="5 4" className="stroke-primary" />
          })}
      </svg>
    </div>
  )
})
