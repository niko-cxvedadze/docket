import { useMemo, useRef } from 'react'
import type { MapFeature, MapNode, SystemMap } from '../../../shared/sysmap'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { KIND_ORDER, KINDS, freshLabel, matches, useRects, type Fresh, type Rect, type Selection } from './kinds'

/** A branch of the mind map: out of the right side of one box, into the left side of the next. */
function branch(a: Rect, b: Rect): string {
  const x1 = a.x + a.w
  const y1 = a.y + a.h / 2
  const x2 = b.x
  const y2 = b.y + b.h / 2
  const k = (x2 - x1) * 0.55
  return `M${x1} ${y1} C${x1 + k} ${y1} ${x2 - k} ${y2} ${x2} ${y2}`
}

/**
 * What the system does, as a mind map: the system, its product areas, the features in each, and,
 * for a feature that is opened, the components it runs through. That last ring is how the two
 * halves of the map meet: every feature leads to the parts of the system that carry it.
 */
export function FeatureView({
  map,
  selection,
  onSelect,
  fresh,
  query,
  expandAll
}: {
  map: SystemMap
  selection: Selection
  onSelect: (s: Selection) => void
  fresh: Fresh
  query: string
  /** Show every feature's components, not only the picked one's. */
  expandAll: boolean
}) {
  const container = useRef<HTMLDivElement>(null)
  const { rects, width, height } = useRects(container, [map, expandAll, selection])

  const byId = useMemo(() => new Map(map.nodes.map((n) => [n.id, n])), [map.nodes])
  /** Each feature's components, in the order it first reaches them. */
  const parts = useMemo(() => {
    const of = new Map<string, MapNode[]>()
    for (const f of map.features) of.set(f.id, [...new Set(f.steps.map((s) => s.node))].flatMap((id) => byId.get(id) ?? []))
    return of
  }, [map.features, byId])
  const areas = useMemo(() => {
    const grouped = new Map<string, MapFeature[]>()
    for (const f of map.features) grouped.set(f.area, [...(grouped.get(f.area) ?? []), f])
    return [...grouped].map(([name, features]) => ({ name, features }))
  }, [map.features])

  const pickedFeature = selection?.type === 'feature' ? selection.id : null
  const pickedNode = selection?.type === 'node' ? selection.id : null
  const uses = (f: MapFeature, nodeId: string): boolean => f.steps.some((s) => s.node === nodeId)

  if (!map.features.length)
    return <p className="max-w-md text-sm text-muted-foreground">No features were found on this branch. The System view shows what it is built from.</p>

  return (
    <div ref={container} className="relative w-max min-w-full pr-4 pb-2">
      <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width={width} height={height} aria-hidden>
        {areas.map((area) => {
          const root = rects.root
          const a = rects[`area:${area.name}`]
          if (!root || !a) return null
          return (
            <g key={area.name}>
              <path d={branch(root, a)} fill="none" strokeWidth={1.6} className="stroke-primary/50" />
              {area.features.map((f) => {
                const box = rects[`feature:${f.id}`]
                if (!box) return null
                const picked = pickedFeature === f.id
                return (
                  <g key={f.id}>
                    <path d={branch(a, box)} fill="none" strokeWidth={picked ? 1.8 : 1.2} className={picked ? 'stroke-primary' : 'stroke-muted-foreground/40'} />
                    {(parts.get(f.id) ?? []).map((n) => {
                      const leaf = rects[`part:${f.id}:${n.id}`]
                      return leaf ? <path key={n.id} d={branch(box, leaf)} fill="none" strokeWidth={1.2} style={{ stroke: KINDS[n.kind].color }} className="opacity-60" /> : null
                    })}
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>

      {/* The system sits at the top, not the middle: a long map would otherwise open with it out of sight. */}
      <div className="relative flex items-start gap-12">
        <div data-rect="root" className="w-[178px] shrink-0 rounded-xl bg-primary px-3.5 py-3 text-primary-foreground shadow-sm">
          <div className="text-sm leading-tight font-semibold">{map.title}</div>
          <div className="mt-1 text-[11px] opacity-85">
            {map.features.length === 1 ? '1 feature' : `${map.features.length} features`} in {areas.length === 1 ? '1 area' : `${areas.length} areas`}
          </div>
        </div>

        <div className="flex flex-col gap-6">
          {areas.map((area) => (
            <div key={area.name} className="flex items-center gap-10">
              <div data-rect={`area:${area.name}`} className="w-[136px] shrink-0 rounded-full border border-primary/30 bg-tint px-3 py-1.5 text-center text-xs leading-tight font-semibold">
                {area.name}
              </div>
              <div className="flex flex-col gap-2">
                {area.features.map((f) => {
                  const picked = pickedFeature === f.id
                  const nodes = parts.get(f.id) ?? []
                  const open = expandAll || picked
                  const badge = freshLabel(fresh, 'feature', f.id)
                  // With a component picked, the features that run through it stand out.
                  const dim = (pickedNode ? !uses(f, pickedNode) : false) || !matches(query, f.name, f.summary, f.area, f.paths)
                  return (
                    <div key={f.id} className="flex items-center gap-9">
                      <Button
                        variant="outline"
                        data-rect={`feature:${f.id}`}
                        aria-pressed={picked}
                        aria-expanded={open}
                        onClick={() => onSelect(picked ? null : { type: 'feature', id: f.id })}
                        className={cn(
                          'h-auto w-[236px] shrink-0 flex-col items-stretch justify-start gap-1 bg-card px-2.5 py-2 text-left font-normal whitespace-normal shadow-none transition-[opacity,box-shadow,border-color] dark:bg-card',
                          picked && 'border-primary ring-2 ring-primary/40',
                          !picked && pickedNode && !dim && 'border-primary/60',
                          dim && 'opacity-30'
                        )}
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{f.name}</span>
                          {badge && <Badge className={cn('px-1.5 py-0 text-[10px]', badge === 'New' ? 'bg-ready-bg text-ready' : 'bg-action-bg text-action')}>{badge}</Badge>}
                        </span>
                        <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">{f.summary}</span>
                        {nodes.length > 0 && (
                          // Which kinds of parts it touches, and how many of each: the feature's footprint on the system.
                          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 pt-0.5 text-[11px] text-muted-foreground">
                            {KIND_ORDER.map((k) => {
                              const count = nodes.filter((n) => n.kind === k).length
                              return count ? (
                                <span key={k} className="flex items-center gap-1" title={`${count} ${(count === 1 ? KINDS[k].label : KINDS[k].plural).toLowerCase()}`}>
                                  <span className={cn('size-1.5 rounded-full', KINDS[k].dot)} />
                                  {count}
                                </span>
                              ) : null
                            })}
                          </span>
                        )}
                      </Button>
                      {open && nodes.length > 0 && (
                        <div className="flex flex-col gap-1">
                          {nodes.map((n) => {
                            const kind = KINDS[n.kind]
                            return (
                              <Button
                                key={n.id}
                                variant="outline"
                                size="xs"
                                data-rect={`part:${f.id}:${n.id}`}
                                title={`${kind.label}: ${n.summary}`}
                                onClick={() => onSelect({ type: 'node', id: n.id })}
                                className={cn('max-w-[200px] justify-start bg-card font-normal shadow-none dark:bg-card', kind.border, pickedNode === n.id && 'ring-2 ring-primary/40')}
                              >
                                <kind.Icon className={kind.text} aria-hidden />
                                <span className="truncate">{n.name}</span>
                              </Button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
