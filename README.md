<div align="center">

# claude-mods

**Live mods for Claude Code: see how long your plan will last, hand work off between machines, and give Claude eyes on Unity and Blender.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code plugins](https://img.shields.io/badge/Claude%20Code-plugins-d97757)](https://code.claude.com/docs)
![Mods](https://img.shields.io/badge/mods-4-informational)
![Tests](https://img.shields.io/badge/tests-39%20passing-brightgreen)

[English](README.md) · [Português](README.pt-BR.md)

<img src="docs/terminal.svg" alt="Claude Code in a terminal: a band above the prompt shows the 5-hour limit at 38% lasting ~4.7h and the weekly limit at 41% lasting ~52h, three open sessions with tokens and cost, a model recommendation, and a Unity status line" width="100%">

</div>

---

Claude Code mods are plugins of **function hooks**: TypeScript that runs inside Claude Code and can draw panes and bands, add slash commands, watch tool calls, and feed context back to the model. This repository is a marketplace of four of them, built for daily use on a Max plan and on game projects.

| Mod | What it gives you |
|---|---|
| [**usage-limits**](#usage-limits) | Your 5-hour and weekly limits with **how long they will last** at your current pace, tokens and cost across every open session, a per-project breakdown, API-credit tracking, and a model recommendation that keeps you from running dry before the reset. |
| [**fluxo**](#fluxo) | `/handoff` writes where you stopped so the next session on another machine picks it up, plus a sound and notification when a long turn finishes. |
| [**unity-tools**](#unity-tools) | Compiler errors handed to Claude seconds after it edits a `.cs`, EditMode/PlayMode tests it can run on its own, a dedicated-server build pane, and guards that keep it out of `Library/`, scenes and `.meta` files. |
| [**blender-preview**](#blender-preview) | A live thumbnail of the Blender scene with triangle, bone and texture budgets, and a check of every `.glb` Claude exports. |

> [!NOTE]
> The mods' interface is in Brazilian Portuguese. Translations are very welcome; see [Contributing](CONTRIBUTING.md).

## Install

You need a recent Claude Code (tested on 2.1.286 – 2.1.295). In a terminal, start `claude` and install the mods you want:

```
/plugin install usage-limits --marketplace kevinmedeiros/claude-mods
/plugin install fluxo --marketplace kevinmedeiros/claude-mods
/plugin install unity-tools --marketplace kevinmedeiros/claude-mods
/plugin install blender-preview --marketplace kevinmedeiros/claude-mods
```

Answer `y` to add the marketplace the first time and pick the **user** scope. From then on the mods run in every Claude Code session on that machine: the terminal, the Code tab of Claude Desktop, and the IDE extensions. Restart sessions that were already open.

Update with `/plugin update <mod>`; change options with `/plugin` → the mod → configure.

---

## usage-limits

<img src="docs/desktop-pane.svg" alt="The /limites pane in Claude Desktop: a 5-hour card at 38% with a bar, the projection hatched to the reset and a pace marker; a weekly card at 41% in red warning that at the current pace it runs out about 80 hours before the reset; and the session's token mix" width="560" align="right">

The percentages come from Anthropic's own rate-limit headers, so they cover **the whole account**: every session, every machine, and claude.ai. On top of them the mod answers the question the usage page doesn't: *will this last until the reset?*

- **Status line and a band above the prompt** with each limit's %, how many hours it lasts at the current pace, time to reset, and tokens and cost across all open sessions.
- **`/limites` pane** with bars that show used, projected-to-reset and an even-pace marker, plus the 5-hour pace, the weekly pace in points per day, and how many hours of work are left at the last hour's pace.
- **Every open session** on the machine, with project, model, tokens, cost and share of the total, plus today's total.
- **Per-project spend** for each window, so you know which project is burning the week.
- **Model advice.** When the pace won't reach the reset, it recommends the least disruptive change, such as *"use Opus to orchestrate and Haiku to execute"*, and shows how long the limit would last.
- **Economy mode** (`/economia on`). The main thread keeps its model while new subagents run on Claude Haiku 5.5.
- **API credits.** Optional, with a Console Admin API key: spend of the monthly credit by model, the daily pace, and when the credit runs out.
- **↻ Refresh** to pick up the newest reading any session on the machine has seen.
- **Toasts** at 80%, at 95%, when a limit is exhausted, and when the projection says it ends before the reset.

<br clear="right">

| Option | Default | |
|---|---|---|
| `adminApiKey` | — | `sk-ant-admin…` key of the Console organization that receives the plan's API credits. Kept in secure storage. |
| `apiMonthlyCredit` | `200` | Max 5x: 100 · Max 20x: 200 |
| `apiCycleDay` | `1` | Day of the month the credit renews |

<details>
<summary><b>How the projection works</b></summary>

- **5-hour window:** the pace of the last hour, or the window average when the window is young. Hours left = (100 − used) ÷ pace.
- **Weekly window:** points the account spent in the last 24 hours, never less than one day of history, so a busy first morning isn't treated as the pace of the whole week. This includes other machines and overnight runs.
- **Hours of work** (weekly, extra): the mod measures how many weekly points each 5-hour point costs, inside a single 5-hour window, and multiplies that by the 5-hour pace. It reacts within minutes when you switch models.
- **Model scenarios:** spend is priced per model at API list prices from the last three active hours, and each scenario reprices it with a cheaper model. Subscription limits may weight models differently, so treat the numbers as estimates.
- **Freshness:** a session learns the account's percentages only from its own API responses. Sessions on the same machine share the newest reading, and the band says *"reading from 2h ago"* when it is older than 10 minutes.

</details>

## fluxo

Continue on another machine where you stopped.

- **`/handoff [note]`** has Claude Haiku 5.5 summarize the session (where you stopped, what was done, next steps, gotchas) and writes it to `.claude/handoff.md` with the files you changed and the git state.
- **Automatic handoff** (off by default). When `autoHandoff` is on, every turn that edits files refreshes the file list, so there's a record even if the session dies.
- **On the other machine**, the next session in that project shows *"↪ Handoff from MacBook (3h ago): …"* above the prompt, with **Continue from here**, **View** and **Dismiss** buttons.
- **Long-turn alert:** a toast, plus a chime on macOS, when a turn runs longer than 3 minutes. Optionally spoken.

The handoff file travels with your project, through a git push or a synced folder. If you'd rather keep it out of git, add `.claude/handoff.md` to `.gitignore` and sync the folder instead.

| Option | Default |
|---|---|
| `longTurnMinutes` | `3` |
| `sound` / `speak` | `true` / `false` |
| `autoHandoff` | `false` (turn on to refresh the file after every turn that edits) |
| `handoffPath` | `.claude/handoff.md` |

## unity-tools

Turns on in any session whose folder holds a Unity project. It finds `ProjectSettings/` above or up to two levels below the session's folder.

- **Compiler errors in Claude's context.** After Claude edits a `.cs`, the mod compiles that assembly with `dotnet build` from the `.csproj` Unity generates, out of tree under `Temp/`, in about a second. The errors come back with the tool result. New files Unity hasn't listed yet are included.
- **`/testes [editmode|playmode|tudo]`** runs the Unity Test Runner in batch mode and shows the results in the `/unity` pane, with a *send failures to Claude* button. Claude can also call the `unity_tests` tool itself to check its own changes.
- **`/build-servidor`** builds the Linux dedicated server and streams the log. It tells you if the *Linux Dedicated Server* module is missing.
- **Guards** refuse, with a reason Claude can act on:
  - editing `Library/`, `Temp/`, `Logs/` or `UserSettings/`;
  - hand-writing `.unity` or `.prefab` files;
  - creating or deleting `.meta` files by hand;
  - `UnityEngine` inside an engine-free core folder.

| Option | Default | |
|---|---|---|
| `projectPath` | auto | Project folder, if auto-detection misses |
| `unityPath` | Unity Hub path for the project's version | |
| `coreDir` | `Assets/Scripts/Core` | Engine-free folder; empty turns the guard off |
| `compileCheck` | `true` | |
| `allowSceneEdits` | `false` | |
| `serverBuildPath` | `Builds/Server/Server.x86_64` | |
| `buildMethod` | — | e.g. `MyGame.Editor.BuildServer.Build`; empty uses `-buildLinux64Player` |

**Requirements:**
- Unity Hub with the project's editor version.
- The .NET SDK (`dotnet`), for the compile check.
- Generated project files: Preferences → External Tools → *Regenerate project files*.
- Batch tests need the editor closed for that project.

## blender-preview

Works with Blender connected to Claude Code through a Blender MCP server.

- **After every scene change** Claude makes through Blender MCP, the mod renders a thumbnail and measures triangles per object, bones, materials, textures and actions against your budget. `/blender` opens the pane.
- **On every `.glb` export**, it reads the file and hands Claude a report: size, triangles, skin and bones, animations, and texture sizes, with a warning for anything over budget.
- **`/glb <file>`** checks any `.glb`.

| Option | Default |
|---|---|
| `maxTriangles` | `20000` |
| `maxBones` | `100` |
| `maxTextureSize` | `2048` |
| `autoPreview` | `true` |
| `server` | `Blender` |

---

## Privacy

Everything stays on your machine.

- **Local files.** The mods write to `~/.claude/usage-limits/`, to each plugin's own store, and to `.claude/handoff.md` in your project.
- **Network requests:**
  - `usage-limits` calls the Console cost API, and only when you set an Admin key.
  - `fluxo` calls Claude Haiku 5.5 when you run `/handoff`.
  - Nothing else leaves your machine.
- **Local processes:** `unity-tools` runs `dotnet` and the Unity editor; `blender-preview` talks to your local Blender through MCP.

## Development

```
plugins/<mod>/
  .claude-plugin/plugin.json   manifest and options
  hooks/register.tsx           the hooks module
  hooks/*.ts                   pure logic (unit-tested)
  tests/*.test.ts              run by `claude plugin test`
  types/index.d.ts             the mod's state contract
```

```bash
claude plugin validate plugins/usage-limits
claude plugin test plugins/usage-limits
claude --plugin-dir plugins/usage-limits
```

With `--plugin-dir`, a mod hot-reloads as you save. To regenerate the images in this README, run `bun docs/generate-previews.ts`; they are drawn with the mods' own code. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Kevin Medeiros. Not affiliated with Anthropic.
