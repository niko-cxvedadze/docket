import { Baby, Compass, Database, Footprints, ListChecks, ShieldAlert, Wrench, Zap } from 'lucide-react'
import type { MapChat as Chat, MapSubject, SystemMap } from '../../../shared/sysmap'
import type { Shortcut } from '../Composer'
import { ChatPanel, type ChatSource } from '../ChatPanel'

/** One click asks these. The text is what gets asked, and what shows in the conversation. */
const SHORTCUTS: Record<MapSubject['type'], Shortcut[]> = {
  node: [
    { label: 'Explain simply', Icon: Baby, title: 'In plain words, with no jargon', prompt: 'Explain what this part does and why it exists in plain words, with no jargon, in a short paragraph. Use a simple everyday comparison.' },
    { label: 'Who uses it', Icon: Footprints, title: 'Where it is called from', prompt: 'Who uses this part, and how? Name the callers and the main entry points into it, with path:line.' },
    { label: 'What could break', Icon: ShieldAlert, title: 'Fragile spots and risks', prompt: 'What are the fragile or risky spots in this part, and what would break elsewhere if it changed?' },
    { label: 'Where to start', Icon: Compass, title: 'What to read first', prompt: 'I am new to this part. Which files and functions should I read first, in what order, to understand it?' }
  ],
  feature: [
    { label: 'Walk me through it', Icon: Footprints, title: 'Step by step, with the code', prompt: 'Walk me through this feature step by step, from the moment it starts to the moment it is done, pointing at the code for each step as path:line.' },
    { label: 'Edge cases', Icon: ListChecks, title: 'Limits, failures and odd states', prompt: 'Which edge cases, limits and failure states does this feature handle, and which does it not handle?' },
    { label: 'What could break', Icon: ShieldAlert, title: 'Fragile spots and risks', prompt: 'What are the riskiest parts of this feature, and what could break it?' },
    { label: 'How to change it', Icon: Wrench, title: 'Where a change would go', prompt: 'If I had to change how this feature behaves, which files would I touch, and what should I be careful about?' }
  ],
  system: [
    { label: 'TL;DR', Icon: Zap, title: 'The whole system in a few lines', prompt: 'TL;DR: explain this system in at most 4 short bullet points: what it is for, how it is put together, and what is unusual about it. No preamble.' },
    { label: 'Where data lives', Icon: Database, title: 'Stores, and what writes to them', prompt: 'Where does this system keep its data? List every store with what it holds and which parts write to it.' },
    { label: 'Background work', Icon: ListChecks, title: 'Jobs, schedules and queues', prompt: 'What runs in the background in this system (schedules, queues, workers), what starts each one, and what happens when one fails?' },
    { label: 'Where to start', Icon: Compass, title: 'What to read first', prompt: 'I am new to this codebase. Which files should I read first, in what order, to understand how it works?' }
  ]
}

const ABOUT: Record<MapSubject['type'], string> = { node: 'this part', feature: 'this feature', system: 'the system' }

/**
 * Conversations with Claude about one part of the map: a component, a feature, or the system as a
 * whole. Claude gets the map and what is being looked at, and reads the code in the branch's own
 * checkout. Each part keeps its own conversations.
 */
export function MapChat({ map, subject, name }: { map: SystemMap; subject: MapSubject; /** What is being asked about. */ name: string }) {
  const source: ChatSource<Chat> = {
    list: () => window.api.mapChats(map.id, subject),
    ask: (chatId, question) => window.api.mapAsk(map.id, subject, chatId, question),
    cancel: (chatId) => window.api.mapChatCancel(chatId),
    remove: (chatId) => window.api.mapChatDelete(chatId),
    onAnswer: (cb) => window.api.onMapChatEvent((e) => e.mapId === map.id && e.subject.type === subject.type && e.subject.id === subject.id && cb(e))
  }
  return (
    <ChatPanel
      source={source}
      subject={subject.type === 'system' ? 'the system' : name}
      intro={`Ask Claude anything about ${subject.type === 'system' ? 'this system' : name}. It knows the map and what you are looking at, and reads the code of ${map.branch} in its own checkout to answer. It cannot change anything.`}
      placeholder={`Ask about ${ABOUT[subject.type]}`}
      shortcuts={SHORTCUTS[subject.type]}
    />
  )
}
