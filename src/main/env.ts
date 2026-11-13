import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Apps launched from Finder get a bare PATH, so add the usual install locations.
const extra = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(homedir(), '.local/bin'),
  join(homedir(), '.claude/local'),
  join(homedir(), '.bun/bin')
]
export const toolEnv: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: [...extra, process.env.PATH ?? ''].join(':')
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; /** Added to the environment of this one command. */ env?: NodeJS.ProcessEnv } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env ? { ...toolEnv, ...opts.env } : toolEnv, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 120_000 },
      (err, stdout, stderr) => {
        if (err) {
          const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
          reject(
            new Error(
              missing
                ? `"${cmd}" is not installed or not on PATH.`
                : (stderr || err.message).toString().trim().slice(0, 600)
            )
          )
        } else resolve(stdout.toString())
      }
    )
  })
}

/** A queue per key: the jobs of one key run one after another, whether or not the one before failed. */
export function keyedQueue(): <T>(key: string, job: () => Promise<T>) => Promise<T> {
  const chains = new Map<string, Promise<unknown>>()
  return (key, job) => {
    const next = (chains.get(key) ?? Promise.resolve()).then(job, job)
    chains.set(key, next.catch(() => undefined))
    return next
  }
}

/** One job per key at a time: whoever asks while it runs gets the same promise. */
export function shared<T>(running: Map<string, Promise<T>>, key: string, start: () => Promise<T>): Promise<T> {
  let job = running.get(key)
  if (!job) {
    job = start().finally(() => running.delete(key))
    running.set(key, job)
  }
  return job
}
