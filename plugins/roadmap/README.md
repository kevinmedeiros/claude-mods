# roadmap

Where the project stands on its roadmap, right above the prompt: the current phase and its progress, the next task, what you can do now, and a warning when commits run ahead of the roadmap. Claude keeps it current with three tools, so nobody edits the JSON by hand.

See the [main README](../../README.md#roadmap) · [Português](../../README.pt-BR.md#roadmap).

```
/plugin install roadmap --marketplace kevinmedeiros/claude-mods
```

## What it shows

- **Above the prompt** (terminal and Claude Desktop, stacked with the other mods' bands): *"Roadmap · Phase 2 Closed beta · 16% · Next: Email sign-in (Claude) · 1 with you now"*, with **Do next** (writes the request for you), **View roadmap** and **Hide** (hidden until the roadmap changes or the next session). The next task's title is cut at 55 characters (the pane shows it whole), and *with you now* counts only your items of the current phase that you can start: not blocked and with their dependencies done. Desktop adds a progress bar. Nothing is drawn in a project without a roadmap.
- **`/roadmap`** opens the pane: project, goal and last update; every phase with its state, % and bar, the current one highlighted; up to five *next* tasks with who does them and an **Ask Claude** button; what is *with you now* and *with you later* (blocked, or waiting on a dependency); what is *waiting* and on what; the current phase's items by state, with only the last three done; open decisions of the current phase and those without a phase. Each list shows six items and *"… and N more"*; other phases appear only as counts, so a roadmap of hundreds of items stays readable.
- **Status line:** *"Phase 2 · 16%"*.
- **Stale warning:** how many commits the project has since the last commit that touched the roadmap (`git rev-list --count <that commit>..HEAD`). Above the limit (10 by default) the band and the pane say *"roadmap out of date: 14 commits without an update"*. No warning without git, for a roadmap never committed, or while the roadmap has uncommitted changes.
- **Tools for Claude:**
  - `roadmap_status {query?, phase?, all?}`: on its own, the current phase and %, the next five tasks with their ids, what is with you now and later, what is waiting, the open decisions (eight per list, other phases as counts) and the stale warning. `query` finds items by words of the title or the id (up to ten, with state, owner, phase and notes), so Claude gets the id of any item; `phase` lists a whole phase; `all: true` drops the cuts. Without a roadmap it says where to create one, with a template and what every field means.
  - `roadmap_update {id, status, evidence?, doneAt?, note?, waitingOn?}`: changes one item. Refuses an unknown id or status. `done` without `doneAt` uses today's date; leaving `done` drops the date. Given a phase id, it changes the phase (`done`, `doing` or `todo`) and `evidence` becomes its `gateStatus`.
  - `roadmap_add {phase, title, owner?, after?, status?, dependsOn?, ...}`: creates an item with an id made from the title (never repeated). `after` puts it right after another item, in the file and in the path; without it the item goes to the end of its phase. Refuses an unknown phase, dependency or `after`, and a title the phase already has.
  - Every change shows a toast. Changes are written one at a time, so two calls at once (subagents in parallel) both land; if another program writes the file between the read and the write, the change is applied again on the new text.
- **After a `git commit`** that Claude runs, it reads a short reminder that the project has a roadmap and that what the commit finished is checked off with `roadmap_update` (with the stale warning, when there is one). Nothing when the commit itself touched the roadmap, or with `claudeCanEdit` off.
- **Do next** and **Ask Claude** write a different request for Claude's items (mark it in progress, do it, mark it done with the evidence), for yours (Claude walks you through it and marks it done when you say so) and for `both` (Claude does its part, tells you yours, and marks it done only when both are), with the item's notes.
- **Reloads** when a tool writes the file, right after Claude edits it with Edit or Write, and within 15 seconds of any other change (it checks the file's modification time). The commit count is refreshed after each turn, at most once a minute, and every 5 minutes.

## The file

`docs/roadmap.json` from the git root (or the session's folder without git); change it with the `file` option. Format version 1:

| Field | |
|---|---|
| `version` | `1` |
| `project`, `goal` | Shown in the pane's header (`goal` as in *"until the beta"*). |
| `updated` | `YYYY-MM-DD`. The tools set it on every change. |
| `owner` | Who *you* are in the items: items owned by this name (any case) or by `both` are *with you*. |
| `phases[]` | `id`, `name`, `goal`, `status` (`done`, `doing` or `todo`; `todo` when missing), `gate`, `gateStatus`, `notes`. |
| `items[]` | `id` (unique), `phase` (a phase id), `title`, `status` (`done`, `doing`, `todo` or `blocked`), `owner` (`Claude`, your name or `both`), `waitingOn`, `dependsOn` (item ids), `doneAt`, `evidence`, `area`, `gate` (`true` for an item of the phase's gate), `notes`. |
| `path` | Item ids in the order you want them done. |
| `openDecisions[]` | `title`, `phase`, `ref`. |

Fields the mod does not know are kept as they are.

**How it reads the file:**
- **Current phase:** the first `doing` phase, otherwise the first one that is not `done`.
- **Progress:** done items ÷ the phase's items, rounded down, so 100% means everything is done.
- **Next:** items not done, not blocked and whose dependencies are done, in `path` order and then in file order, up to five.
- **With you:** items not done whose `owner` is the file's `owner` or `both`. *Now* are those of the current phase that are not blocked and whose dependencies are done; *later*, the rest of the current phase; other phases are a count.
- **Waiting:** `blocked` items of the current phase, with `waitingOn` and the dependencies still open; other phases are a count.

An invalid file is never rewritten. The band says the roadmap has an error, with the line and the reason, the pane shows it, and the tools refuse to write until it is fixed.

**How it writes the file:** in place. Only the values that change are touched: a new key goes next to its neighbours (on its own line, or on the same line in an object written on one line), a new item follows the layout of the item before it, and lists keep their own layout. The key order of the format decides where a new key goes. The file keeps its line endings (LF or CRLF) and final newline, and is written as UTF-8 without BOM. In the rare case a change cannot be made in place (an object with a repeated key, for example), the whole file is written in the mod's layout: two-space indentation, short lists of plain values on one line. Only valid JSON is written, and no item is ever deleted.

### Example

```json
{
  "version": 1,
  "project": "Lighthouse",
  "goal": "until the beta",
  "updated": "2026-10-12",
  "owner": "Sam",
  "phases": [
    { "id": "1", "name": "Prototype", "status": "done" },
    {
      "id": "2",
      "name": "Closed beta",
      "goal": "ten people using it",
      "status": "doing",
      "gate": "ten people use it for a week",
      "gateStatus": "pending"
    },
    { "id": "3", "name": "Launch", "status": "todo" }
  ],
  "items": [
    { "id": "home-screen", "phase": "1", "title": "Home screen", "status": "done", "owner": "Claude", "doneAt": "2026-09-20", "evidence": "commit abc123" },
    { "id": "sync-notes", "phase": "2", "title": "Sync notes", "status": "done", "owner": "Claude", "doneAt": "2026-10-02" },
    { "id": "email-sign-in", "phase": "2", "title": "Email sign-in", "status": "doing", "owner": "Claude", "dependsOn": ["sync-notes"] },
    { "id": "invite-testers", "phase": "2", "title": "Invite the testers", "status": "todo", "owner": "Sam", "dependsOn": ["email-sign-in"], "gate": true },
    { "id": "store-account", "phase": "2", "title": "Developer account on the store", "status": "blocked", "owner": "both", "waitingOn": "card approval" },
    { "id": "dark-mode", "phase": "2", "title": "Dark mode", "status": "todo", "owner": "Claude", "area": "ui" },
    { "id": "pick-icon", "phase": "2", "title": "Pick the app icon", "status": "todo", "owner": "Sam" },
    { "id": "publish", "phase": "3", "title": "Publish on the store", "status": "todo", "owner": "both", "dependsOn": ["store-account"] }
  ],
  "path": ["email-sign-in", "dark-mode", "invite-testers"],
  "openDecisions": [{ "title": "Charge a subscription?", "phase": "3", "ref": "docs/pricing.md" }]
}
```

Here the current phase is 2 at 16% (1 of 6 items), and the next tasks are *Email sign-in*, *Dark mode* and *Pick the app icon* (*Invite the testers* waits for sign-in). One item is with Sam now, the icon; two come later, the testers (after sign-in) and the store account (blocked); publishing is one more in another phase. When Claude marks *Email sign-in* done, only that line and `updated` change, and the items stay one per line.

## Options

| Option | Default | |
|---|---|---|
| `file` | `docs/roadmap.json` | Relative to the git root, or absolute |
| `showBand` | `true` | The line above the prompt |
| `staleAfter` | `10` | Commits without touching the roadmap before the warning; `0` turns it off |
| `claudeCanEdit` | `true` | Gives Claude `roadmap_update` and `roadmap_add`; `roadmap_status` is always there |

The interface is in Brazilian Portuguese, like the other mods in this repository.
