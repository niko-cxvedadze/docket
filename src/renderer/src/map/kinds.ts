import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { Boxes, Cloud, Database, DoorOpen, Timer, type LucideIcon } from 'lucide-react'
import type { MapEdgeKind, MapFeature, MapNodeKind, SystemMap } from '../../../shared/sysmap'

/** What is picked on the map: a component of the system, or a feature that runs through it. */
export type Selection = { type: 'node' | 'feature'; id: string } | null

export interface KindStyle {
  label: string
  plural: string
  hint: string
  Icon: LucideIcon
  text: string
  bg: string
  border: string
  dot: string
  /** The same colour for SVG strokes. */
  color: string
}

export const KINDS: Record<MapNodeKind, KindStyle> = {
  entry: {
    label: 'Entry point',
    plural: 'Entry points',
    hint: 'How people and other systems get in',
    Icon: DoorOpen,
    text: 'text-kind-entry',
    bg: 'bg-kind-entry/10',
    border: 'border-kind-entry/35',
    dot: 'bg-kind-entry',
    color: 'var(--color-kind-entry)'
  },
  service: {
    label: 'Service',
    plural: 'Services',
    hint: 'The building blocks that do the work',
    Icon: Boxes,
    text: 'text-kind-service',
    bg: 'bg-kind-service/10',
    border: 'border-kind-service/35',
    dot: 'bg-kind-service',
    color: 'var(--color-kind-service)'
  },
  job: {
    label: 'Background job',
    plural: 'Background jobs',
    hint: 'Work that runs on a schedule or a queue',
    Icon: Timer,
    text: 'text-kind-job',
    bg: 'bg-kind-job/10',
    border: 'border-kind-job/35',
    dot: 'bg-kind-job',
    color: 'var(--color-kind-job)'
  },
  data: {
    label: 'Data store',
    plural: 'Data stores',
    hint: 'Where the system keeps its state',
    Icon: Database,
    text: 'text-kind-data',
    bg: 'bg-kind-data/10',
    border: 'border-kind-data/35',
    dot: 'bg-kind-data',
    color: 'var(--color-kind-data)'
  },
  external: {
    label: 'Outside service',
    plural: 'Outside services',
    hint: 'Systems it talks to but does not own',
    Icon: Cloud,
    text: 'text-kind-external',
    bg: 'bg-kind-external/10',
    border: 'border-kind-external/35',
    dot: 'bg-kind-external',
    color: 'var(--color-kind-external)'
  }
}

export const EDGE_VERB: Record<MapEdgeKind, string> = {
  uses: 'uses',
  reads: 'reads',
  writes: 'writes to',
  reads_writes: 'reads and writes',
  triggers: 'triggers'
}

/** What the last update added or changed, so the map can point at it. Empty after a full scan. */
export interface Fresh {
  added: Set<string>
  changed: Set<string>
}

export function freshOf(map: SystemMap | null): Fresh {
  const last = map?.history[0]
  const keys = (refs: { type: string; id: string }[]): Set<string> => new Set(refs.map((r) => `${r.type}:${r.id}`))
  return last?.kind === 'update' ? { added: keys(last.added), changed: keys(last.changed) } : { added: new Set(), changed: new Set() }
}

export const freshLabel = (fresh: Fresh, type: 'node' | 'feature', id: string): 'New' | 'Changed' | null =>
  fresh.added.has(`${type}:${id}`) ? 'New' : fresh.changed.has(`${type}:${id}`) ? 'Changed' : null

/** Whether a feature's path passes through a component. */
export const runsThrough = (f: MapFeature, nodeId: string): boolean => f.steps.some((s) => s.node === nodeId)

/** The features by product area, areas in the order they first appear. */
export function areasOf(features: MapFeature[]): { name: string; features: MapFeature[] }[] {
  const grouped = new Map<string, MapFeature[]>()
  for (const f of features) grouped.set(f.area, [...(grouped.get(f.area) ?? []), f])
  return [...grouped].map(([name, features]) => ({ name, features }))
}

export const matches = (query: string, ...fields: (string | string[])[]): boolean => {
  const q = query.trim().toLowerCase()
  return !q || fields.some((f) => (Array.isArray(f) ? f.join(' ') : f).toLowerCase().includes(q))
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Where every element marked `data-rect="<id>"` sits inside the container, so lines can be drawn
 * between them over a layout the browser did. Measured again whenever the container changes size
 * or `deps` change.
 */
export function useRects(container: RefObject<HTMLElement | null>, deps: unknown[]): { rects: Record<string, Rect>; width: number; height: number } {
  const [state, setState] = useState<{ rects: Record<string, Rect>; width: number; height: number; key: string }>({ rects: {}, width: 0, height: 0, key: '' })
  const measure = useCallback(() => {
    const el = container.current
    if (!el) return
    const base = el.getBoundingClientRect()
    const rects: Record<string, Rect> = {}
    el.querySelectorAll<HTMLElement>('[data-rect]').forEach((node) => {
      const r = node.getBoundingClientRect()
      const round = (n: number): number => Math.round(n * 2) / 2
      rects[node.dataset.rect!] = { x: round(r.left - base.left), y: round(r.top - base.top), w: round(r.width), h: round(r.height) }
    })
    const next = { rects, width: el.scrollWidth, height: el.scrollHeight }
    const key = JSON.stringify(next)
    setState((prev) => (prev.key === key ? prev : { ...next, key }))
  }, [container])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(measure, [measure, ...deps])
  useEffect(() => {
    const el = container.current
    if (!el) return
    // Once per frame however many observed boxes changed, and never on the SVG drawn from the measurement.
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    })
    observer.observe(el)
    for (const child of el.children) if (!(child instanceof SVGElement)) observer.observe(child)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [container, measure])
  return state
}
