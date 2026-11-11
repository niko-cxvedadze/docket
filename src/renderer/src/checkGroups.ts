import type { FailingCheck } from '../../shared/types'

export interface CheckGroup {
  key: string
  /** The GitHub Actions workflow; null for a check that is not part of one (shown on its own). */
  workflow: string | null
  /** Each failed job, labelled without the workflow name in front. */
  checks: { check: FailingCheck; label: string }[]
  /** True when any job is required, false when none is, null when GitHub did not say. */
  required: boolean | null
  /** Workflow runs whose failed jobs can be re-run. */
  runIds: number[]
}

// Lists saved by older versions have no workflow field; their names read "Workflow / job".
const workflowOf = (c: FailingCheck): string | null =>
  c.workflow !== undefined ? c.workflow : c.jobId != null && c.name.includes(' / ') ? c.name.split(' / ')[0] : null

/** Failed checks grouped by workflow, in the order they came (required failures first). */
export function groupChecks(checks: FailingCheck[]): CheckGroup[] {
  const groups = new Map<string, CheckGroup>()
  checks.forEach((check, i) => {
    const workflow = workflowOf(check)
    const key = workflow ? `wf:${workflow}` : `check:${check.name}:${i}`
    let g = groups.get(key)
    if (!g) {
      g = { key, workflow, checks: [], required: null, runIds: [] }
      groups.set(key, g)
    }
    const prefix = `${workflow} / `
    g.checks.push({ check, label: workflow && check.name.startsWith(prefix) ? check.name.slice(prefix.length) : check.name })
    if (check.required === true) g.required = true
    else if (check.required === false && g.required === null) g.required = false
    if (check.runId != null && !g.runIds.includes(check.runId)) g.runIds.push(check.runId)
  })
  return [...groups.values()]
}
