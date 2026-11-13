import { useState, type ReactNode } from 'react'
import { ArrowRight, FileCode, GitCommitHorizontal, Info, MessagesSquare, Network, Waypoints, X } from 'lucide-react'
import type { MapFile, MapNode, MapNodeKind, MapRef, MapSubject, MapUpdate, SystemMap } from '../../../shared/sysmap'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MapChat } from './MapChat'
import { Markdown } from '../Markdown'
import { ago } from '../util'
import { cn } from '@/lib/utils'
import { EDGE_VERB, KIND_ORDER, KINDS, freshLabel, type Fresh, type Selection } from './kinds'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  )
}

/** A component, small, as something to click through to. */
function NodeChip({ node, onSelect }: { node: MapNode; onSelect: (s: Selection) => void }) {
  const kind = KINDS[node.kind]
  return (
    <Button
      variant="outline"
      size="xs"
      title={`${kind.label}: ${node.summary}`}
      onClick={() => onSelect({ type: 'node', id: node.id })}
      className={cn('max-w-full justify-start bg-card font-normal shadow-none dark:bg-card', kind.border)}
    >
      <kind.Icon className={kind.text} aria-hidden />
      <span className="truncate">{node.name}</span>
    </Button>
  )
}

/** Key files, each opening on GitHub at the commit the map describes. */
function Files({ map, files }: { map: SystemMap; files: MapFile[] }) {
  if (!files.length) return null
  const url = (path: string): string => `https://github.com/${map.repo}/blob/${map.headSha}/${path.split('/').map(encodeURIComponent).join('/')}`
  return (
    <Section title="Where to look">
      <ul className="grid gap-1.5">
        {files.map((f) => (
          <li key={f.path} className="grid gap-0.5">
            <Button
              variant="link"
              size="xs"
              title="Open on GitHub"
              onClick={() => void window.api.openExternal(url(f.path))}
              className="h-auto max-w-full justify-start gap-1.5 px-0 font-mono text-xs font-normal whitespace-normal"
            >
              <FileCode aria-hidden />
              <span className="min-w-0 text-left break-all">{f.path}</span>
            </Button>
            {f.note && <span className="pl-[18px] text-xs text-muted-foreground">{f.note}</span>}
          </li>
        ))}
      </ul>
    </Section>
  )
}

/** What the things inside a component are called, by its kind. */
const CONTENTS_TITLE: Record<MapNodeKind, string> = {
  data: 'What it holds',
  entry: 'What it offers',
  external: 'What is used of it',
  service: 'Inside it',
  job: 'Inside it'
}

const freshBadge = (label: 'New' | 'Changed' | null): ReactNode =>
  label && <Badge className={label === 'New' ? 'bg-ready-bg text-ready' : 'bg-action-bg text-action'}>{label} in the last update</Badge>

