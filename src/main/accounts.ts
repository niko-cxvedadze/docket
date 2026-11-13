import { execFile } from 'node:child_process'
import { run, toolEnv } from './env'
import { disabledAccounts, LOGIN, noteOriginalAccount, originalAccount, setAccountDisabled } from './settings'
import type { Account, Owned, PrSummary } from '../shared/types'

/**
 * The GitHub accounts Docket works with. Signing in stays with the gh CLI: it can hold several
 * accounts at once, and gives the token of any of them without changing which one a terminal uses.
 * Docket keeps no token on disk.
 *
 * Each pull request belongs to the account it was found with, and everything done to it afterwards
 * uses that account's token.
 */

type Found = Omit<Account, 'enabled'>

/** How long gh's answer about who is signed in is reused. It asks GitHub each time, so not on every refresh. */
const FRESH_MS = 60_000
const HOST = 'github.com'

let found: { at: number; accounts: Found[] } | null = null
let finding: Promise<Found[]> | null = null
const tokens = new Map<string, string>()

/** gh's output whether or not it exits cleanly: `gh auth status` fails when any one account's sign-in is broken. */
function ghText(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { env: toolEnv, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') reject(new Error('"gh" is not installed or not on PATH.'))
      else resolve(`${stdout}\n${stderr}`)
    })
  })
}

/** Reads the accounts out of `gh auth status`: one line per account, then details such as whether it is the active one. */
function parseStatus(text: string): Found[] {
  const out: Found[] = []
  let current: Found | null = null
  for (const line of text.split('\n')) {
    // "✓ Logged in to github.com account NAME (keyring)"; older versions say "as NAME".
    const m = line.match(/github\.com (?:account|as) (\S+)/)
    if (m && LOGIN.test(m[1])) {
      current = out.find((a) => a.login === m[1]) ?? null
      if (!current) {
        current = { login: m[1], active: false }
        out.push(current)
      }
      if (/failed to log in/i.test(line))
        current.problem = `gh's sign-in for ${m[1]} no longer works. Run "gh auth login" in a terminal to sign in again.`
    } else if (current && /active account:\s*true/i.test(line)) current.active = true
  }
  // gh before it could hold several accounts does not say which is active: the only one is.
  if (out.length === 1) out[0].active = true
  return out
}

const signInHelp = (e: unknown): Error =>
  new Error(`Could not get a GitHub token from the gh CLI. Run "gh auth login" in a terminal, then refresh. (${(e as Error).message})`)

/** The token of whichever account gh is using. */
const activeToken = (): Promise<string> =>
  run('gh', ['auth', 'token']).catch((e) => {
    throw signInHelp(e)
  })

async function discover(): Promise<Found[]> {
  const listed = parseStatus(await ghText(['auth', 'status', '--hostname', HOST]))
  if (listed.length) return listed
  // gh did not name anyone (signed in through GH_TOKEN, or an output this does not recognise): ask
  // GitHub who the token it does give belongs to.
  const token = (await activeToken()).trim()
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'docket-desktop' }
  })
  if (!res.ok) throw signInHelp(new Error(`GitHub ${res.status}`))
  const { login } = (await res.json()) as { login: string }
  tokens.set(login, token)
  return [{ login, active: true }]
}

async function ghAccounts(force = false): Promise<Found[]> {
  if (found && !force && Date.now() - found.at < FRESH_MS) return found.accounts
  finding ??= discover()
    .then((accounts) => {
      found = { at: Date.now(), accounts }
      // What Docket saved before it kept accounts apart was all made as the account gh was using.
      const active = accounts.find((a) => a.active)?.login
      if (active) noteOriginalAccount(active)
      // A token of an account that signed out must not be used again.
      for (const login of tokens.keys()) if (!accounts.some((a) => a.login === login)) tokens.delete(login)
      return accounts
    })
    .finally(() => (finding = null))
  return finding
}

const withEnabled = (accounts: Found[]): Account[] => {
  const off = new Set(disabledAccounts())
  return accounts.map((a) => ({ ...a, enabled: !off.has(a.login) }))
}

export const listAccounts = async (force = false): Promise<Account[]> => withEnabled(await ghAccounts(force))

/** The account the window names, once gh confirms it is signed in to it. Everything done per account goes through this. */
export async function signedIn(account: unknown): Promise<string> {
  if (typeof account !== 'string' || !(await ghAccounts()).some((a) => a.login === account)) throw new Error('Not a signed-in GitHub account.')
  return account
}

/** The account gh uses in a terminal goes first: the dashboard leaves its rows unlabelled and names the others. */
const activeFirst = (accounts: Account[]): Account[] => [...accounts.filter((a) => a.active), ...accounts.filter((a) => !a.active)]

