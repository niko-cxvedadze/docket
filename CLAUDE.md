# Docket

Electron + React desktop app: a dashboard of pull requests that need you, with Claude-drafted reviews.

## UI rules

- **Always use shadcn/ui components.** Every control in the renderer comes from `src/renderer/src/components/ui` (`Button`, `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `Label`, `Tabs`, `ToggleGroup`, `Tooltip`, `Card`, `Badge`, `Table`, ...). Do not write native `<select>`, `<input>`, `<textarea>`, `<button>` or hand-rolled equivalents.
- If the component you need is not in that folder yet, add the real one with `pnpm dlx shadcn@latest add <name>` (config is in `components.json`, style `new-york`) instead of building it from Radix primitives or plain HTML.
- Style with Tailwind classes and the theme tokens in `src/renderer/src/styles.css` (`bg-card`, `text-muted-foreground`, `border-input`, `text-ready`, `text-action`, `text-danger`, ...). Do not add new plain-CSS classes for controls.
- `Select` cannot hold an empty value: use a sentinel such as `__all__` for "no choice". Open dropdowns below the trigger with `<SelectContent position="popper" align="start">`.
- When you touch older code that still uses native controls or the plain-CSS classes (`.button`, `.field`, `.segmented`, parts of `PrView.tsx`), convert what you touch to shadcn.

## Checks

- `pnpm typecheck` after every change.
- Changes under `src/main` or `src/preload` need the dev app restarted; renderer changes hot-reload.
