import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface Props {
  count: number
  /** What Cmd-C does with the selection, such as "Copy links". */
  label: string
  icon: LucideIcon
  onCopy: () => void
  onClear: () => void
  /** How the bar is placed: `fixed` over the window, or `absolute` inside a panel. */
  className?: string
}

/** The bar that floats at the bottom while rows or comments are selected for copying. */
export function SelectionBar({ count, label, icon: Icon, onCopy, onClear, className }: Props) {
  return (
    <div className={cn('pointer-events-none inset-x-0 bottom-5 z-20 flex justify-center', className)}>
      <div className="pointer-events-auto flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm shadow-lg" role="status">
        <span className="font-medium tabular-nums">{count} selected</span>
        <Button size="sm" className="h-7 gap-1" onClick={onCopy}>
          <Icon aria-hidden />
          {label}
          <kbd className="ml-1 text-[11px] opacity-70">⌘C</kbd>
        </Button>
        <Button size="sm" variant="ghost" className="h-7" onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  )
}
