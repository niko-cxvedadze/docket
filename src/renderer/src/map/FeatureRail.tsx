import { memo, useMemo } from 'react'
import { Waypoints } from 'lucide-react'
import type { SystemMap } from '../../../shared/sysmap'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { areasOf, freshLabel, matches, runsThrough, type Fresh, type Selection } from './kinds'

/**
 * The features, by product area, beside the system: what it does next to what it is built from.
 * Picking one draws its path over the system; with a component picked, the features that run
 * through it stay lit and the rest fade.
 */
export const FeatureRail = memo(function FeatureRail({
  map,
  selection,
  onSelect,
  fresh,
  query
}: {
  map: SystemMap
  selection: Selection
  onSelect: (s: Selection) => void
  fresh: Fresh
  query: string
}) {
  const areas = useMemo(() => areasOf(map.features), [map.features])
  const pickedFeature = selection?.type === 'feature' ? selection.id : null
  const pickedNode = selection?.type === 'node' ? map.nodes.find((n) => n.id === selection.id) : undefined
  const through = pickedNode ? map.features.filter((f) => runsThrough(f, pickedNode.id)).length : 0

  return (
    // In a narrow window the system needs the room; the features are then one tab away.
    <nav
      aria-label="Features"
      className="sticky top-0 flex max-h-[calc(100vh-150px)] w-[190px] shrink-0 flex-col gap-2.5 self-start overflow-auto rounded-xl border bg-card p-2.5 max-[1180px]:hidden"
    >
      <div className="grid gap-1 px-1">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-primary">
          <Waypoints className="size-3.5" aria-hidden />
          Features
          <span className="font-normal text-muted-foreground">{map.features.length}</span>
        </h3>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {pickedNode
            ? through
              ? `${through} of them ${through === 1 ? 'runs' : 'run'} through ${pickedNode.name}.`
              : `None of them runs through ${pickedNode.name}.`
            : 'Pick one to trace its path through the system.'}
        </p>
      </div>
      {areas.map((area) => (
        <div key={area.name} className="grid gap-px">
          <div className="px-1 pb-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{area.name}</div>
          {area.features.map((f) => {
            const picked = pickedFeature === f.id
            const dim = (pickedNode ? !runsThrough(f, pickedNode.id) : false) || !matches(query, f.name, f.summary, f.area, f.paths)
            const badge = freshLabel(fresh, 'feature', f.id)
            return (
              <Button
                key={f.id}
                variant={picked ? 'secondary' : 'ghost'}
                size="xs"
                title={f.summary}
                aria-pressed={picked}
                onClick={() => onSelect(picked ? null : { type: 'feature', id: f.id })}
                className={cn(
                  'h-auto min-h-6 justify-start gap-1.5 px-1.5 py-1 text-left leading-snug font-normal whitespace-normal transition-opacity',
                  picked && 'bg-tint font-medium text-primary hover:bg-tint',
                  dim && 'opacity-35'
                )}
              >
                <span className="min-w-0 flex-1">{f.name}</span>
                {badge && <span className={cn('size-1.5 shrink-0 rounded-full', badge === 'New' ? 'bg-ready' : 'bg-action')} title={`${badge} in the last update`} />}
              </Button>
            )
          })}
        </div>
      ))}
      {!map.features.length && <p className="px-1 text-xs text-muted-foreground">No features were found on this branch.</p>}
    </nav>
  )
})
