# Contributing

Thanks for wanting to help. Issues and pull requests are welcome in English or Portuguese.

## Good first contributions

- **Translations.** The mods' interface strings are in Brazilian Portuguese. An English (or any other) locale behind an option would open them to many more people.
- **Bug reports with numbers.** For `usage-limits`, include what the mod showed, what the usage page at claude.ai showed at the same time, and your plan.
- **New mods** that fit the spirit of the repo: small, useful every day, honest about what they can and cannot know.

## Working on a mod

```bash
git clone https://github.com/kevinmedeiros/claude-mods
cd claude-mods
claude --plugin-dir plugins/usage-limits     # hot-reloads as you save
```

Before opening a pull request, run these for every mod you touched:

```bash
claude plugin validate plugins/<mod>
claude plugin test plugins/<mod>
```

What we look for:

- **Logic in plain modules, tested.** Projections, parsers and guards live in `hooks/*.ts` as pure functions with tests in `tests/`. `register.tsx` wires hooks and draws.
- **Tests that use real shapes.** Prefer fixtures taken from real output, such as a real NUnit XML file, a real `dotnet build` error or a real exported `.glb`.
- **Draw for both surfaces.** Render the terminal and Claude Desktop (`e.surface`) and test both with `$.ui.mount`.
- **No surprises.** No network calls the README doesn't mention, no writes outside the mod's own files and the documented paths, and every guard says why it refused.
- **Bump the version** in the mod's `plugin.json` when behavior changes, so `/plugin update` picks it up.

If you change what the README images show, regenerate them with `bun docs/generate-previews.ts`.
