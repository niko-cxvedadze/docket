import type { Level, PrSummary } from '../../shared/types'

/** Either one pull request on its own, or a stack: pull requests that build on each other's branches. */
export interface Group {
  key: string
  /** In merge order: the first one targets the shared base branch, each next one targets the one before. */
  prs: PrSummary[]
  /** Branch the bottom of the stack merges into. */
  base: string
  level: Level
}

const rank: Record<Level, number> = { action: 0, ready: 1, waiting: 2 }

/**
 * Group pull requests into stacks. Two are stacked when, in the same repository, one's base branch
 * is the other's head branch. Order of the input is kept for groups and for siblings within a stack.
 */
export function groupStacks(prs: PrSummary[]): Group[] {
  const byHead = new Map(prs.map((p) => [`${p.repo}:${p.headRef}`, p]))
  const parentOf = (p: PrSummary): PrSummary | undefined => {
    const parent = byHead.get(`${p.repo}:${p.baseRef}`)
    return parent && parent.key !== p.key ? parent : undefined
  }
  const children = new Map<string, PrSummary[]>()
  for (const p of prs) {
    const parent = parentOf(p)
    if (parent) children.set(parent.key, [...(children.get(parent.key) ?? []), p])
  }

  const groups: Group[] = []
  const placed = new Set<string>()
  const rootOf = (p: PrSummary): PrSummary => {
    const seen = new Set<string>()
    let cur = p
    for (let parent = parentOf(cur); parent && !seen.has(parent.key); parent = parentOf(cur)) {
      seen.add(cur.key)
      cur = parent
    }
    return cur
  }
  for (const p of prs) {
    if (placed.has(p.key)) continue
    const root = rootOf(p)
    const members: PrSummary[] = []
    const walk = (node: PrSummary): void => {
      if (placed.has(node.key)) return
      placed.add(node.key)
      members.push(node)
      for (const child of children.get(node.key) ?? []) walk(child)
    }
    walk(root)
    groups.push({
      key: root.key,
      prs: members,
      base: root.baseRef,
      level: members.reduce<Level>((best, m) => (rank[m.level] < rank[best] ? m.level : best), 'waiting')
    })
  }
  return groups
}
