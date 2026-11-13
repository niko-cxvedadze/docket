import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { OnGitHub } from './OnGitHub'

const DROP = 'script, style, iframe, object, embed, form, link, meta, base, svg, button, textarea, select'
const SAFE_URL = /^(https?:|mailto:|#)/i

/**
 * GitHub's rendering of the description, cleaned again here before it goes on the page: only plain
 * content elements survive, with no styling, scripting or form controls of their own.
 */
function clean(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll(DROP).forEach((el) => el.remove())
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      const keep =
        ['href', 'src', 'alt', 'title', 'controls', 'colspan', 'rowspan', 'align', 'open', 'checked', 'disabled', 'type', 'start'].includes(name) &&
        !(['href', 'src'].includes(name) && !SAFE_URL.test(attr.value.trim()))
      if (!keep) el.removeAttribute(attr.name)
    }
  })
  doc.querySelectorAll('input').forEach((el) => (el.type === 'checkbox' ? el.setAttribute('disabled', '') : el.remove()))
  // GitHub tucks each video inside a collapsed block; show the player straight away.
  doc.querySelectorAll('video').forEach((video) => {
    video.setAttribute('controls', '')
    video.setAttribute('preload', 'metadata')
    const wrapper = video.closest('details')
    if (wrapper) wrapper.replaceWith(video)
  })
  doc.querySelectorAll('img').forEach((img) => img.setAttribute('loading', 'lazy'))
  return doc.body.innerHTML
}

/** Something GitHub rendered (a description, a comment), cleaned and shown with its images and videos. */
export function GithubHtml({ html, className }: { html: string; className?: string }) {
  const safe = useMemo(() => clean(html), [html])
  return (
    <div
      className={cn('markdown', className)}
      // Links leave the app; nothing in the text may navigate this window.
      onClick={(e) => {
        const link = (e.target as HTMLElement).closest('a')
        if (!link) return
        e.preventDefault()
        const href = link.getAttribute('href') ?? ''
        if (href.startsWith('https://')) void window.api.openExternal(href)
      }}
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  )
}

/** The pull request description, with its images and videos, at the top of the conversation. */
export function Description({
  html,
  url,
  heading,
  className
}: {
  html: string
  url: string
  /** Shown in place of the word "Description". */
  heading?: React.ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(true)
  if (!html.trim()) return null
  return (
    <section className={cn('file description', className)}>
      <header className="file-head">
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={open ? 'Collapse the description' : 'Expand the description'}
        >
          <ChevronRight className={cn('transition-transform', open && 'rotate-90')} aria-hidden />
        </Button>
        <span className="file-path">{heading ?? 'Description'}</span>
        <OnGitHub url={url} />
      </header>
      {open && <GithubHtml html={html} />}
    </section>
  )
}
