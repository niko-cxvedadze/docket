export interface DiffRow {
  type: 'hunk' | 'add' | 'del' | 'ctx'
  oldLine?: number
  newLine?: number
  text: string
}

/** Parse the `patch` of one file (unified diff without file headers) into rows. */
export function parsePatch(patch: string | undefined): DiffRow[] {
  if (!patch) return []
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (m) {
        oldLine = Number(m[1])
        newLine = Number(m[2])
      }
      rows.push({ type: 'hunk', text: line })
    } else if (line.startsWith('+')) {
      rows.push({ type: 'add', newLine: newLine++, text: line.slice(1) })
    } else if (line.startsWith('-')) {
      rows.push({ type: 'del', oldLine: oldLine++, text: line.slice(1) })
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
    } else {
      rows.push({ type: 'ctx', oldLine: oldLine++, newLine: newLine++, text: line.slice(1) })
    }
  }
  return rows
}

/** Lines on the new side of the file that GitHub accepts an inline comment on. */
export function commentableLines(rows: DiffRow[]): Set<number> {
  const set = new Set<number>()
  for (const r of rows) if (r.newLine !== undefined && r.type !== 'del') set.add(r.newLine)
  return set
}
