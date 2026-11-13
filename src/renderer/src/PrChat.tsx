import { Baby, ListChecks, ShieldAlert, Zap } from 'lucide-react'
import type { Chat, PrSummary } from '../../shared/types'
import type { Shortcut } from './Composer'
import { ChatPanel, type ChatSource } from './ChatPanel'

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
  const source: ChatSource<Chat> = {
    list: () => window.api.listChats(pr.account, pr.key),
    ask: (chatId, question) => window.api.sendChat(pr, chatId, question),
    cancel: (chatId) => window.api.cancelChat(chatId),
    remove: (chatId) => window.api.deleteChat(chatId),
    // The same pull request under another account has conversations of its own.
    onAnswer: (cb) => window.api.onChatEvent((e) => e.key === pr.key && (!e.account || e.account === pr.account) && cb(e))
  }
  return (
    <ChatPanel
      source={source}
      subject="this pull request"
      intro="Ask Claude anything about this pull request. It reads the diff, the description and the review comments, and looks through the code in its own up-to-date checkout. It cannot change anything."
      placeholder="Ask about this pull request"
      shortcuts={SHORTCUTS}
    />
  )
}
