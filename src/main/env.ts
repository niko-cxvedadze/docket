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
  opts: { cwd?: string; timeoutMs?: number } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: toolEnv, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 120_000 },
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