function NodeDetail({ map, node, onSelect, fresh, onView }: { map: SystemMap; node: MapNode; onSelect: (s: Selection) => void; fresh: Fresh; onView: (v: 'system' | 'features') => void }) {
  const kind = KINDS[node.kind]
  const byId = new Map(map.nodes.map((n) => [n.id, n]))
  const out = map.edges.filter((e) => e.from === node.id)
  const into = map.edges.filter((e) => e.to === node.id)
  const features = map.features.filter((f) => f.steps.some((s) => s.node === node.id))
  return (
    <>
      <header className="flex flex-col items-start gap-1.5">
        <div className={cn('flex items-center gap-1.5 text-xs font-semibold', kind.text)}>
          <kind.Icon className="size-3.5" aria-hidden />
          {kind.label}
        </div>
        <h2 className="text-lg leading-tight font-semibold tracking-tight">{node.name}</h2>
        {node.tech && <p className="text-xs text-muted-foreground">{node.tech}</p>}
        {freshBadge(freshLabel(fresh, 'node', node.id))}
      </header>
      <p className="text-sm leading-relaxed">{node.summary}</p>
      {node.description ? (
        <Section title="How it works">
          <Markdown text={node.description} className="text-[13px]" />
        </Section>
      ) : (
        <p className="text-xs text-muted-foreground">This part was only outlined: the scan could not study it in depth. Scanning again usually fills it in.</p>
      )}
      {node.contents.length > 0 && (
        <Section title={`${CONTENTS_TITLE[node.kind]} (${node.contents.length})`}>
          <ul className="flex flex-col gap-1.5">
            {node.contents.map((i) => (
              <li key={i.name} className="flex flex-col gap-0.5 border-l-2 pl-2" style={{ borderColor: kind.color }}>
                <span className="font-mono text-xs break-all">{i.name}</span>
                {i.note && <span className="text-xs leading-relaxed text-muted-foreground">{i.note}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {node.facts.length > 0 && (
        <Section title="At a glance">
          <dl className="grid gap-2">
            {node.facts.map((f) => (
              <div key={f.label} className="grid gap-0.5">
                <dt className="text-xs font-medium">{f.label}</dt>
                <dd className="text-xs leading-relaxed text-muted-foreground">{f.value}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}
      {out.length > 0 && (
        <Section title="What it acts on">
          <ul className="grid gap-1.5">
            {out.map((e) => (
              <li key={e.to} className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
                <span className="text-muted-foreground">{EDGE_VERB[e.kind]}</span>
                {byId.has(e.to) && <NodeChip node={byId.get(e.to)!} onSelect={onSelect} />}
                {e.label && <span className="text-muted-foreground">{e.label}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {into.length > 0 && (
        <Section title="What acts on it">
          <ul className="grid gap-1.5">
            {into.map((e) => (
              <li key={e.from} className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
                {byId.has(e.from) && <NodeChip node={byId.get(e.from)!} onSelect={onSelect} />}
                <span className="text-muted-foreground">
                  {EDGE_VERB[e.kind]} it{e.label ? `: ${e.label}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={features.length ? `Features that run through it (${features.length})` : 'Features that run through it'}>
        {features.length ? (
          <ul className="grid gap-1">
            {features.map((f) => (
              <li key={f.id}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left font-normal whitespace-normal"
                  onClick={() => onSelect({ type: 'feature', id: f.id })}
                >
                  <Waypoints className="text-primary" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">{f.name}</span>
                    <span className="block text-xs text-muted-foreground">{f.steps.find((s) => s.node === node.id)?.text}</span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No feature on the map passes through this part.</p>
        )}
        {features.length > 0 && (
          <Button variant="outline" size="xs" className="w-fit" onClick={() => onView('features')}>
            <Waypoints aria-hidden />
            See them on the feature map
          </Button>
        )}
      </Section>
      <Files map={map} files={node.files} />
      {node.paths.length > 0 && (
        <Section title="Lives in">
          <p className="font-mono text-xs leading-relaxed break-all whitespace-pre-line text-muted-foreground">{node.paths.join('\n')}</p>
        </Section>
      )}
    </>
  )
}

function FeatureDetail({
  map,
  featureId,
  onSelect,
  fresh,
  view,
  onView
}: {
  map: SystemMap
  featureId: string
  onSelect: (s: Selection) => void
  fresh: Fresh
  view: 'system' | 'features'
  onView: (v: 'system' | 'features') => void
}) {
  const feature = map.features.find((f) => f.id === featureId)
  if (!feature) return null
  const byId = new Map(map.nodes.map((n) => [n.id, n]))
  return (
    <>
      <header className="flex flex-col items-start gap-1.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
          <Waypoints className="size-3.5" aria-hidden />
          Feature in {feature.area}
        </div>
        <h2 className="text-lg leading-tight font-semibold tracking-tight">{feature.name}</h2>
        {freshBadge(freshLabel(fresh, 'feature', feature.id))}
      </header>
      <p className="text-sm leading-relaxed">{feature.summary}</p>
      {feature.description && (
        <Section title="What it does">
          <Markdown text={feature.description} className="text-[13px]" />
        </Section>
      )}
      <Section title="How it runs through the system">
        {feature.steps.length ? (
          <ol className="grid gap-2.5">
            {feature.steps.map((s, i) => (
              <li key={i} className="flex gap-2.5">
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">{i + 1}</span>
                <div className="grid min-w-0 gap-1">
                  {byId.has(s.node) && <NodeChip node={byId.get(s.node)!} onSelect={onSelect} />}
                  <span className="text-xs leading-relaxed text-muted-foreground">{s.text}</span>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">Its path through the system could not be traced. Scanning again usually fills it in.</p>
        )}
        {feature.steps.length > 0 && view !== 'system' && (
          <Button variant="outline" size="xs" className="w-fit" onClick={() => onView('system')}>
            <Network aria-hidden />
            Show this path on the system map
          </Button>
        )}
      </Section>
      <Files map={map} files={feature.files} />
    </>
  )
}

/** One line of the map's history: what a scan or an update did. */
function Change({ map, entry, onSelect, first }: { map: SystemMap; entry: MapUpdate; onSelect: (s: Selection) => void; first: boolean }) {
  const exists = (r: MapRef): boolean => (r.type === 'node' ? map.nodes.some((n) => n.id === r.id) : map.features.some((f) => f.id === r.id))
  /** A component carries the colour of its kind, a feature the feature mark, since the two often share a name. */
  const mark = (r: MapRef): ReactNode => {
    const node = r.type === 'node' ? map.nodes.find((n) => n.id === r.id) : undefined
    return r.type === 'feature' ? (
      <Waypoints className="text-primary" aria-label="Feature" />
    ) : (
      <span className={cn('size-1.5 shrink-0 rounded-full', node ? KINDS[node.kind].dot : 'bg-neutral-mark')} aria-label={node ? KINDS[node.kind].label : 'Component'} />
    )
  }
  const refs = (label: string, list: MapRef[], tone: string): ReactNode =>
    list.length > 0 && (
      <div className="flex flex-wrap items-center gap-1">
        <span className={cn('text-[11px] font-medium', tone)}>{label}</span>
        {list.map((r) =>
          first && exists(r) ? (
            <Button key={`${r.type}:${r.id}`} variant="secondary" size="xs" className="h-5 max-w-full font-normal" onClick={() => onSelect({ type: r.type, id: r.id })}>
              {mark(r)}
              <span className="truncate">{r.name}</span>
            </Button>
          ) : (
            <span key={`${r.type}:${r.id}`} className="flex max-w-full items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground [&>svg]:size-3">
              {mark(r)}
              <span className="truncate">{r.name}</span>
            </span>
          )
        )}
      </div>
    )
  return (
    <li className="flex min-w-0 flex-col gap-1.5 rounded-lg border bg-background/60 p-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs whitespace-nowrap">
        <span className="font-medium">
          {entry.kind === 'scan' ? 'Full scan' : `Update from ${entry.commitCount === 1 ? '1 commit' : `${entry.commitCount} commits`}`}
        </span>
        <span className="text-muted-foreground" title={new Date(entry.at).toLocaleString()}>
          {ago(entry.at)}
        </span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {entry.from ? `${entry.from.slice(0, 7)} → ` : ''}
          {entry.to.slice(0, 7)}
        </span>
      </div>
      {entry.notes && <p className="text-xs leading-relaxed text-muted-foreground">{entry.notes}</p>}
      {refs('Added', entry.added, 'text-ready')}
      {refs('Changed', entry.changed, 'text-action')}
      {refs('Removed', entry.removed, 'text-danger')}
      {first && entry.commits.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-0.5 pt-0.5">
          {entry.commits.slice(0, 6).map((c) => (
            <li key={c.sha} className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <GitCommitHorizontal className="size-3 shrink-0" aria-hidden />
              <span className="font-mono text-[11px]">{c.sha.slice(0, 7)}</span>
              <span className="min-w-0 truncate" title={`${c.subject} (${c.author})`}>
                {c.subject}
              </span>
            </li>
          ))}
          {entry.commitCount > 6 && <li className="pl-[18px] text-xs text-muted-foreground">and {entry.commitCount - 6} more</li>}
        </ul>
      )}
    </li>
  )
}

function Overview({ map, onSelect, actions }: { map: SystemMap; onSelect: (s: Selection) => void; actions: ReactNode }) {
  return (
    <>
      <header className="flex flex-col items-start gap-1.5">
        <div className="text-xs font-semibold text-muted-foreground">The system</div>
        <h2 className="text-lg leading-tight font-semibold tracking-tight">{map.title}</h2>
      </header>
      <p className="text-sm leading-relaxed">{map.summary}</p>
      {map.stack.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {map.stack.map((s) => (
            <Badge key={s} variant="secondary" className="font-normal">
              {s}
            </Badge>
          ))}
        </div>
      )}
      <Section title="On this map">
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          {KIND_ORDER.map((k) => {
            const count = map.nodes.filter((n) => n.kind === k).length
            return (
              <li key={k} className="flex items-center gap-1.5">
                <span className={cn('size-2 rounded-full', KINDS[k].dot)} />
                <span className="font-medium tabular-nums">{count}</span>
                <span className="text-muted-foreground">{(count === 1 ? KINDS[k].label : KINDS[k].plural).toLowerCase()}</span>
              </li>
            )
          })}
          <li className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-primary" />
            <span className="font-medium tabular-nums">{map.features.length}</span>
            <span className="text-muted-foreground">{map.features.length === 1 ? 'feature' : 'features'}</span>
          </li>
        </ul>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          Pick a part or a feature to see how it works
          <ArrowRight className="size-3 rotate-180" aria-hidden />
        </p>
      </Section>
      <Section title="History">
        <ol className="flex flex-col gap-2">
          {map.history.slice(0, 8).map((entry, i) => (
            <Change key={`${entry.at}${i}`} map={map} entry={entry} onSelect={onSelect} first={i === 0} />
          ))}
        </ol>
        {map.history.length > 8 && <p className="text-xs text-muted-foreground">and {map.history.length - 8} earlier</p>}
      </Section>
      {actions}
    </>
  )
}

/** The panel beside the map: the system as a whole, or whatever part or feature is picked. */
export function MapDetail({
  map,
  selection,
  onSelect,
  fresh,
  view,
  onView,
  actions
}: {
  map: SystemMap
  selection: Selection
  onSelect: (s: Selection) => void
  fresh: Fresh
  view: 'system' | 'features'
  onView: (v: 'system' | 'features') => void
  /** Shown under the overview: what can be done to the map as a whole. */
  actions: ReactNode
}) {
  const node = selection?.type === 'node' ? map.nodes.find((n) => n.id === selection.id) : undefined
  const feature = selection?.type === 'feature' ? map.features.find((f) => f.id === selection.id) : undefined
  // Stays on Ask Claude while the user clicks around the map, so each part can be asked about in turn.
  const [tab, setTab] = useState<'about' | 'ask'>('about')
  const subject: MapSubject = node ? { type: 'node', id: node.id } : feature ? { type: 'feature', id: feature.id } : { type: 'system', id: '' }
  const name = node?.name ?? feature?.name ?? map.title
  // A window whose preload is older than this page (the app not restarted since an update) cannot ask yet.
  const canAsk = typeof window.api.mapChats === 'function'
  return (
    <aside className="flex w-[372px] shrink-0 flex-col border-l bg-card" aria-label="Details">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Tabs value={canAsk ? tab : 'about'} onValueChange={(v) => setTab(v as 'about' | 'ask')}>
          <TabsList className="h-8">
            <TabsTrigger value="about">
              <Info aria-hidden />
              About
            </TabsTrigger>
            {canAsk && (
              <TabsTrigger value="ask">
                <MessagesSquare aria-hidden />
                Ask Claude
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>
        <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground" title={name}>
          {node || feature ? name : 'The whole system'}
        </span>
        {(node || feature) && (
          <Button variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground" aria-label="Back to the overview" title="Back to the overview" onClick={() => onSelect(null)}>
            <X aria-hidden />
          </Button>
        )}
      </div>
      {tab === 'ask' && canAsk ? (
        // One set of conversations per part: picking another part shows that part's own.
        <MapChat key={`${subject.type}:${subject.id}`} map={map} subject={subject} name={name} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex min-w-0 flex-col gap-4 px-5 pt-4 pb-8">
            {node ? (
              <NodeDetail map={map} node={node} onSelect={onSelect} fresh={fresh} onView={onView} />
            ) : feature ? (
              <FeatureDetail map={map} featureId={feature.id} onSelect={onSelect} fresh={fresh} view={view} onView={onView} />
            ) : (
              <Overview map={map} onSelect={onSelect} actions={actions} />
            )}
          </div>
        </div>
      )}
    </aside>
  )
}
