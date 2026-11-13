import { cn } from '@/lib/utils'

/** A profile picture, or a plain disc when there is none. */
export function Avatar({ url, title, className }: { url: string; title?: string; className?: string }) {
  const shape = cn('size-4 shrink-0 rounded-full bg-secondary', className)
  return url ? <img src={url} alt="" title={title} loading="lazy" className={shape} /> : <span className={shape} title={title} aria-hidden />
}

/** A pull request author as their profile picture and login; faces are quicker to spot than names. */
export function Author({ author, className }: { author: { login: string; avatarUrl: string }; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 align-middle', className)}>
      <Avatar url={author.avatarUrl} />
      <span className="truncate">{author.login}</span>
    </span>
  )
}
