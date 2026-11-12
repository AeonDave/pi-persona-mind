<h1 align="center">pi-persona-mind</h1>

<p align="center">
  <img src="https://raw.githubusercontent.com/AeonDave/pi-persona-mind/v0.8.7/assets/banner.png" alt="pi-persona-mind — durable memory for Pi">
</p>

[![CI](https://github.com/AeonDave/pi-persona-mind/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/AeonDave/pi-persona-mind/actions/workflows/test.yml) [![npm version](https://img.shields.io/npm/v/@aeondave/pi-persona-mind?logo=npm)](https://www.npmjs.com/package/@aeondave/pi-persona-mind) [![License](https://img.shields.io/github/license/AeonDave/pi-persona-mind)](LICENSE)

Local memory for Pi: durable persona and project facts,
short-term context, session notes and deferred work. Requires a loaded compatible
[pi-persona](https://github.com/AeonDave/pi-persona); a settings file or installed package alone
is not sufficient. Saved claims are not automatically verified facts.

## Requirements

- Latest stable Pi (currently 1.5.2)
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
| `session` | Notes in the active Pi history branch | Follows that branch through compaction/resume when session history persists; not copied to a new session |

Backlog items are project-scoped and expire after 48 hours by default. Promotion defaults to
durable project memory; choose `persona` or `shared` explicitly when broader scope is intended. Every
long-term `remember` requires `scope=project|persona|shared`: project is for stable repository facts,
persona is for intent across all projects of that persona, and shared is only for intent across personas.
The LLM chooses lifetime and scope from meaning and context; users do not have to name API scopes,
say a literal “global”, or approve each save. Genuinely cross-project preferences still belong in
persona/shared memory. A model or strategy name alone never decides scope. Short-term memory defaults
to project; `kind: objective` never changes the requested lifetime.

AUTO capture of strong direct-user cues writes only native active-branch session notes, including when
the wording says “remember” or “from now on” or asks for durable retention. It makes no external/durable
write and does not dirty the optimizer. Broader retention requires a separate deliberate `memory`
call with an explicit scope chosen from actual user intent. Session notes are not available to delegated
workers. Project injection and reminders are suppressed from home.

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

Automatic maintenance consolidates multiple compatible sources; it does not apply single-record
rewrites. A real change shows one brief note with expandable details and undo provenance. Its full
proposal audit is retained without a second large card; no-op reviews are silent. Important warnings
stay visible, and explicit/manual operations keep their detailed reports. This is a conservative
eligibility policy, not a guarantee that every model-generated merge is semantically correct.

Already-open Pi sessions can keep the previous implementation in memory. Use `/mind optimize auto off`
there until a native `/reload` or restart loads the updated extensions; `/persona reload` alone is not
a code reload. Existing stored memories are not automatically rolled back or reclassified.

## Memory tools

The `memory` tool supports `remember`, `recall`, `read`, `forget`, `promote` and `optimize`;
`backlog` supports adding, listing, taking, completing and dropping deferred work. Use
`/mind help` for command details and the docs below for scope and optimization behavior.

Capture preferences can be set with `PI_PERSONA_MIND_CAPTURE=auto|prompt|off`; capture suggestions
can be disabled with `PI_PERSONA_MIND_NUDGE=off`. See `/mind doctor` for effective session settings.

## Offline evaluation (source checkout)

Run `npm run eval:memory` for the synthetic retrieval baseline, paired sentinel results and token
estimate diagnostics. Sentinel cases make current/historical corrections, negation, exceptions and
provenance visible individually; they are not a semantic-model benchmark.

The token diagnostic applies the same UTF-8-bytes/3 estimator to every input, without language
recognition or language-specific factors. It compares eight pinned published reference vectors,
including Unicode and whitespace, with recorded source/input hashes. This is not a live tokenizer,
current-model token count or billing measure. Evaluation performs no network/model calls and does
not change the runtime budget or ranking.

## Further reading

- [Design and operational limits](docs/DESIGN.md)
- [Memory design decisions and evaluation](docs/MEMORY-RESEARCH.md)
- [Release history](CHANGELOG.md)
- [MIT license](LICENSE)
