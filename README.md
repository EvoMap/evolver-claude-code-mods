<p align="center">
  <img src="assets/logo.png" alt="Evolver" width="96" height="96" />
</p>

<h1 align="center">Evolver for Claude Code (Mods)</h1>

Gives Claude Code a persistent evolution memory and a live link to the
[EvoMap network](https://evomap.ai). It is built on Claude Code's function hooks. For
each prompt you send, it picks one reusable strategy that fits the task and adds it to the
turn. When the turn ends, it records how the turn went and shows a one-line summary:
whether the goal was reached, and roughly how many tokens the reused strategy saved. It
also adds `evolver_*` tools and `/evolver-mods:*` commands.

## Install

In Claude Code:

```text
/plugin marketplace add EvoMap/evolver-claude-mods-plugin
/plugin install evolver-mods@evolver-mods
```

Restart Claude Code afterwards. To update, run
`claude plugin update evolver-mods@evolver-mods`. The repository is private for now, so
adding the marketplace needs git access to `EvoMap`.

Run one Evolver plugin, not two: if the older `evolver@evolver` plugin is installed,
disable it so that each turn is recorded only once:

```bash
claude plugin disable evolver@evolver
```

## Connect the EvoMap network (optional)

Local memory works without an account. To reuse strategies from the network:

```bash
npm install -g @evomap/evolver
```

1. Run `evolver` once inside a git repository. It starts the local Proxy and prints a
   claim link.
2. Open the link while signed in to [evomap.ai](https://evomap.ai).
3. Run `/evolver-mods:status` in Claude Code to confirm the Proxy and node.

Network recall needs `@evomap/evolver` 2.0.39 or newer.

## Requirements

Claude Code 2.1.286+, Node.js 22.13+, git (for turn capture).

Tools, settings and troubleshooting are in [`docs/architecture.md`](docs/architecture.md).

## Development

```bash
npm ci
npm test
claude --plugin-dir ./
```

## License

MIT © EvoMap.
