import hljs from 'highlight.js/lib/common'

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', md: 'markdown', mdx: 'markdown',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  rb: 'ruby', php: 'php', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', lua: 'lua', r: 'r', m: 'objectivec',
  diff: 'diff', patch: 'diff', makefile: 'makefile', mk: 'makefile'
}

export function languageFor(path: string): string | null {
  const name = path.split('/').pop()!.toLowerCase()
  if (name === 'makefile') return 'makefile'
  if (name === 'dockerfile' || name.endsWith('.sh')) return 'bash'
  const lang = BY_EXTENSION[name.split('.').pop() ?? '']
  return lang && hljs.getLanguage(lang) ? lang : null
}

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Highlight one line of a diff. Lines are highlighted on their own because a diff only has
 * fragments of the file, so a multi-line comment or string that starts outside the hunk is
 * coloured as code. The returned HTML is escaped by highlight.js.
 */
export function highlightLine(text: string, lang: string | null): string {
  if (!lang || text.length > 2000) return escape(text)
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
  } catch {
    return escape(text)
  }
}

/**
 * Highlight a fenced code block from markdown. `lang` is what follows the fence ("ts", "python",
 * "diff"); unknown or missing languages come back escaped and uncoloured.
 */
export function highlightBlock(text: string, lang: string | null): string {
  const name = lang ? (hljs.getLanguage(lang) ? lang : BY_EXTENSION[lang.toLowerCase()]) : null
  if (!name || !hljs.getLanguage(name) || text.length > 50_000) return escape(text)
  try {
    return hljs.highlight(text, { language: name, ignoreIllegals: true }).value
  } catch {
    return escape(text)
  }
}
