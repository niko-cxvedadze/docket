import { cn } from '@/lib/utils'

/** A pull request author as their profile picture and login; faces are quicker to spot than names. */
export function Author({ author, className }: { author: { login: string; avatarUrl: string }; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 align-middle', className)}>
      {author.avatarUrl ? (
        <img src={author.avatarUrl} alt="" loading="lazy" className="size-4 shrink-0 rounded-full bg-secondary" />
      ) : (
        <span className="size-4 shrink-0 rounded-full bg-secondary" aria-hidden />
      )}
      <span className="truncate">{author.login}</span>
    </span>
  )
}
