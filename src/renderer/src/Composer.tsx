import type { ComponentType, ReactNode } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { ClaudeOptions } from './ClaudeOptions'

/**
 * The box at the bottom of both side tabs: text on top, then which Claude runs (a menu) on the left
 * and the button that starts it on the right. Enter sends, Shift-Enter starts a new line.
 */
export function Composer({
  kind,
  value,
  onChange,
  onSubmit,
  onStop,
  running,
  placeholder,
  submitLabel,
  allowEmpty,
  above,
  below
}: {
  kind: 'review' | 'chat'
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onStop?: () => void
  running: boolean
  placeholder: string
  /** Shown next to the arrow when it says more than "send", e.g. "Review". */
  submitLabel?: string
  /** A review starts without any text; a question needs some. */
  allowEmpty?: boolean
  /** Shortcuts shown over the box. */
  above?: ReactNode
  /** A note or confirmation under it. */
  below?: ReactNode
}) {
  const canSubmit = !running && (allowEmpty || !!value.trim())
  return (
    <div className="grid gap-2 border-t p-3">
      {above}
      <div
        className={cn(
          'rounded-lg border border-input bg-background shadow-xs transition-[color,box-shadow]',
          'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30'
        )}
      >
        <Textarea
          value={value}
          rows={2}
          placeholder={placeholder}
          className="max-h-48 min-h-14 resize-none border-0 bg-transparent px-3 pt-2.5 text-[13px] shadow-none focus-visible:ring-0 dark:bg-transparent"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (canSubmit) onSubmit()
            }
          }}
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          <div className="min-w-0 flex-1">
            <ClaudeOptions kind={kind} disabled={running} />
          </div>
          {running && onStop ? (
            <Button size="icon" variant="secondary" className="size-7 shrink-0 rounded-full" aria-label="Stop" title="Stop" onClick={onStop}>
              <Square className="size-3 fill-current" aria-hidden />
            </Button>
          ) : submitLabel ? (
            <Button size="xs" className="h-7 shrink-0 rounded-full px-3" disabled={!canSubmit} onClick={onSubmit} title={`${submitLabel} (Enter)`}>
              {submitLabel}
              <ArrowUp aria-hidden />
            </Button>
          ) : (
            <Button size="icon" className="size-7 shrink-0 rounded-full" aria-label="Send" title="Send (Enter)" disabled={!canSubmit} onClick={onSubmit}>
              <ArrowUp aria-hidden />
            </Button>
          )}
        </div>
      </div>
      {below}
    </div>
  )
}

export interface Shortcut {
  label: string
  /** What it asks, or the focus it sets. */
  prompt: string
  title: string
  Icon: ComponentType<{ 'aria-hidden'?: boolean }>
}

/** Small one-click buttons over the composer: the same look on both tabs. */
export function Shortcuts({ items, onPick, disabled }: { items: Shortcut[]; onPick: (s: Shortcut) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map((s) => (
        <Button
          key={s.label}
          variant="outline"
          size="xs"
          className="rounded-full font-normal"
          disabled={disabled}
          title={s.title}
          onClick={() => onPick(s)}
        >
          <s.Icon aria-hidden />
          {s.label}
        </Button>
      ))}
    </div>
  )
}
