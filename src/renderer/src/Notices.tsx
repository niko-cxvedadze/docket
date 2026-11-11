import { useEffect, useRef, useState } from 'react'
import {
  Bell,
  BotMessageSquare,
  CircleAlert,
  CircleCheck,
  CircleX,
  GitMerge,
  MessageSquareWarning,
  NotebookPen,
  UserRoundCheck,
  type LucideIcon
} from 'lucide-react'
import { toast } from 'sonner'
import type { Notice, NoticeKind, PrSummary } from '../../shared/types'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { ago } from './util'

const LOOK: Record<NoticeKind, { Icon: LucideIcon; className: string }> = {
  'review-done': { Icon: NotebookPen, className: 'text-primary' },
  'review-failed': { Icon: CircleX, className: 'text-danger' },
  'chat-done': { Icon: BotMessageSquare, className: 'text-primary' },
  'chat-failed': { Icon: CircleX, className: 'text-danger' },
  'needs-you': { Icon: CircleAlert, className: 'text-action' },
  'ci-failed': { Icon: CircleX, className: 'text-danger' },
  'ci-passed': { Icon: CircleCheck, className: 'text-ready' },
  approved: { Icon: UserRoundCheck, className: 'text-ready' },
  'changes-requested': { Icon: MessageSquareWarning, className: 'text-danger' },
  ready: { Icon: GitMerge, className: 'text-ready' }
}

/**
 * The bell in the top bar: every notification Docket has shown, newest first, and what the number
 * on the dock icon is counting. New notifications pop up as a toast while the window is in front.
 */
export function Notices({
  prs,
  current,
  onOpen
}: {
  prs: PrSummary[]
  /** The pull request on screen; no toast about it, since the page already shows the change. */
  current: string | null
  onOpen: (pr: PrSummary) => void
}) {
  const [notices, setNotices] = useState<Notice[]>([])
  const [open, setOpen] = useState(false)
  // The listeners are set up once; these keep them reading the latest values.
  const latest = useRef({ prs, current, onOpen })
  latest.current = { prs, current, onOpen }

  const show = (n: Notice): void => {
    const { prs, onOpen } = latest.current
    const pr = n.prKey ? prs.find((p) => p.key === n.prKey) : undefined
    if (pr) onOpen(pr)
    else if (n.prUrl) void window.api.openExternal(n.prUrl)
  }

  useEffect(() => {
    void window.api.listNotices().then(setNotices, () => undefined)
    const offNew = window.api.onNotice((n) => {
      setNotices((all) => [n, ...all].slice(0, 100))
      if (n.prKey && n.prKey === latest.current.current) return
      toast(n.title, {
        description: n.body.split('\n').slice(0, 3).join('\n'),
        duration: 6000,
        action: n.prKey || n.prUrl ? { label: 'Open', onClick: () => show(n) } : undefined
      })
    })
    const offOpen = window.api.onOpenNotice((n) => show(n))
    return () => {
      if (typeof offNew === 'function') offNew()
      if (typeof offOpen === 'function') offOpen()
    }
    // show reads through the ref, so the listeners never need replacing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const unread = notices.filter((n) => !n.read).length
  const needs = prs.filter((p) => p.level !== 'waiting')
  const mine = needs.filter((p) => p.role === 'mine').length

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        // Opening the list counts as seeing everything in it.
        if (o && unread) {
          setNotices((all) => all.map((n) => ({ ...n, read: true })))
          void window.api.markNoticesRead()
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative size-8" aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}>
          <Bell aria-hidden />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-background tabular-nums">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="border-b px-3 py-2.5">
          <p className="text-sm font-semibold">Notifications</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {needs.length
              ? `The dock icon shows ${needs.length}: pull requests that need you or are ready to merge (${mine} of yours, ${needs.length - mine} to review).`
              : 'Nothing needs you right now, so the dock icon shows no number.'}
          </p>
        </div>
        <ul className="max-h-[60vh] overflow-auto">
          {notices.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-muted-foreground">
              Nothing yet. Docket lists here when a review is drafted, Claude answers, or one of your pull requests
              changes.
            </li>
          )}
          {notices.map((n) => {
            const { Icon, className } = LOOK[n.kind] ?? LOOK['needs-you']
            const clickable = !!(n.prKey || n.prUrl)
            return (
              <li key={n.id} className="border-b last:border-b-0">
                <Button
                  variant="ghost"
                  className={cn('h-auto w-full items-start justify-start gap-2.5 rounded-none px-3 py-2.5 text-left font-normal whitespace-normal', !clickable && 'cursor-default')}
                  onClick={() => {
                    if (!clickable) return
                    setOpen(false)
                    show(n)
                  }}
                >
                  <Icon className={cn('mt-0.5 size-4 shrink-0', className)} aria-hidden />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="flex items-baseline gap-2">
                      <span className={cn('min-w-0 flex-1 truncate text-[13px]', !n.read && 'font-semibold')}>{n.title}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{ago(n.at)}</span>
                    </span>
                    <span className="line-clamp-3 text-xs whitespace-pre-line text-muted-foreground">{n.body}</span>
                  </span>
                </Button>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
