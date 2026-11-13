import type { ComponentProps } from 'react'
import type { MapNode } from '../../../shared/sysmap'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { KINDS, type Selection } from './kinds'

/** "New" or "Changed" by the last update; nothing otherwise. */
export function FreshBadge({ label, className, suffix = '' }: { label: 'New' | 'Changed' | null; className?: string; suffix?: string }) {
  if (!label) return null
  return (
    <Badge className={cn(label === 'New' ? 'bg-ready-bg text-ready' : 'bg-action-bg text-action', className)}>
      {label}
      {suffix}
    </Badge>
  )
}

/** A component, small, as something to click through to. */
export function NodeChip({ node, onSelect, className, ...rest }: { node: MapNode; onSelect: (s: Selection) => void } & Omit<ComponentProps<typeof Button>, 'onSelect'>) {
  const kind = KINDS[node.kind]
  return (
    <Button
      variant="outline"
      size="xs"
      title={`${kind.label}: ${node.summary}`}
      onClick={() => onSelect({ type: 'node', id: node.id })}
      className={cn('max-w-full justify-start bg-card font-normal shadow-none dark:bg-card', kind.border, className)}
      {...rest}
    >
      <kind.Icon className={kind.text} aria-hidden />
      <span className="truncate">{node.name}</span>
    </Button>
  )
}
