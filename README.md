<h1 align="center">pi-persona-mind</h1>

<p align="center">
  <img src="https://raw.githubusercontent.com/AeonDave/pi-persona-mind/v0.9.0/assets/banner.png" alt="pi-persona-mind — durable memory for Pi">
</p>

[![CI](https://github.com/AeonDave/pi-persona-mind/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/AeonDave/pi-persona-mind/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/@aeondave/pi-persona-mind?logo=npm)](https://www.npmjs.com/package/@aeondave/pi-persona-mind)
[![License](https://img.shields.io/github/license/AeonDave/pi-persona-mind)](LICENSE)

**Local, scoped memory for Pi.** Keep useful project decisions, persona preferences, session notes
and deferred work without turning every conversation into permanent memory.
Mind complements Pi's native conversation history and compaction; it does not replace them.

## Quick start

Mind 0.9.0 requires **Pi 1.5.2**, **Node.js 22.19.0+**, and
[**pi-persona 1.18.0+**](https://github.com/AeonDave/pi-persona) loaded in the same instance.

```bash
pi install npm:@aeondave/pi-persona
pi install npm:@aeondave/pi-persona-mind
```

For existing installations, use `pi update npm:@aeondave/pi-persona` and
`pi update npm:@aeondave/pi-persona-mind`. Restart Pi or run **`/reload`** after installing or
updating; `/persona reload` alone does not reload extension code. Keep only one installation source
per extension and remove the old source before switching between npm and Git.

Mind needs a **compatible, running Persona**, not just an installed package or settings file.
Without that companion and its current session owner, memory operations and background activity stay
inactive. See [host and companion integration](docs/DESIGN.md#scope-and-companion-integration).

Try asking your agent:

- “Save this as a durable project decision: schema changes require a migration.”
- “Keep this constraint only for the current session.”
- “Remember this preference across projects for this persona.”
- “Put the blocked migration in the backlog and remind me tomorrow.”
- “Recall the decision about retries and show the complete saved record.”

Press **F10** to inspect what Mind has saved and prepared. Use **`/mind`** for a snapshot,
**`/mind help`** for commands and **`/mind doctor`** for effective settings and storage warnings.

## Memory that fits the work

Choose the lifetime and scope that match your intent:

- **Session notes** hold temporary decisions on the active native branch. They survive compaction
  and resume when session history persists, but do not follow a new session or delegated workers.
  A non-persistent Pi session keeps them in memory only.
- **Project working memory** holds short-lived repository context, expiring after 48 hours by default.
- **Durable project memory** keeps repository decisions until changed or forgotten.
- **Persona memory** keeps preferences and lessons across projects for the same persona;
  **shared memory** is deliberately available across personas. Both are durable.
- **Backlog** tracks deferred project work and reminders, with a 48-hour default expiry. Reminders
  are display-only: they do not wake the model, and live delivery requires Pi to remain open.

The agent can choose scope from your intent; API callers must explicitly select `project`, `persona`
or `shared` for a durable save. Strong direct-user cues may also be captured automatically, but
**automatic capture creates provisional session notes only**, even for “remember” or “from now on”.
Broader retention requires a separate deliberate `memory` call with an explicit durable scope.
Project injection and reminders are suppressed in the home directory.

Session notes belong to Pi's native history: forgetting one adds a branch-local tombstone rather than
erasing earlier transcript bytes. Delegated legs receive a lean memory selection, but not session
notes or memory/backlog write tools. See [lifetimes and scope](docs/DESIGN.md#four-lifetimes) for
storage, ownership and expiry details.

## Retrieval and inspection

Mind selects a bounded amount of context each turn using lexical matching over words, tags and
paths. It does not inject the whole store, and matching can miss paraphrases or conflicting facts.
Use explicit `memory recall` and `memory read` when you need to find or read a complete record.
The shared context budget is a planning estimate, not a provider billing counter.

**F10** toggles the read-only inspector in the interactive TUI:

- **Memories** browses scoped facts, full text, dates, tags and available recording provenance.
- **Context** shows the last block prepared by Mind, including omissions—not the final provider payload.
- **Timeline** shows bounded user/assistant text and session-note events on the active branch.

Open a record for detail; where available, open its matching recording source with **s**. A recording
shows where a fact was saved, **not that it is true**. Mind does not turn arbitrary source strings
into file, URL or private-worker-archive links. Timeline and source lookup are bounded to the active
branch, not a searchable archive of every past session.

Normal browsing and retrieval do **not** call a model. In Memories, **a** opens explicit maintenance
actions; `/mind browse`, `/mind browse context` and `/mind timeline` are command alternatives.
Navigation hints appear in the inspector. See the [inspector design](docs/DESIGN.md#read-only-memory-inspector)
for keys, coverage and limits.

## Maintain knowledge deliberately

**Consolidation** merges compatible saved facts within a scope. It uses a bounded model review,
validates proposed replacements and retains history for guarded undo; it does not check repository
truth. Run `/mind optimize` for one bounded window per eligible nonshared tier, or select a tier.
Inspect previous changes with `/mind optimize history` and use `/mind optimize undo` with a receipt ID.
Shared memory is excluded from model-driven optimization.

History and undo are bounded, and undo checks for conflicting changes before restoring affected facts.
They are not an unlimited rollback of arbitrary edits. Inspect the result rather than assuming a
reviewed window represents the whole store.

**Knowledge review** is separate: choose a fact or bounded scope window, provide selected repository
files, and review against those files and bounded active-branch user-role text. Repository evidence
requires project trust. The worker can propose corrections, conflicts, insufficient-evidence findings
or retirement recommendations; it cannot establish truth or automatically apply them.

1. Choose **F10 → Memories → a**, or run `/mind review project-long` (also `project` or `persona`).
2. Select evidence and confirm the model call. Inspect the proposal with `/mind review show`.
3. Use `/mind review apply` to separately approve corrections, or `/mind review discard` to discard them.
   Application rechecks evidence and memory freshness. Retirement is a recommendation; forgetting a
   fact is a separate deliberate action.

Both workflows use a **visible Persona-hosted Mind worker on the current session model**. They make
model calls and may incur provider costs; the companion contract does not select a different model or
fallback for Mind. Choose a model with `/model` before starting if needed. New input or changes to the
model, branch, session or owner invalidate pending review work. Session notes and shared memory are
not knowledge-review write targets.

### Quiet automatic maintenance

Automatic consolidation is on by default. After eligible saves, it waits for the foreground to become
idle and respects usage, cooldown and ownership gates. It operates on bounded windows, not the entire
archive, and consolidates compatible facts rather than silently deleting old durable knowledge.
A real worker is visible in Persona; successful changes get a small notification, while routine no-ops
stay quiet. Failures and important warnings remain visible. Model output and validation are not a
semantic-correctness guarantee.

Use `/mind optimize auto status`, `/mind optimize auto off` or `/mind optimize auto on` for the current
session. `PI_PERSONA_MIND_OPTIMIZE=off` disables automatic optimization at startup. Capture can be set
with `PI_PERSONA_MIND_CAPTURE=auto|prompt|off`, and `PI_PERSONA_MIND_NUDGE=off` disables suggestions.
See [automatic review](docs/DESIGN.md#automatic-semantic-review) for admission and cost details.

## Learn more

- [Design: lifetimes, storage, limits, commands and safeguards](docs/DESIGN.md)
- [Evidence-grounded review and approval](docs/DESIGN.md#evidence-grounded-knowledge-review)
- [Architecture decisions and evaluation boundaries](docs/MEMORY-RESEARCH.md)
- [Release history](CHANGELOG.md) · [MIT license](LICENSE)
