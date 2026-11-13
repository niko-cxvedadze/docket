import { useEffect, useState } from 'react'
import { SUMMARY_LENGTHS, type Settings as SettingsData, type SummaryLength } from '../../shared/types'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ago, cleanError } from './util'

const SUMMARY_LABEL: Record<SummaryLength, string> = { concise: 'Concise', standard: 'Standard', detailed: 'Detailed' }
const SUMMARY_HINT: Record<SummaryLength, string> = {
  concise: 'One or two short sentences: the verdict and anything no comment covers.',
  standard: 'Up to four sentences.',
  detailed: 'Up to six sentences, with room to explain concerns about the approach.'
}

const PLACEHOLDER = `Describe how you write review comments, for example:

- Short and direct, one or two sentences. No greetings.
- Lowercase openers, few exclamation marks.
- Ask "can we…?" rather than "you should…".
- Say "nit:" before minor things.

Examples
- "can we move this into the service? the router is getting heavy"
- "nit: naming, this reads like a boolean"`

/** One account's reviewer voice. Each account has its own; the page is made anew when the account changes. */
export function Settings({ account }: { account: string }) {
  const [saved, setSaved] = useState<SettingsData | null>(null)
  const [draft, setDraft] = useState<SettingsData | null>(null)
  const [learning, setLearning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    window.api.getSettings().then(
      (s) => {
        setSaved(s)
        setDraft(s)
      },
      (e) => setError(cleanError(e))
    )
  }, [])

  if (!draft || !saved)
    return <main className="flex-1 px-7 pt-5 text-muted-foreground">{error ?? 'Loading settings…'}</main>

  // Until the account has a voice of its own it shows the one from before accounts were kept apart; saving makes it its own.
  const voice = draft.voices[account] ?? draft.voice
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const setVoice = (patch: Partial<SettingsData['voice']>): void => {
    setNote(null)
    setDraft({ ...draft, voices: { ...draft.voices, [account]: { ...voice, ...patch } } })
  }

  const save = async (): Promise<void> => {
    try {
      const s = await window.api.saveSettings(draft)
      setSaved(s)
      setDraft(s)
      setError(null)
      setNote(`Saved. Reviews ${account} starts from now on use it.`)
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const learn = async (): Promise<void> => {
    setLearning(true)
    setError(null)
    setNote(null)
    try {
      const { guide, samples } = await window.api.learnVoice(account)
      setDraft(
        (d) =>
          d && {
            ...d,
            voices: {
              ...d.voices,
              [account]: { ...(d.voices[account] ?? d.voice), guide, enabled: true, learnedAt: new Date().toISOString(), learnedFrom: samples }
            }
          }
      )
      setNote(`Drafted from ${samples} of your review comments. Read it over, edit what is off, then save.`)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setLearning(false)
    }
  }

  return (
    <main className="flex-1 overflow-auto px-7 pt-5 pb-10">
      <div className="mb-5 flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="mr-auto min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Reviewer voice</h1>
          <p className="mt-1 max-w-[75ch] text-sm text-muted-foreground">
            Claude drafts review comments for <span className="font-medium text-foreground">{account}</span> in the
            voice described here, so they read like you wrote them. The voice changes wording only, never what gets
            flagged. Each account has its own.
          </p>
        </div>
        <Label className="gap-2 text-sm font-medium">
          <Switch checked={voice.enabled} onCheckedChange={(v) => setVoice({ enabled: v })} />
          Draft comments in my voice
        </Label>
      </div>

      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <Label className="text-sm font-medium">Summary length</Label>
          <div className="flex flex-wrap items-center gap-3">
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={voice.summaryLength}
              onValueChange={(v) => v && setVoice({ summaryLength: v as SummaryLength })}
              aria-label="Summary length"
            >
              {SUMMARY_LENGTHS.map((l) => (
                <ToggleGroupItem key={l} value={l} className="px-3 text-xs">
                  {SUMMARY_LABEL[l]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <span className="text-xs text-muted-foreground">
              {SUMMARY_HINT[voice.summaryLength]} Applies to new reviews, with or without your voice.
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" disabled={learning} onClick={() => void learn()}>
            {learning ? 'Reading your comments…' : 'Learn from my GitHub comments'}
          </Button>
          <span className="text-xs text-muted-foreground">
            Reads the review comments {account} wrote on GitHub recently and writes the guide for you. {voice.guide.trim() ? 'This replaces the text below.' : ''}
          </span>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="voice-guide" className="text-sm font-medium">
            Voice guide
          </Label>
          <Textarea
            id="voice-guide"
            value={voice.guide}
            onChange={(e) => setVoice({ guide: e.target.value })}
            placeholder={PLACEHOLDER}
            disabled={learning}
            className="min-h-[50vh] bg-card text-sm leading-relaxed md:text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Plain text, written however you like. A few real comments of yours under “Examples” help more than
            adjectives do.
            {voice.learnedAt && ` Last learned ${ago(voice.learnedAt)}${voice.learnedFrom ? ` from ${voice.learnedFrom} comments` : ''}.`}
          </p>
        </div>

        {error && (
          <div className="banner error !m-0" role="alert">
            {error}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={!dirty || learning} onClick={() => void save()}>
            Save
          </Button>
          {dirty && (
            <Button variant="ghost" size="sm" disabled={learning} onClick={() => setDraft(saved)}>
              Discard changes
            </Button>
          )}
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {note ?? (dirty ? 'Unsaved changes.' : '')}
          </span>
        </div>
      </div>
    </main>
  )
}
