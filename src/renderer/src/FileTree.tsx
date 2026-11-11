import { useMemo, useState } from 'react'
import { Check, CheckCheck, ChevronDown, ChevronRight } from 'lucide-react'
import type { PrFile } from '../../shared/types'
import { cn } from '@/lib/utils'

const NO_DISCUSSION = { open: 0, resolved: 0 }

interface Dir {
  name: string
  path: string
  dirs: Dir[]
  files: { name: string; index: number; file: PrFile }[]
}

function build(files: PrFile[]): Dir {
  const root: Dir = { name: '', path: '', dirs: [], files: [] }
  files.forEach((file, index) => {
    const parts = file.path.split('/')
    const name = parts.pop()!
    let dir = root
    for (const part of parts) {
      let next = dir.dirs.find((d) => d.name === part)
      if (!next) {
        next = { name: part, path: dir.path ? `${dir.path}/${part}` : part, dirs: [], files: [] }
        dir.dirs.push(next)
      }
      dir = next
    }
    dir.files.push({ name, index, file })
  })
  // Merge chains of folders that only contain one folder, the way editors show "src/main/lib".
  const compact = (d: Dir): Dir => {
    let dir = d
    while (dir !== root && dir.files.length === 0 && dir.dirs.length === 1) {
      const only = dir.dirs[0]
      dir = { ...only, name: `${dir.name}/${only.name}` }
    }
    dir.dirs = dir.dirs.map(compact).sort((a, b) => a.name.localeCompare(b.name))
    dir.files.sort((a, b) => a.name.localeCompare(b.name))
    return dir
  }
  return compact(root)
}

const STATUS: Record<string, { letter: string; label: string; className: string }> = {
  added: { letter: 'A', label: 'Added', className: 'text-ready' },
  removed: { letter: 'D', label: 'Deleted', className: 'text-danger' },
  renamed: { letter: 'R', label: 'Renamed', className: 'text-primary' },
  modified: { letter: 'M', label: 'Modified', className: 'text-action' }
}

function Folder({
  dir,
  depth,
  counts,
  viewed,
  discussion,
  onJump
}: {
  dir: Dir
  depth: number
  counts: Map<string, number>
  viewed: Set<string>
  discussion: Map<string, { open: number; resolved: number }>
  onJump: (index: number) => void
}) {
  const [open, setOpen] = useState(true)
  const pad = { paddingLeft: 6 + depth * 12 }
  return (
    <li>
      <button
        className="flex w-full items-center gap-1 rounded-sm py-1 pr-2 text-left text-muted-foreground hover:bg-accent"
        style={pad}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={dir.path}
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <span className="truncate text-xs font-medium">{dir.name}</span>
      </button>
      {open && <Entries dir={dir} depth={depth + 1} counts={counts} viewed={viewed} discussion={discussion} onJump={onJump} />}
    </li>
  )
}

function Entries({
  dir,
  depth,
  counts,
  viewed,
  discussion,
  onJump
}: {
  dir: Dir
  depth: number
  counts: Map<string, number>
  viewed: Set<string>
  discussion: Map<string, { open: number; resolved: number }>
  onJump: (index: number) => void
}) {
  return (
    <ul>
      {dir.dirs.map((d) => (
        <Folder key={d.path} dir={d} depth={depth} counts={counts} viewed={viewed} discussion={discussion} onJump={onJump} />
      ))}
      {dir.files.map(({ name, index, file }) => {
        const status = STATUS[file.status] ?? STATUS.modified
        const comments = counts.get(file.path) ?? 0
        const seen = viewed.has(file.path)
        const posted = discussion.get(file.path) ?? NO_DISCUSSION
        return (
          <li key={file.path}>
            <button
              className="flex w-full items-center gap-2 rounded-sm py-1 pr-2 text-left hover:bg-accent"
              style={{ paddingLeft: 6 + depth * 12 + 18 }}
              title={`${file.path} (${status.label.toLowerCase()}, +${file.additions} −${file.deletions})${seen ? ', viewed' : ''}`}
              onClick={() => onJump(index)}
            >
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  file.status === 'removed' && 'line-through opacity-70',
                  seen && 'text-muted-foreground'
                )}
              >
                {name}
              </span>
              {seen && <Check className="size-3.5 shrink-0 text-ready" aria-label="Viewed" />}
              {posted.open > 0 ? (
                <span
                  className="rounded-full border border-action/50 px-1.5 text-[11px] font-semibold text-action"
                  title={`${posted.open} unresolved ${posted.open === 1 ? 'conversation' : 'conversations'}${posted.resolved ? `, ${posted.resolved} resolved` : ''}`}
                >
                  {posted.open}
                </span>
              ) : (
                posted.resolved > 0 && (
                  <CheckCheck
                    className="size-3.5 shrink-0 text-ready"
                    aria-label={`${posted.resolved} resolved ${posted.resolved === 1 ? 'conversation' : 'conversations'}`}
                  />
                )
              )}
              {comments > 0 && (
                <span className="rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
                  {comments}
                </span>
              )}
              <span className={cn('w-3 shrink-0 text-center font-mono text-[11px] font-semibold', status.className)} aria-label={status.label}>
                {status.letter}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function FileTree({
  files,
  counts,
  viewed,
  discussion,
  onJump
}: {
  files: PrFile[]
  counts: Map<string, number>
  /** Paths the reviewer has marked as viewed. */
  viewed: Set<string>
  discussion: Map<string, { open: number; resolved: number }>
  onJump: (index: number) => void
}) {
  const root = useMemo(() => build(files), [files])
  return (
    <nav className="h-full overflow-auto px-1.5 py-2.5 text-[13px]" aria-label="Changed files">
      <p className="px-1.5 pb-1.5 text-xs text-muted-foreground">
        {files.length} changed {files.length === 1 ? 'file' : 'files'}
        {files.length > 0 && (
          <span className={cn('float-right tabular-nums', viewed.size === files.length && 'font-medium text-ready')}>
            {viewed.size} / {files.length} viewed
          </span>
        )}
      </p>
      {files.length > 0 && (
        <div className="mx-1.5 mb-2 h-1 overflow-hidden rounded-full bg-secondary" aria-hidden>
          <div className="h-full rounded-full bg-ready transition-[width]" style={{ width: `${(viewed.size / files.length) * 100}%` }} />
        </div>
      )}
      <Entries dir={root} depth={0} counts={counts} viewed={viewed} discussion={discussion} onJump={onJump} />
    </nav>
  )
}