const enabledLogins = (accounts: Account[]): string[] =>
  activeFirst(accounts)
    .filter((a) => a.enabled)
    .map((a) => a.login)

/** The accounts whose pull requests Docket shows, the one gh uses in a terminal first. Throws when there is none to show. */
export async function enabledAccounts(force = false): Promise<string[]> {
  const all = await listAccounts(force)
  const on = enabledLogins(all)
  if (!on.length)
    throw new Error(
      all.length
        ? 'Every GitHub account is switched off. Switch one on from the account menu in the top bar.'
        : 'No GitHub account is signed in. Run "gh auth login" in a terminal, then refresh.'
    )
  return on
}

/** The enabled accounts if gh was asked recently, without asking it again. Null when not known right now. */
export function enabledAccountsIfKnown(): string[] | null {
  if (!found || Date.now() - found.at >= FRESH_MS) return null
  return enabledLogins(withEnabled(found.accounts))
}

export async function setAccountEnabled(login: string, enabled: boolean): Promise<Account[]> {
  const all = await ghAccounts()
  if (!all.some((a) => a.login === login)) throw new Error(`${login} is not signed in to gh.`)
  if (!enabled && !withEnabled(all).some((a) => a.enabled && a.login !== login))
    throw new Error('At least one account has to stay switched on.')
  setAccountDisabled(login, !enabled)
  return withEnabled(all)
}

/** The token gh holds for one account. Kept in memory only, and asked for again after GitHub rejects it. */
export async function tokenFor(login: string): Promise<string> {
  const hit = tokens.get(login)
  if (hit) return hit
  if (!LOGIN.test(login)) throw new Error('Not a GitHub account name.')
  let out: string
  try {
    out = await run('gh', ['auth', 'token', '--hostname', HOST, '--user', login])
  } catch (e) {
    // A gh too old to pick an account, or one signed in through GH_TOKEN, only gives the active account's token.
    const active = (await ghAccounts().catch(() => [])).find((a) => a.active)?.login
    if (active !== login) throw signInHelp(e)
    out = await activeToken()
  }
  const token = out.trim()
  if (!token) throw signInHelp(new Error(`gh has no token for ${login}`))
  tokens.set(login, token)
  return token
}

export const dropToken = (login: string): void => void tokens.delete(login)

// ---------- Which account a pull request belongs to ----------
// The window asks about pull requests by repository and number. The lists it got them from say
// which account each one was found with, so that is remembered here.

const byPr = new Map<string, string>()
const byRepo = new Map<string, string>()

export function rememberAccounts(prs: PrSummary[]): void {
  for (const pr of prs) {
    if (!pr.account) continue
    byPr.set(pr.key, pr.account)
    // Your own pull request in a repository says more about which account works there than a review does.
    if (pr.role === 'mine' || !byRepo.has(pr.repo)) byRepo.set(pr.repo, pr.account)
  }
}

/** The account that listed a pull request in this repository, if any did. */
export const knownAccountForRepo = (repo: string): string | undefined => byRepo.get(repo)

/**
 * Whose something saved without an account is: a draft, a conversation, a checkout from before
 * accounts were kept apart. The account that lists its pull request or works in its repository;
 * failing that, the one Docket used back then.
 */
export const legacyOwner = (prKey?: string): string | undefined =>
  (prKey ? (byPr.get(prKey) ?? byRepo.get(prKey.replace(/#\d+$/, ''))) : undefined) ?? originalAccount()

/** Whose a saved draft, review or conversation is: what it says, or for an old one, whoever lists its pull request. */
export const ownerOf = (saved: Owned & { key: string }): string | undefined => saved.account ?? legacyOwner(saved.key)

/**
 * Marks what was saved before accounts were kept apart with the account whose list now shows its
 * pull request (`listed`: account by pull request key). True when anything was marked and needs saving.
 */
export function adoptOld(saved: Iterable<Owned & { key: string }>, listed: Map<string, string>): boolean {
  let tagged = false
  for (const s of saved) {
    const account = s.account ? undefined : listed.get(s.key)
    if (!account) continue
    s.account = account
    tagged = true
  }
  return tagged
}

/**
 * The account to act as on a pull request. `hint` is what the window says (the account on the pull
 * request it holds); it is only believed when gh really is signed in to that account.
 */
export async function accountFor(repo: string, number: number, hint?: unknown): Promise<string> {
  const all = await ghAccounts()
  const signedIn = (login: string | undefined): login is string => !!login && all.some((a) => a.login === login)
  if (typeof hint === 'string' && signedIn(hint)) return hint
  const known = byPr.get(`${repo}#${number}`) ?? byRepo.get(repo)
  if (signedIn(known)) return known
  return (await enabledAccounts())[0]
}
