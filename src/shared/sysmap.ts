/**
 * The system map: what a codebase is built from (components), what it does (features), and how
 * each feature runs through the components. One map per repository and branch, built by Claude
 * from a checkout and then kept up to date from the commits that land on the branch.
 */

export const NODE_KINDS = ['entry', 'service', 'job', 'data', 'external'] as const
/** entry: a way in. service: an internal building block. job: background work. data: a store. external: someone else's system. */
export type MapNodeKind = (typeof NODE_KINDS)[number]

export const EDGE_KINDS = ['uses', 'reads', 'writes', 'reads_writes', 'triggers'] as const
export type MapEdgeKind = (typeof EDGE_KINDS)[number]

export interface MapFile {
  /** Relative to the repository root. */
  path: string
  /** A few words on what is in it. */
  note: string
}

export interface MapFact {
  label: string
  value: string
}

/** One thing inside a component: a table of a database, a screen of an app, an endpoint of an outside service. */
export interface MapItem {
  name: string
  note: string
}

/** One thing the system is built from. */
export interface MapNode {
  id: string
  kind: MapNodeKind
  name: string
  /** One sentence. */
  summary: string
  /** How it works, in markdown. Empty when it could not be studied in depth. */
  description: string
  /** What it is built with or how it runs: "PostgreSQL through Prisma", "cron, daily at 02:00". */
  tech: string
  facts: MapFact[]
  /**
   * What is inside it. For a data store its tables, collections, buckets or files; for an entry
   * point its screens, routes or commands; for an outside service the operations used. Else empty.
   */
  contents: MapItem[]
  files: MapFile[]
  /** Where it mainly lives. */
  paths: string[]
  /** The commit of the scan or update that last added or changed it. */
  changedIn: string
}

/** What one component does to another. The arrow starts at the side that acts. */
export interface MapEdge {
  from: string
  to: string
  kind: MapEdgeKind
  label: string
}

export interface MapStep {
  /** The component that acts at this point. */
  node: string
  text: string
}

/** Something the system does for the people who use it, and its path through the components. */
export interface MapFeature {
  id: string
  name: string
  /** The product area it belongs to; features of one area are drawn together. */
  area: string
  summary: string
  description: string
  steps: MapStep[]
  files: MapFile[]
  paths: string[]
  changedIn: string
}

export interface MapCommit {
  sha: string
  subject: string
  author: string
  date: string
}

export interface MapRef {
  type: 'node' | 'feature'
  id: string
  name: string
}

/** One time the map was built or brought up to date. */
export interface MapUpdate {
  at: string
  /** A scan reads the whole branch; an update reads only the commits since the last one. */
  kind: 'scan' | 'update'
  /** The commit the map was at before; empty for a scan. */
  from: string
  to: string
  /** The newest of the commits an update covered. */
  commits: MapCommit[]
  commitCount: number
  /** What changed on the map, in a sentence or two. */
  notes: string
  added: MapRef[]
  changed: MapRef[]
  removed: MapRef[]
}

export interface SystemMap {
  /** `account:owner/name@branch` */
  id: string
  repo: string
  branch: string
  /** The GitHub account it belongs to and is scanned as. Each account keeps its own maps. */
  account: string
  /** The commit the map describes. */
  headSha: string
  createdAt: string
  updatedAt: string
  title: string
  summary: string
  stack: string[]
  nodes: MapNode[]
  edges: MapEdge[]
  features: MapFeature[]
  /** Newest first. */
  history: MapUpdate[]
  /** What drew it, when that was chosen explicitly. */
  model?: string
}

export interface MapSummary {
  id: string
  repo: string
  branch: string
  account: string
  headSha: string
  updatedAt: string
  title: string
  nodes: number
  features: number
}

/** `study` covers both halves at once: components are studied while features are traced. */
export type MapPhase = 'prepare' | 'survey' | 'study' | 'update'

export interface MapProgress {
  id: string
  repo: string
  branch: string
  account: string
  mode: 'scan' | 'update'
  state: 'running' | 'done' | 'error' | 'cancelled'
  phase: MapPhase
  step: string
  /** Parts studied so far in this phase, out of `total`. Both 0 when the phase does not count. */
  done: number
  total: number
  /** Which Claude is doing it: the model and effort chosen for scans, or the CLI's own when none is. Empty when unknown. */
  model: string
  effort: string
  startedAt: string
  error?: string
}

export interface MapBranch {
  name: string
  sha: string
}

export interface MapBranches {
  defaultBranch: string | null
  branches: MapBranch[]
}

/** How the map stands against the branch on GitHub. Nulls when GitHub could not be asked. */
export interface MapFreshness {
  /** The branch's commit on GitHub right now; null when the branch is gone or unreachable. */
  head: string | null
  /** Commits on the branch since the one the map describes. */
  behind: number | null
}

/** What a conversation is about: one component, one feature, or the system as a whole (id ''). */
export interface MapSubject {
  type: 'node' | 'feature' | 'system'
  id: string
}

export interface MapChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: string
  /** Set when the answer did not finish; `text` then holds whatever arrived. */
  error?: string
}

/** A conversation with Claude about one part of a map. */
export interface MapChat {
  id: string
  account: string
  mapId: string
  subject: MapSubject
  /** The part's name when the conversation started, kept in case it is later renamed or removed. */
  subjectName: string
  /** The first question, shortened. */
  title: string
  createdAt: string
  updatedAt: string
  /** The claude CLI session the conversation continues in, and the folder it runs in. */
  sessionId: string
  cwd: string
  /** The commit the map described when Claude last answered, so a later update can be passed on. */
  headSha: string
  messages: MapChatMessage[]
}

/** Progress of an answer: the text so far while it streams, then how it ended. */
export interface MapChatEvent {
  account: string
  mapId: string
  chatId: string
  subject: MapSubject
  state: 'running' | 'done' | 'error' | 'cancelled'
  step?: string
  partial?: string
  error?: string
}

export const mapId = (account: string, repo: string, branch: string): string => `${account}:${repo}@${branch}`

export interface SystemMapApi {
  /** One account's saved maps, and its scans running right now. */
  mapList(account: string): Promise<{ maps: MapSummary[]; running: MapProgress[] }>
  mapGet(id: string): Promise<SystemMap | null>
  /** The repository's branches on GitHub, as one account sees them. */
  mapBranches(account: string, repo: string): Promise<MapBranches>
  mapFreshness(id: string): Promise<MapFreshness>
  /**
   * `scan` reads the whole branch and draws the map from nothing. `update` reads only the commits
   * since the map's own and changes what they change; without a map yet it scans.
   */
  mapScan(account: string, repo: string, branch: string, mode: 'scan' | 'update'): Promise<void>
  mapCancel(id: string): Promise<void>
  mapDelete(id: string): Promise<void>
  onMapProgress(cb: (p: MapProgress) => void): () => void
  /** The conversations about one map, most recent first, and which of them Claude is answering in. */
  mapChats(mapId: string): Promise<{ chats: MapChat[]; running: string[] }>
  /** Asks about one part of a map in conversation `chatId`, or starts a new one when it is null. Resolves with the conversation's id. */
  mapAsk(mapId: string, subject: MapSubject, chatId: string | null, question: string): Promise<string | null>
  mapChatCancel(chatId: string): Promise<void>
  mapChatDelete(chatId: string): Promise<void>
  onMapChatEvent(cb: (e: MapChatEvent) => void): () => void
}
