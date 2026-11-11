import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { highlightBlock } from './highlight'
import { cn } from '@/lib/utils'

// Raw HTML in the text is shown as text, never run: answers and comments quote code from pull requests.
const components: Components = {
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-primary underline underline-offset-2 hover:opacity-80"
      onClick={(e) => {
        e.preventDefault()
        if (href?.startsWith('https://')) void window.api.openExternal(href)
      }}
    >
      {children}
    </a>
  ),
  ul: ({ children, className }) => (
    <ul className={cn('grid gap-1 pl-5', className?.includes('contains-task-list') ? 'list-none pl-1' : 'list-disc marker:text-muted-foreground')}>
      {children}
    </ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="grid list-decimal gap-1 pl-5 marker:text-muted-foreground">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed [&>ol]:mt-1 [&>ul]:mt-1">{children}</li>,
  h1: ({ children }) => <h3 className="mt-1 text-[15px] font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-1 text-[14px] font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-1 font-semibold">{children}</h4>,
  h4: ({ children }) => <h4 className="mt-1 font-semibold">{children}</h4>,
  blockquote: ({ children }) => <blockquote className="border-l-2 pl-3 text-muted-foreground">{children}</blockquote>,
  hr: () => <hr className="border-border" />,
  table: ({ children }) => (
    <div className="overflow-auto rounded-md border">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b bg-secondary px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b px-2 py-1 align-top">{children}</td>,
  pre: ({ children }) => (
    <pre className="overflow-auto rounded-md border bg-background px-3 py-2 font-mono text-xs leading-relaxed [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    const lang = className?.match(/language-([\w+-]+)/)?.[1]
    const text = String(children ?? '')
    // Fenced blocks carry their language (or at least a line break); everything else is inline code.
    if (lang || text.includes('\n'))
      return <code className="block" dangerouslySetInnerHTML={{ __html: highlightBlock(text.replace(/\n$/, ''), lang ?? null) }} />
    return <code className="rounded bg-secondary px-1 py-px font-mono text-[12px] break-words">{children}</code>
  }
}

/** GitHub-flavoured markdown: lists, tables, task lists, code with highlighting. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('grid min-w-0 gap-2 break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
