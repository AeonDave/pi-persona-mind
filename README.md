<h1 align="center">pi-persona-mind</h1>

<p align="center">
  <img src="https://raw.githubusercontent.com/AeonDave/pi-persona-mind/v0.8.6/assets/banner.png" alt="pi-persona-mind — durable memory for Pi">
</p>

[![CI](https://github.com/AeonDave/pi-persona-mind/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/AeonDave/pi-persona-mind/actions/workflows/test.yml) [![npm version](https://img.shields.io/npm/v/@aeondave/pi-persona-mind?logo=npm)](https://www.npmjs.com/package/@aeondave/pi-persona-mind) [![License](https://img.shields.io/github/license/AeonDave/pi-persona-mind)](LICENSE)

Local memory for [Pi](https://github.com/earendil-works/pi): durable persona and project facts,
short-term context, session notes and deferred work. Requires a loaded compatible
[pi-persona](https://github.com/AeonDave/pi-persona); a settings file or installed package alone
is not sufficient. Saved claims are not automatically verified facts.

## Requirements

- Latest stable Pi (currently 1.4.0)
- Node.js 22.19.0 or newer
- pi-persona 1.17.5 or newer, loaded in the same Pi instance

## Install or update

```bash
pi install npm:@aeondave/pi-persona
pi install npm:@aeondave/pi-persona-mind
```

For existing installations, update both extensions:

```bash
pi update npm:@aeondave/pi-persona
pi update npm:@aeondave/pi-persona-mind
```

Restart Pi or run `/reload`. Keep only one source (npm or Git) for each extension; remove the
existing source before switching to avoid loading duplicates. If Persona is absent or incompatible,
Mind remains inactive.

## Memory tiers

| Tier | Contains | Lifetime |
|---|---|---|
| `project` | Working facts for this repository | 48 hours by default |
| `project-long` | Durable facts for this repository | Until changed or forgotten |
| `persona` | Durable facts for the active persona across projects | Until changed or forgotten |
| `shared` | Explicitly shared durable facts | Until changed or forgotten |
| `session` | Notes in the active Pi history branch | Follows that session's history |

Backlog items are project-scoped and expire after 48 hours by default. Promotion defaults to
durable project memory; choose `persona` or `shared` explicitly when broader scope is intended. Session notes
are not available to delegated workers. Project injection and reminders are suppressed from home.

## Commands

`/mind` and `/persona-mind` are aliases.

| Command | Purpose |
|---|---|
| `/mind` | Show a memory snapshot |
| `/mind help` | List commands |
| `/mind doctor` | Show scope, preferences and recovery warnings |
| `/mind session` | List active-branch notes |
| `/mind reset` | Clear this project's working facts and backlog |
| `/mind optimize` or `/mind optimize all` | Review one bounded window for each currently allowed nonshared tier, sequentially; at most three workers (home allows persona only) |
| `/mind optimize project\|project-long\|persona` | Review that single tier |
| `/mind optimize inspect [target]` | Read-only inspection without an LLM call; includes shared |
| `/mind optimize history [target]` | Review prior changes (default: project) |
| `/mind optimize undo <receiptId> [target]` | Guardedly undo a prior change |
| `/mind optimize auto [status\|on\|off]` | Check or change automatic review for this session |

Batch review excludes `shared`. Skipped targets report why no worker started; a skipped page does not
mean the entire tier is empty. Cancellation, owner changes, or failed, refused, or uncertain work
stop later tiers. Successful changes can be reviewed and undone with the corresponding history and
undo commands. Optimization uses a visible Persona-hosted worker on the current session model.

## Memory tools

The `memory` tool supports `remember`, `recall`, `read`, `forget`, `promote` and `optimize`;
`backlog` supports adding, listing, taking, completing and dropping deferred work. Use
`/mind help` for command details and the docs below for scope and optimization behavior.

Capture preferences can be set with `PI_PERSONA_MIND_CAPTURE=auto|prompt|off`; capture suggestions
can be disabled with `PI_PERSONA_MIND_NUDGE=off`. See `/mind doctor` for effective session settings.

## Further reading

- [Design and operational limits](docs/DESIGN.md)
- [Memory research and decisions](docs/MEMORY-RESEARCH.md)
- [Release history](CHANGELOG.md)
- [MIT license](LICENSE)
