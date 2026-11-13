import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { EFFORTS, VERBOSITIES, type ReviewOptions, type Settings } from '../../shared/types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

export const EFFORT_LABEL = (e: string): string => (e === 'xhigh' ? 'Extra high' : e.charAt(0).toUpperCase() + e.slice(1))
/** "claude-opus-5-5" and "opus" both read as "Opus". */
export const MODEL_LABEL = (m: string): string => {
  const known = ['fable', 'opus', 'sonnet', 'haiku'].find((name) => m.toLowerCase().includes(name))
  return known ? known.charAt(0).toUpperCase() + known.slice(1) : m
}
const MODELS = ['fable', 'opus', 'sonnet', 'haiku']

/** The radio group cannot hold an empty value, so "use the default" travels under this name. */
const DEFAULT = '__default__'

const LENGTH_LABEL: Record<ReviewOptions['verbosity'], string> = { brief: 'Brief', normal: 'Normal', detailed: 'Detailed' }

/**
 * One pill that says which Claude runs and how, opening a menu to change it. Reviews and questions
 * keep their own choice; it is saved as it is made, so the next run on any pull request starts from it.
 */
export function ClaudeOptions({ kind, disabled }: { kind: 'review' | 'chat' | 'map'; disabled?: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  // What "Default" means on this computer, so the option says which model and effort it will be.
  const [defaults, setDefaults] = useState({ model: '', effort: '' })
  useEffect(() => {
    void window.api.getSettings().then(setSettings, () => undefined)
    void window.api.reviewDefaults().then(setDefaults, () => undefined)
  }, [])
  if (!settings) return null
  // Settings saved before this kind existed have no entry for it yet.
  const options: ReviewOptions = settings[kind] ?? { model: '', effort: '', verbosity: 'normal' }
  const set = (patch: Partial<ReviewOptions>): void => {
    const next = { ...settings, [kind]: { ...options, ...patch } }
    setSettings(next)
    void window.api.saveSettings(next).then(setSettings, () => undefined)
  }
  // A model saved earlier that is not in the list (a full model name, say) stays selectable.
  const models = MODELS.includes(options.model) || !options.model ? MODELS : [...MODELS, options.model]
  const model = options.model ? MODEL_LABEL(options.model) : defaults.model ? MODEL_LABEL(defaults.model) : 'Default model'
  const effort = options.effort || defaults.effort
  // For a scan the same three steps set how many parts each Claude run studies: fewer runs, or a closer look.
  const lengthLabel = (v: ReviewOptions['verbosity']): string => (kind === 'map' ? { brief: 'Quick', normal: 'Standard', detailed: 'Thorough' }[v] : LENGTH_LABEL[v])
  const summary = [model, effort && EFFORT_LABEL(effort), options.verbosity !== 'normal' && lengthLabel(options.verbosity)]
    .filter(Boolean)
    .join(' · ')
  const lengthTitle = kind === 'chat' ? 'Answer length' : kind === 'map' ? 'Scan depth' : 'Review detail'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="secondary"
          size="xs"
          className="h-6 max-w-full min-w-0 rounded-full px-2.5 font-normal text-muted-foreground hover:text-foreground"
          title={`Model, effort and ${lengthTitle.toLowerCase()} for ${kind === 'chat' ? 'questions' : kind === 'map' ? 'system map scans' : 'reviews'}`}
        >
          <span className="truncate">{summary}</span>
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Model</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={options.model || DEFAULT} onValueChange={(v) => set({ model: v === DEFAULT ? '' : v })}>
          <DropdownMenuRadioItem value={DEFAULT} onSelect={(e) => e.preventDefault()}>
            Default{defaults.model ? ` (${MODEL_LABEL(defaults.model)})` : ''}
          </DropdownMenuRadioItem>
          {models.map((m) => (
            <DropdownMenuRadioItem key={m} value={m} onSelect={(e) => e.preventDefault()}>
              {MODELS.includes(m) ? MODEL_LABEL(m) : m}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Effort</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={options.effort || DEFAULT}
          onValueChange={(v) => set({ effort: v === DEFAULT ? '' : (v as ReviewOptions['effort']) })}
        >
          <DropdownMenuRadioItem value={DEFAULT} onSelect={(e) => e.preventDefault()}>
            Default{defaults.effort ? ` (${EFFORT_LABEL(defaults.effort)})` : ''}
          </DropdownMenuRadioItem>
          {EFFORTS.map((e) => (
            <DropdownMenuRadioItem key={e} value={e} onSelect={(ev) => ev.preventDefault()}>
              {EFFORT_LABEL(e)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">{lengthTitle}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={options.verbosity}
          onValueChange={(v) => set({ verbosity: v as ReviewOptions['verbosity'] })}
        >
          {VERBOSITIES.map((v) => (
            <DropdownMenuRadioItem key={v} value={v} onSelect={(e) => e.preventDefault()}>
              {lengthLabel(v)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
