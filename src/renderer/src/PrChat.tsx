import { useCallback, useEffect, useRef, useState } from 'react'
import { Baby, History, ListChecks, Plus, ShieldAlert, Trash2, Zap } from 'lucide-react'
import type { Chat, ChatEvent, PrSummary } from '../../shared/types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { ago, cleanError } from './util'
import { Composer, Shortcuts, type Shortcut } from './Composer'
import { Markdown } from './Markdown'
import { Confirm } from './Confirm'

/** One click asks these. The text is what gets asked, and what shows in the conversation. */
const SHORTCUTS: Shortcut[] = [
  {
    label: 'TL;DR',
    Icon: Zap,
    title: 'The whole pull request in a few lines',
    prompt:
      'TL;DR: summarise this pull request in at most 3 short bullet points: what it changes, why, and anything a reviewer must not miss. No preamble.'
  },
  {
    label: "Explain like I'm 5",
    Icon: Baby,
    title: 'In plain words, with no jargon',
    prompt:
      "Explain this pull request like I'm 5: what it does and why it matters, in plain words with no jargon, using a simple everyday comparison. Keep it to a short paragraph."
  },
  {
    label: 'Risks',
    Icon: ShieldAlert,
    title: 'What could break',
    prompt: 'What are the riskiest parts of this change, and what could break because of them?'
  },
  {
    label: "What's missing",
    Icon: ListChecks,
    title: 'Tests, error handling, edge cases',
    prompt: 'Is anything missing from this pull request, like tests, error handling or edge cases?'
  }
]

/** Conversations with Claude about this pull request: the current one, and earlier ones in the history. */
export function PrChat({ pr }: { pr: PrSummary }) {
  const [chats, setChats] = useState<Chat[]>([])
  // undefined until the history has loaded; null means a new conversation not asked yet.
  const [currentId, setCurrentId] = useState<string | null | undefined>(undefined)
  const [live, setLive] = useState<Record<string, ChatEvent>>({})
  // The question just sent, shown until the saved conversation has it.
  const [pending, setPending] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  const reload = useCallback(
    () =>
      window.api.listChats(pr.key).then(
        (r) => {
          setChats(r.chats)
          setPending(null)
          // Open the most recent conversation the first time.
          setCurrentId((id) => (id === undefined ? (r.chats[0]?.id ?? null) : id))
          setLive((l) => {
            const next = { ...l }
            for (const id of r.running) next[id] ??= { key: pr.key, chatId: id, state: 'running', step: 'Thinking', partial: '' }
            return next
          })
        },
        (e) => setError(cleanError(e))
      ),
    [pr.key]
  )
  useEffect(() => {
    void reload()
  }, [reload])
  useEffect(() => {
    const off = window.api.onChatEvent((e) => {
      if (e.key !== pr.key) return
      if (e.state === 'running') setLive((l) => ({ ...l, [e.chatId]: e }))
      else {
        setLive((l) => {
          const next = { ...l }
          delete next[e.chatId]
          return next
        })
        void reload()
      }
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [pr.key, reload])

  const chat = chats.find((c) => c.id === currentId) ?? null
  const now = currentId ? live[currentId] : undefined
  const running = !!pending || now?.state === 'running'
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [currentId, chat?.messages.length, pending, now?.partial, now?.step])

  const send = (text: string): void => {
    const q = text.trim()
    if (!q || running) return
    setDraft('')
    setError(null)
    setPending(q)
    window.api.sendChat(pr, currentId ?? null, q).then(
      (id) => {
        if (id) setCurrentId(id)
        void reload()
      },
      (e) => {
        setPending(null)
        setError(cleanError(e))
      }
    )
  }

  const messages = chat?.messages ?? []
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={chat?.title}>
          {chat ? chat.title : 'New conversation'}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={!chats.length}>
              <History aria-hidden />
              History{chats.length ? ` (${chats.length})` : ''}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-auto">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Conversations about this pull request</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {chats.map((c) => (
              <DropdownMenuItem key={c.id} onSelect={() => setCurrentId(c.id)} className={cn('grid gap-0.5', c.id === currentId && 'bg-accent')}>
                <span className="truncate text-[13px]">{c.title}</span>
                <span className="text-xs text-muted-foreground">
                  {live[c.id]?.state === 'running'
                    ? 'Answering now'
                    : `${ago(c.updatedAt)}, ${Math.ceil(c.messages.length / 2)} ${c.messages.length > 2 ? 'questions' : 'question'}`}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          title="Start a new conversation; this one stays in the history"
          disabled={!chat || !!pending}
          onClick={() => {
            setCurrentId(null)
            setError(null)
          }}
        >
          <Plus aria-hidden />
          New
        </Button>
        {chat && !running && (
          <Confirm
            title="Delete this conversation?"
            description={`"${chat.title}" and every answer in it are deleted. Other conversations about this pull request stay in the history.`}
            action="Delete conversation"
            onConfirm={() =>
              void window.api.deleteChat(chat.id).then(() => {
                setCurrentId(chats.find((c) => c.id !== chat.id)?.id ?? null)
                void reload()
              })
            }
          >
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-danger"
              title="Delete this conversation"
              aria-label="Delete this conversation"
            >
              <Trash2 aria-hidden />
            </Button>
          </Confirm>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px]">
        {messages.length === 0 && !pending && (
          <p className="text-muted-foreground">
            Ask Claude anything about this pull request. It reads the diff, the description and the review comments, and
            looks through the code in its own up-to-date checkout. It cannot change anything.
          </p>
        )}
        <div className="grid gap-4">
          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="ml-8 justify-self-end rounded-lg bg-tint px-3 py-2 whitespace-pre-wrap break-words">
                {m.text}
              </div>
            ) : (
              <div key={m.id} className="grid gap-1.5">
                {m.text && <Markdown text={m.text} />}
                {m.error && <p className={cn('text-xs', m.error === 'Stopped.' ? 'text-muted-foreground' : 'text-danger')}>{m.error}</p>}
              </div>
            )
          )}
          {pending && !messages.some((m) => m.role === 'user' && m.text === pending && m === messages[messages.length - 1]) && (
            <div className="ml-8 justify-self-end rounded-lg bg-tint px-3 py-2 whitespace-pre-wrap break-words">{pending}</div>
          )}
          {running && (
            <div className="grid gap-1.5">
              {now?.partial ? <Markdown text={now.partial} /> : null}
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="spinner" aria-hidden />
                {now?.step ?? 'Thinking'}
              </p>
            </div>
          )}
        </div>
        {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        <div ref={bottom} />
      </div>

      <Composer
        kind="chat"
        value={draft}
        onChange={setDraft}
        onSubmit={() => send(draft)}
        onStop={() => currentId && void window.api.cancelChat(currentId)}
        running={running}
        placeholder={running ? 'Claude is answering…' : 'Ask about this pull request'}
        above={<Shortcuts items={SHORTCUTS} disabled={running} onPick={(s) => send(s.prompt)} />}
      />
    </div>
  )
}
