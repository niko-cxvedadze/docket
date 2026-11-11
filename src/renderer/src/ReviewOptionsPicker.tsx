import { useEffect, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { EFFORTS, VERBOSITIES, type ReviewOptions, type Settings } from '../../shared/types'

const EFFORT_LABEL = (e: string): string => (e === 'xhigh' ? 'Extra high' : e.charAt(0).toUpperCase() + e.slice(1))
/** "claude-opus-5-5" and "opus" both read as "Opus". */
const MODEL_LABEL = (m: string): string => {
  const known = ['fable', 'opus', 'sonnet', 'haiku'].find((name) => m.toLowerCase().includes(name))
  return known ? known.charAt(0).toUpperCase() + known.slice(1) : m
}

const MODELS = [
  { value: '', label: 'Default' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' }
]

/**
 * Which Claude drafts the review and how hard it thinks. The choice is saved as it is made, so the
 * next review, on any pull request, starts from it.
 */
export function ReviewOptionsPicker() {
  const [settings, setSettings] = useState<Settings | null>(null)
  // What "Default" means on this computer, so the option says which model and effort it will be.
  const [defaults, setDefaults] = useState({ model: '', effort: '' })
  useEffect(() => {
    void window.api.getSettings().then(setSettings, () => undefined)
    void window.api.reviewDefaults().then(setDefaults, () => undefined)
  }, [])
  if (!settings) return null
  const { review } = settings
  const set = (patch: Partial<ReviewOptions>): void => {
    const next = { ...settings, review: { ...review, ...patch } }
    setSettings(next)
    void window.api.saveSettings(next).then(setSettings, () => undefined)
  }
  // A model saved earlier that is not in the list (a full model name, say) stays selectable.
  const models = MODELS.some((m) => m.value === review.model) ? MODELS : [...MODELS, { value: review.model, label: review.model }]
  const modelDefault = defaults.model ? `Default (${MODEL_LABEL(defaults.model)})` : 'Default'
  const effortDefault = defaults.effort ? `Default (${EFFORT_LABEL(defaults.effort)})` : 'Default'
  return (
    <div className="review-options">
      <Option
        label="Model"
        value={review.model}
        onChange={(model) => set({ model })}
        options={models.map((m) => ({ value: m.value, label: m.value === '' ? modelDefault : m.label }))}
      />
      <Option
        label="Effort"
        value={review.effort}
        onChange={(effort) => set({ effort: effort as ReviewOptions['effort'] })}
        options={[{ value: '', label: effortDefault }, ...EFFORTS.map((e) => ({ value: e, label: EFFORT_LABEL(e) }))]}
      />
      <Option
        label="Detail"
        value={review.verbosity}
        onChange={(verbosity) => set({ verbosity: verbosity as ReviewOptions['verbosity'] })}
        options={VERBOSITIES.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))}
      />
    </div>
  )
}

/** The select cannot hold an empty value, so "use the default" travels under this name. */
const DEFAULT = '__default__'

function Option({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <Select value={value || DEFAULT} onValueChange={(v) => onChange(v === DEFAULT ? '' : v)}>
        <SelectTrigger size="sm" aria-label={label} className="w-full min-w-0 bg-background text-[13px] [&>span]:truncate">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          {options.map((o) => (
            <SelectItem key={o.value || DEFAULT} value={o.value || DEFAULT}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
