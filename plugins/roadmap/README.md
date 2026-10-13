# roadmap

Where the project stands on its roadmap, at a glance: one line above the prompt with the current phase, its progress and the next task, and a `/roadmap` pane that draws the phases as a trail and the work as a small kanban board. Claude keeps it current with three tools, so nobody edits the JSON by hand.

See the [main README](../../README.md#roadmap) · [Português](../../README.pt-BR.md#roadmap).

```
/plugin install roadmap --marketplace kevinmedeiros/claude-mods
```

## What it shows

The interface is in Brazilian Portuguese, like the other mods in this repository; it is shown here in English.

### Above the prompt

One line, in the terminal and in Claude Desktop, stacked with the other mods' bands:

```
Phase 2 ▰▰▱▱▱▱▱▱▱▱ 16%  › Email sign-in (Claude)  mine: 3 [ Do it ] [ Roadmap ] hide
```

- **What it holds:** the phase, a ten-cell bar (a drawn bar on Desktop), the %, the next task's short label with who does it, how many cards on the board are yours (the same number as *Mine* in the pane), and an out-of-date chip when the roadmap is behind.
- **Buttons:** **Do it** writes the request for Claude into the prompt, **Roadmap** opens the pane, and **hide** (*Hide* on Desktop, drawn as the surface's own close button) hides the line until the roadmap changes or the next session.
- **Narrow windows:** the line never wraps, and the task's label stays whole as long as it can. To make room, the out-of-date chip goes first, then *mine: N*, the owner, the bar, the buttons' frames (*Roadmap* becomes *View*) and *Phase N*. Only then is the label cut, so a wider window never shows less of it.

Nothing is drawn in a project without a roadmap.

### The pane

`/roadmap` opens it. This is the [example](#example) at 100 columns:

```
Lighthouse                                                                                         ↻

●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━◉ 16% ━━━━━━━━━━━━━━━━━━━━━━━━━━━○
1 Prototype                      2 Closed beta                    3 Launch

╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
│ Phase 2 · Closed beta                                                         ⚑ Gate 2 · pending │
│ ██████████████▒▒▒▒▒▒░░░░░░░░░░░░░░░░░░░░ 16%                                                     │
│ 1 ✓  1 ▶  1 ‖  3 ○                                                                               │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯

[ All ] [ Mine 3 ]

Now 1                    Next 2                   Waiting 2                Done 1
╭──────────────────────╮ ╭──────────────────────╮  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  ╭──────────────────────╮
│ Email sign-in        │ │ Dark mode            │ ╎ Store account        ╎ │ Sync notes           │
│ Claude               │ │ Claude               │ ╎ ‖ card approval      ╎ ╰──────────────────────╯
╰──────────────────────╯ ╰──────────────────────╯  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
                         ╭──────────────────────╮  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
                         │ Pick the app icon    │ ╎ Invite the testers   ╎
                         │ you                  │ ╎ after Email sign-in  ╎
                         ╰──────────────────────╯  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
```

From top to bottom, with no lists of text:

- **Phase trail:** one node per phase with its short label underneath.
  - **Desktop, VS Code and mobile:** a drawn stepper. A done phase is a green node with a check, the current one is highlighted with its number and its %, a phase in progress that is not the current one has an orange ring, and a phase to do is an empty ring with its number.
  - **Terminal:** two or three lines of glyphs: ● done, ◉ current with its %, ◐ in progress, ○ to do. The label shows "id name" when it fits, then the name alone, then the name in two lines; it is cut with "…" but a word is never split across lines. With many phases, it shows a window around the current one.
- **Current phase card:** the phase and its short name, a gate chip (*Gate 2 · pending*: the `gateStatus` up to its first punctuation; just *Gate 2* when narrow), a bar split into done, in progress and waiting (▒, lighter on Desktop), the %, and the counts (done ✓, in progress ▶, waiting ‖, to do ○).
- **All / Mine N:** *Mine* keeps only your items and the `both` ones.
- **Board:**
  - **Now:** every item in progress, the current phase's first. A card from another phase says which.
  - **Next:** the items you can start (not blocked, dependencies done), in `path` order, from any phase. An item outside the `path` comes right after the path's items of its own phase.
  - **Waiting:** the current phase's blocked items, then its to-do items waiting for another task. Both have a dashed border and say what they wait on: *‖ card approval* for a blocked one, *after Email sign-in* for one waiting on a dependency.
  - **Done:** the current phase's done items, the latest first: by `doneAt`, and on the same day the one the mod saw finished last.
- **Cards:** each column shows up to four (three in *Done*). **+8 of N** shows eight more at a time and **less** folds the column back. A card is the item's short label, in up to two lines and cut with "…" (at the end of a word when it can), and one line with the owner (*you*, *Claude*, *both* or the name), *Gate* and the phase when it is another one, or what it waits on.
- **Layout:** four columns side by side from 96 columns, a 2×2 grid from 60, and stacked below that, with *Done* as a single count line.
- **Opening a card:** clicking a card opens it in place, with a heavy border:

  ```
  ┏━━━━━━━━━━━━━━━━━━━━━━┓
  ┃ Email sign-in        ┃
  ┃ ▶ in progress        ┃
  ┃ Claude               ┃
  ┃ [ Do it now ]        ┃
  ┃ [ Close ]            ┃
  ┗━━━━━━━━━━━━━━━━━━━━━━┛
  ```

  Without a `short`, the label grows into the whole title (up to four lines); with one, the title shows underneath, minus what the label already says. It also shows the state, the owner, the phase when it is not the current one, *Gate*, what it waits on, the open dependencies, the date and evidence, and the notes. **Do it now** writes the request. On a blocked or waiting item the button is **See what's missing**: Claude finds out what holds it and with whom, without starting it. **Close**, or clicking the card again, closes it. When the open card leaves the board (its column folded back), the detail moves to a box above the board, with the whole title.
- **Footer:** a **Decisions N** chip that opens up to five open decisions (of the current phase and those without a phase), and the out-of-date chip.

A roadmap of hundreds of items draws the same pane. In the tests, a 300-item roadmap went from 5,342 characters of text in the 0.1.0 pane to 825 in the terminal and 607 on Desktop.

### Status line and command

- **Status line:** *"Phase 2 · 16%"*.
- **`/roadmap`** also answers in one line: *"Phase 2 · 16% · next: Email sign-in"*.

### Out-of-date warning

The mod counts the commits since the last commit that touched the roadmap (`git rev-list --count <that commit>..HEAD`). Above the limit (10 by default), the band and the pane show *"14 commits without an update"*. There is no warning without git, for a roadmap never committed, or while the roadmap has uncommitted changes.

### Tools for Claude

- **`roadmap_status {query?, phase?, all?}`**
  - On its own: the current phase and %, the next five tasks with their ids, what is with you now and later, what is waiting, the open decisions and the out-of-date warning. Each list has eight items, and other phases appear as counts.
  - It also points out the current phase's items that have a title over 40 characters and no `short`, and the phases whose label is over 18 characters.
  - `query` finds items by words of the title, the `short` or the id: up to ten, with state, owner, phase, short label and notes. This gives Claude the id of any item.
  - `phase` lists a whole phase. `all: true` drops the cuts.
  - Without a roadmap, it says where to create one, with a template and what every field means.
- **`roadmap_update {id, status?, evidence?, doneAt?, note?, waitingOn?, short?}`** changes one item.
  - It refuses an unknown id or status, and a `doneAt` for an item that is not done and is not being marked done.
  - `done` without `doneAt` uses today's date. Leaving `done` drops the date. A call that only sets `short`, a note or `waitingOn` leaves the state and the date alone.
  - `short` sets the card's label; `""` removes it.
  - Given a phase id, it changes the phase (`done`, `doing` or `todo`) and its `short`, and `evidence` becomes its `gateStatus`.
- **`roadmap_add {phase, title, short?, owner?, after?, status?, dependsOn?, ...}`** creates an item, with an id made from the title (never repeated).
  - `after` puts it right after another item, in the file and in the path. Without it, the item goes to the end of its phase.
  - It refuses an unknown phase, dependency or `after`, a title the phase already has, and a `short` over 60 characters.
- **Every change shows a toast.**
  - Changes are written one at a time, so two calls at once (subagents in parallel) both land.
  - If another program writes the file between the read and the write, the change is applied again on the new text.
- **After a `git commit`** that Claude runs, it reads a short reminder that the project has a roadmap and that it should check off what the commit finished with `roadmap_update`. The reminder carries the out-of-date warning when there is one. There is no reminder when the commit itself touched the roadmap, or with `claudeCanEdit` off.

### Requests and reloads

**Do it** and **Do it now** write a different request for each kind of owner, with the item's notes:
- **Claude's items:** mark it in progress, do it, and mark it done with the evidence.
- **Your items:** Claude walks you through it and marks it done when you say so.
- **`both`:** Claude does its part, tells you yours, and marks it done only when both parts are.
- **Blocked or waiting items** (*See what's missing*): Claude checks what holds the item and with whom, and does not start it. A blocked item whose block is gone goes back to *to do*, with a note.

The mod **reloads** the file:
- when a tool writes it;
- right after Claude edits it with Edit or Write;
- within 15 seconds of any other change (it checks the file's modification time).

The commit count is refreshed after each turn (at most once a minute) and every 5 minutes.

## The file

`docs/roadmap.json` from the git root (or the session's folder without git); change it with the `file` option. Format version 1:

| Field | |
|---|---|
| `version` | `1` |
| `project`, `goal` | `project` is the pane's header. |
| `updated` | `YYYY-MM-DD`. The tools set it on every change. |
| `owner` | Who *you* are in the items: items owned by this name (any case) or by `both` are *yours* (the *Mine* filter, *you* on the cards). |
| `phases[]` | `id`, `name`, `short` (the label on the trail), `goal`, `status` (`done`, `doing` or `todo`; `todo` when missing), `gate`, `gateStatus`, `notes`. |
| `items[]` | `id` (unique), `phase` (a phase id), `title`, `short` (the card's label), `status` (`done`, `doing`, `todo` or `blocked`), `owner` (`Claude`, your name or `both`), `waitingOn`, `dependsOn` (item ids), `doneAt`, `evidence`, `area`, `gate` (`true` for an item of the phase's gate), `notes`. |
| `path` | Item ids in the order you want them done. |
| `openDecisions[]` | `title`, `phase`, `ref`. |

Fields the mod does not know are kept as they are.

**Short labels.** `short` is optional:
- **On an item,** it is what the card and the band show. Aim for 40 characters or fewer (60 at most). Without it, the title is cut at 40, at the end of a word when that keeps at least half of it.
- **On a phase,** it is the label on the trail and on the phase card. Aim for 18 characters or fewer (60 at most): seven phases of 18 fit a 120-column trail without a cut. Without it, the name is cut at 18.
- **Errors:** a `short` that is empty, is not text, or is over 60 characters is an error, reported with its line.

**How it reads the file:**
- **Current phase:** the first `doing` phase, otherwise the first one that is not `done`.
- **Progress:** done items ÷ the phase's items, rounded down, so 100% means everything is done.
- **Next:** items not done, not blocked and whose dependencies are done, in `path` order and then in file order. The band shows the first one; the board's *Next* column shows those still to do.
- **Yours:** items whose `owner` is the file's `owner` or `both`. *Mine N* (and *mine: N* on the band) counts yours in *Now*, *Next* and *Waiting*.
- **Waiting:** the current phase's `blocked` items, with their `waitingOn` (or the first dependency still open), then its `todo` items with a dependency still open.

An invalid file is never rewritten. The band says the roadmap has an error, with the line and the reason, the pane shows it, and the tools refuse to write until it is fixed.

**How it writes the file:**
- **In place:** only the values that change are touched.
- **New keys and items:** a new key goes next to its neighbours, on its own line or on the same line in an object written on one line; the key order of the format decides where. A new item follows the layout of the item before it, and lists keep their own layout.
- **Encoding:** the file keeps its line endings (LF or CRLF) and final newline, and is written as UTF-8 without BOM.
- **Fallback:** in the rare case a change cannot be made in place (an object with a repeated key, for example), the whole file is written in the mod's layout: two-space indentation, short lists of plain values on one line.
- **Safety:** only valid JSON is written, and no item is ever deleted.

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
    { "id": "store-account", "phase": "2", "title": "Open the developer account on the app store with the company card", "short": "Store account", "status": "blocked", "owner": "both", "waitingOn": "card approval" },
    { "id": "dark-mode", "phase": "2", "title": "Dark mode", "status": "todo", "owner": "Claude", "area": "ui" },
    { "id": "pick-icon", "phase": "2", "title": "Pick the app icon", "status": "todo", "owner": "Sam" },
    { "id": "publish", "phase": "3", "title": "Publish on the store", "status": "todo", "owner": "both", "dependsOn": ["store-account"] }
  ],
  "path": ["email-sign-in", "dark-mode", "invite-testers"],
  "openDecisions": [{ "title": "Charge a subscription?", "phase": "3", "ref": "docs/pricing.md" }]
}
```

Here the current phase is 2 at 16% (1 of 6 items), and the board shows:
- **Now:** *Email sign-in*.
- **Next:** *Dark mode* and *Pick the app icon*. *Publish on the store* is not there: it waits for the store account, and it belongs to phase 3.
- **Waiting:** *Store account*, the item's `short`, blocked on the card approval; then *Invite the testers*, after *Email sign-in*.
- **Done:** *Sync notes*.

*Mine* is 3: the icon, the store account and the testers. The decision belongs to phase 3, so the footer has no *Decisions* chip yet. When Claude marks *Email sign-in* done, only that line and `updated` change, and the items stay one per line; *Invite the testers* then moves to *Next*.

## Options

| Option | Default | |
|---|---|---|
| `file` | `docs/roadmap.json` | Relative to the git root, or absolute |
| `showBand` | `true` | The line above the prompt |
| `staleAfter` | `10` | Commits without touching the roadmap before the warning; `0` turns it off |
| `claudeCanEdit` | `true` | Gives Claude `roadmap_update` and `roadmap_add`; `roadmap_status` is always there |
