# Docket

Electron + React desktop app: a dashboard of pull requests that need you, with Claude-drafted reviews.

## UI rules

- **Always use shadcn/ui components.** Every control in the renderer comes from `src/renderer/src/components/ui` (`Button`, `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `Label`, `Tabs`, `ToggleGroup`, `Tooltip`, `Card`, `Badge`, `Table`, ...). Do not write native `<select>`, `<input>`, `<textarea>`, `<button>` or hand-rolled equivalents.
- If the component you need is not in that folder yet, add the real one with `pnpm dlx shadcn@latest add <name>` (config is in `components.json`, style `new-york`) instead of building it from Radix primitives or plain HTML.
- Style with Tailwind classes and the theme tokens in `src/renderer/src/styles.css` (`bg-card`, `text-muted-foreground`, `border-input`, `text-ready`, `text-action`, `text-danger`, ...). Do not add new plain-CSS classes for controls.
- `Select` cannot hold an empty value: use a sentinel such as `__all__` for "no choice". Open dropdowns below the trigger with `<SelectContent position="popper" align="start">`.
- When you touch older code that still uses native controls or the plain-CSS classes (`.button`, `.field`, `.segmented`, parts of `PrView.tsx`), convert what you touch to shadcn.

## User data: never wipe it

The app's data folder (`~/Library/Application Support/docket/`) and its backups (`~/.docket/backups/`) hold the user's real work. Review drafts (`drafts.json`), posted reviews (`reviews.json`), conversations with Claude (`chats.json`), settings (`settings.json`, `theme.json`) and daily snapshots (`snapshots.json`) cannot be fetched again from GitHub.

- **Never delete, move, empty or overwrite anything in those two folders**: no `rm`, no `mv`, no hand edits, no "clean start" to test something. This includes the repository clones in `repos/` and the checkouts in `worktrees/`. If a task really needs it, ask the user first and say exactly what would be removed.
- **Never use the app's Storage page Clear/Delete buttons, "Discard draft" or "Delete conversation"** while testing, and never start the app with a different or temporary `userData` path.
- **Never commit or push anything from those folders.**
- Read and write the user's own data only through `src/main/persist.ts` (`readStore` / `writeStore`). It writes atomically, keeps versioned backups outside the data folder (the last 50 versions, then one per hour for two days), and restores the newest backup when a file is missing or damaged. A new kind of user data gets a `StoreName` there; caches that can be fetched again (`prs.json`, `performance.json`) do not need it.
- Clearing data on purpose writes an empty value with `writeStore`; it never deletes the file. A missing file must only ever mean lost data, which is what makes restoring a backup safe.
- When a change alters the shape of stored data, read the old shape and migrate it (see `load()` in `src/main/chat.ts`). Never drop entries you cannot parse.
- Anything in the UI that deletes the user's work asks first, with the `Confirm` dialog (`src/renderer/src/Confirm.tsx`).
- Restarting the dev app (`pkill`, Ctrl-C) is safe: writes are atomic, so nothing is half-written.

## Checks

- `pnpm typecheck` after every change.
- Changes under `src/main` or `src/preload` need the dev app restarted; renderer changes hot-reload.
