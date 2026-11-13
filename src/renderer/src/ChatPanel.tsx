import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { History, Plus, Trash2 } from 'lucide-react'
import type { ChatEvent, ChatMessage } from '../../shared/types'
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

/** What the panel needs of a conversation, whatever it is about. */
interface Conversation {
  id: string
  title: string
  updatedAt: string
  messages: ChatMessage[]
}

/** How an answer is going in one conversation. */
export type LiveAnswer = Pick<ChatEvent, 'chatId' | 'state' | 'step' | 'partial' | 'error'>

/** Where the panel's conversations come from: the ones about one pull request, or about one part of a system map. */
export interface ChatSource<C extends Conversation> {
  /** The conversations, most recent first, and which of them Claude is answering in. */
  list: () => Promise<{ chats: C[]; running: string[] }>
  /** Asks in conversation `chatId`, or starts a new one when it is null. Resolves with the conversation's id. */
  ask: (chatId: string | null, question: string) => Promise<string | null>
  cancel: (chatId: string) => Promise<void>
  remove: (chatId: string) => Promise<void>
  /** Calls `cb` for answers in these conversations only. Returns the unsubscribe. */
  onAnswer: (cb: (e: LiveAnswer) => void) => () => void
}

/** What the user asked, set to the right like a message they sent. */
export function Asked({ children }: { children: string }) {
  return <div className="ml-8 justify-self-end rounded-lg bg-tint px-3 py-2 whitespace-pre-wrap break-words">{children}</div>
}

/**
 * Conversations with Claude about one thing: the current one, earlier ones in the history, and the
 * box to ask in. `subject` names that thing in the panel's own words ("this pull request").
 */
export function ChatPanel<C extends Conversation>({
  source,
  subject,
  intro,
  placeholder,
  shortcuts
}: {
  source: ChatSource<C>
  subject: string
  /** Shown before the first question. */
  intro: ReactNode
  placeholder: string
  shortcuts: Shortcut[]
}) {
  const [chats, setChats] = useState<C[]>([])
  // undefined until the history has loaded; null means a new conversation not asked yet.
  const [currentId, setCurrentId] = useState<string | null | undefined>(undefined)
  const [live, setLive] = useState<Record<string, LiveAnswer>>({})
  // The question just sent, shown until the saved conversation has it.
  const [pending, setPending] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  // The source is rebuilt on every render of its owner; its functions are what matter.
  const src = useRef(source)
  src.current = source

  const reload = useCallback(
    () =>
      src.current.list().then(
        (r) => {
          setChats(r.chats)
          setPending(null)
          // Open the most recent conversation the first time.
          setCurrentId((id) => (id === undefined ? (r.chats[0]?.id ?? null) : id))
          setLive((l) => {
            const next = { ...l }
            for (const id of r.running) next[id] ??= { chatId: id, state: 'running', step: 'Thinking', partial: '' }
            return next
          })
        },
        (e) => setError(cleanError(e))
      ),
    []
  )
  useEffect(() => {
    void reload()
    return src.current.onAnswer((e) => {
      if (e.state === 'running') return setLive((l) => ({ ...l, [e.chatId]: e }))
      setLive((l) => {
        const next = { ...l }
        delete next[e.chatId]
        return next
      })
      void reload()
    })
  }, [reload])

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
    src.current.ask(currentId ?? null, q).then(
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
    <div className="flex h-full min-h-0 flex-1 flex-col">
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
            <DropdownMenuLabel className="text-xs text-muted-foreground">Conversations about {subject}</DropdownMenuLabel>
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
            description={`"${chat.title}" and every answer in it are deleted. Other conversations about ${subject} stay in the history.`}
            action="Delete conversation"
            onConfirm={() =>
              void src.current.remove(chat.id).then(() => {
                setCurrentId(chats.find((c) => c.id !== chat.id)?.id ?? null)
                void reload()
              })
            }
          >
            <Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-danger" title="Delete this conversation" aria-label="Delete this conversation">
              <Trash2 aria-hidden />
            </Button>
          </Confirm>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px]">
        {messages.length === 0 && !pending && <p className="text-muted-foreground">{intro}</p>}
        <div className="grid gap-4">
          {messages.map((m) =>
            m.role === 'user' ? (
              <Asked key={m.id}>{m.text}</Asked>
            ) : (
              <div key={m.id} className="grid gap-1.5">
                {m.text && <Markdown text={m.text} />}
                {m.error && <p className={cn('text-xs', m.error === 'Stopped.' ? 'text-muted-foreground' : 'text-danger')}>{m.error}</p>}
              </div>
            )
          )}
          {pending && !messages.some((m) => m.role === 'user' && m.text === pending && m === messages[messages.length - 1]) && <Asked>{pending}</Asked>}
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
        onStop={() => currentId && void src.current.cancel(currentId)}
        running={running}
        submitLabel="Ask"
        placeholder={running ? 'Claude is answering…' : placeholder}
        above={<Shortcuts items={shortcuts} disabled={running} onPick={(s) => send(s.prompt)} />}
      />
    </div>
  )
}
