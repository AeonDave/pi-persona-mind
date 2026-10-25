<h1 align="center">pi-persona-mind</h1>

<p align="center">
  <img src="https://raw.githubusercontent.com/AeonDave/pi-persona-mind/v0.8.4/assets/banner.png" alt="pi-persona-mind — durable memory for Pi">
</p>

[![CI](https://github.com/AeonDave/pi-persona-mind/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/AeonDave/pi-persona-mind/actions/workflows/test.yml) [![npm version](https://img.shields.io/npm/v/@aeondave/pi-persona-mind?logo=npm)](https://www.npmjs.com/package/@aeondave/pi-persona-mind) [![License](https://img.shields.io/github/license/AeonDave/pi-persona-mind)](LICENSE)

Local memory for [Pi](https://github.com/earendil-works/pi): durable facts, session notes and
unfinished work. Bounded excerpts enter each turn; the agent can retrieve full entries when needed.

Requires a compatible loaded [pi-persona](https://github.com/AeonDave/pi-persona). The current
release pair is Mind 0.8.4 with Persona 1.17.5 or later.
Stores use local files and Pi's session history, without embeddings, a database or a separate service.
Automatic consolidation uses a visible Mind worker on your current session model. Memory injection and
worker review consume normal model tokens. A saved claim is not automatically a verified fact.

## Install

Requires the **latest stable Pi (currently 1.4.0)** and **Node.js 22.19.0+**. Historical Pi releases
are not maintained. Windows, Linux and macOS are supported.

```bash
pi install npm:@aeondave/pi-persona
pi install npm:@aeondave/pi-persona-mind
```

Keep both extensions on a compatible release pair. Restart Pi or run `/reload` after installing or
updating them. Mind stays inactive when the compatible Persona companion is missing or incompatible,
with no memory capture, writes, injection or reminders.

| Install option | Command |
|---|---|
| This project only | `pi install -l npm:@aeondave/pi-persona-mind` |
| Pin Mind 0.8.4 | `pi install npm:@aeondave/pi-persona-mind@0.8.4` |
| Update the unpinned pair | `pi update npm:@aeondave/pi-persona`<br>`pi update npm:@aeondave/pi-persona-mind` |

When switching either extension from a Git install to npm, remove its exact Git source first (use
your pinned source if applicable):

```bash
pi remove git:github.com/AeonDave/pi-persona
pi remove git:github.com/AeonDave/pi-persona-mind
```

Keep only one source configured for each extension to avoid loading it twice.

## Choose the right memory

| Kind | Scope | Lifetime |
|---|---|---|
| Long-term facts | Active persona, plus an explicit shared tier | Until explicitly changed or forgotten |
| Durable project facts | Current repository, with author persona recorded | Until explicitly changed or forgotten |
| Short-term facts | Current project, with author persona recorded | 48 hours by default |
| Session notes | Active Pi session branch | Follows that session's history |
| Backlog | Current project's deferred work | 48 hours by default; later reminders extend it |

Session notes survive compaction and resume of a persisted session. A new session starts without
them; a fork inherits its selected history and keeps each note's original session ID. With
`--no-session` or an in-memory SDK session, notes last only as long as that session. Forgetting a
note hides it on the current branch; it does not erase old transcript bytes.

Promote project knowledge that must outlive its expiry: promotion defaults to durable project memory,
keeping repository decisions out of other projects. Explicit `scope: persona|shared` broadens the
destination. Existing persona facts are not automatically moved or guessed to belong to a project.
Mind never imports private worker archives:
the supervisor reads a result through Intercom, checks it, then saves the useful fact and optional
source reference. A result reference is provenance, not permission to read another session.

## Commands

`/mind` is an alias of `/persona-mind`; both execute the same handler.

| Command | Effect |
|---|---|
| `/persona-mind` | Project/persona memory snapshot |
| `/persona-mind help` | Command reference |
| `/persona-mind doctor` | Scope, capture policy, paths and recovery warnings |
| `/persona-mind session` | Bounded list of active-branch session notes |
| `/persona-mind reset` | Clear this project's short-term facts and backlog |
| `/persona-mind reset workspace` | Same explicit workspace reset |
| `/persona-mind migrate-persona` | Recover an ambiguous historical persona-data alias |
| `/persona-mind optimize [project\|project-long\|persona\|shared]` | Inspect a bounded selection; no changes |
| `/persona-mind optimize show <planId>` | Display an already staged plan |
| `/persona-mind optimize apply <planId>` | Apply that exact plan if still current |
| `/persona-mind optimize history [target]` | Review retained before/after receipts; default `project` |
| `/persona-mind optimize undo <receiptId> [target]` | Restore unchanged affected facts; default `project` |
| `/persona-mind optimize auto [status\|on\|off]` | Inspect or switch automatic review for this session |

Reset preserves long-term facts and session notes. `reset all` and unexpected extra arguments are
refused. Reports use expandable cards and short status notifications. Tool results have compact
previews with Pi's expand key, usually `ctrl+o`.

## Agent tools

- `memory remember`: `term: long|short|session`, `kind`, `text`. Long/short facts also support tags,
  source, lineage and supersession. For long facts choose `scope: project|persona|shared`; default
  is persona. The old `shared` boolean is removed: use `scope: shared`.
- `memory recall`: lexical/path/tag discovery with `query`, `max`, and
  `scope: long|short|both|project|persona|shared|session`. Project includes its durable and working
  facts; long includes all durable tiers; both includes all active archives. Session is separate.
- `memory read`: full text and provenance by ID, including `session:<UUID>` notes.
- `memory forget`: remove a fact by ID, optionally restricted by scope, or tombstone a session note.
- `memory promote`: make an owned short-term fact durable in this project, unless another scope is explicit.
- `memory optimize`: inspect, stage, apply, history and undo; undo requires `receiptId` and explicit `target`.
- `backlog add|list|take|done|drop`: defer, inspect, claim or close work; reminders are optional.

Prefer declarative facts such as “The project uses Node 22.” An `objective` is prioritized in
durable injection; a session objective stays in its session.

Injection ranks current-task words, explicit tags and repository paths, with a small priority core
for objectives/invariants. Persona/shared, project, working context, backlog and session notes share
a **2,400-token planning estimate** (UTF-8 bytes / 3), including wrappers and omission notices.
Session notes use up to 600 of that estimate. This is not a provider tokenizer or a billing guarantee.
Whole excerpts are admitted under the budget, omitted facts are counted, and full reads remain available.
The retrieval is deterministic; it does not infer arbitrary synonyms or establish factual truth.

## Review and consolidate

Ask the agent to inspect memories against new evidence and propose a consolidation.
The slash command alone is a local inspection, not a hidden model request. The agent evaluates
the evidence during its normal foreground turn.

1. `memory {action:"optimize", mode:"inspect", target:"project"}` returns IDs and a fingerprint.
2. Read full facts, then stage explicit replacements with that fingerprint and
   `operations: [{sourceIds, kind, text, tags?, source?}]`.
3. Review the before/after plan and apply its `planId` through the tool or slash command.

One source rewrites a fact; several sources merge them. Each transaction affects one tier.
`project` changes only the active persona's short-term rows; `project-long` changes that persona's
durable repository facts; `persona` targets that persona's
durable store across projects; `shared` targets shared durable facts. Inspect further pages through
`offset`/`nextOffset`; restart if the fingerprint changes. Similarity compares the current page,
so absence from its candidate list does not prove the store is duplicate-free.

Plans last ten minutes, at most four per active owner. Session/persona/workspace changes invalidate
them. Concurrent writes refuse application. Consolidation preserves origins and lineage, never
extends short-term expiry, and never trims unrelated records to fit storage limits. Lineage IDs
alone are not a full archive of removed text. Each applied consolidation now has a durable before/after
receipt written before replacement. History retains at most 32 receipts / 2 MiB per target, plus the
store's recovery backup. Undo preserves unrelated later writes and refuses altered replacements,
collisions, foreign ownership or expired source facts. A `prepared` receipt means an interrupted
intent whose commit may or may not have happened; it is kept rather than guessing. Ambiguous IO
failures can therefore require manual recovery if unresolved receipts fill the history budget.

Exact deduplication and expiry cleanup already run automatically. Lexical similarity only suggests
comparisons; it cannot distinguish agreement from contradiction. Age never deletes a durable fact.
See [research and decisions](docs/MEMORY-RESEARCH.md).

During inspection, staging and application, **Mind** appears in pi-persona's activity tree and F9
view. The row distinguishes local work, a prepared proposal and a terminal result.
It does not invent a worker model, tokens or a cancellable agent. Finished rows are bounded and
remain visible, so a fast local operation does not disappear before it can be read.

Automatic review is on by default. Successful saves/promotions mark project or persona memories
for review; shared memories are excluded. The first eligible burst can run after the main agent
settles. Every later attempt requires both new pending memories and **1,000,000 main-session input
tokens since the preceding attempt**. Output, cache and worker tokens do not count. Token usage
alone never schedules a review, and rapid additions stay queued together instead of launching a
worker for every save. This is a cost-control policy, not a research-derived optimum.
Requests coalesce for two seconds after the main agent settles, with no queued work, and actual
attempts have a five-minute cooldown. Only one review can run at a time; unchanged completed reviews
are skipped. New input cancels it; that interrupted attempt may retry after a later settled turn and
the cooldown without waiting for another million tokens. `/mind optimize auto off` cancels and clears
pending review; saves while off do not queue automatic work. Turning it on waits for the next save.
`on` and `off` apply immediately to this session. Set `PI_PERSONA_MIND_OPTIMIZE=off` for the initial
session default, and use `/mind doctor` to inspect the current state.

This is a real asynchronous Mind subagent with its own Persona view. It uses exactly the session's
model, without a substitute or fallback, and has no arbitrary tools. It receives at most 12 full memory
records within 24,000 JSON characters. Repeated admitted reviews rotate within inspection pages and
through older pages, reserving room for the newest eligible fact. Rotation resets with its owner;
it does not launch an unbounded cleanup loop or claim the whole store has been reviewed. It has a
three-minute deadline and proposes at most four strict
JSON replacements. The parent validates provenance, owner, freshness and the store fingerprint before
applying anything. A durable operator card records the before/after proposal before application;
rejected or stale proposals do not alter their target store. Automatic review does not authorize age-based
deletion, shared-memory editing or inference that an old fact is false.

## Capture, reminders and collaboration

Explicit direct-user requests such as “remember that I prefer small changes” are saved before
the model starts, with a visible receipt. Casual cues suggest capture instead.

| Setting | Effect |
|---|---|
| `PI_PERSONA_MIND_CAPTURE=auto` | Capture explicit direct-user cues; default |
| `PI_PERSONA_MIND_CAPTURE=prompt` | Suggest a tool call without automatic writes |
| `PI_PERSONA_MIND_CAPTURE=off` | Disable cue detection and capture |
| `PI_PERSONA_MIND_NUDGE=off` | Disable suggestions, not explicit automatic capture |

The same preferences appear in pi-persona's settings panel. Environment overrides win; Mind refreshes
its capture/nudge preferences on session start. The loaded Persona runtime supplies the actual active
persona, including with selection persistence disabled. Changing council models does not switch memory
scope. Mind does not infer the active persona from old files or saved selection.

Quoted text, worker reports and Intercom/Exocom messages are not direct user input.
The reserved `pi-persona-deferred-input` replay preserves queued direct-user requests. This is
a convention between trusted extensions, not protection from arbitrary code in the same process.

Workers marked `PI_PERSONA_LEG` or `PI_PERSONA_CHILD` receive only durable identity/objectives:
their memory scope stays on the persona that launched them, even if the parent switches later.
They receive no project notes, session notes, backlog, memory tools or wakes. Blocked delegate/council/flow
reports can suggest backlog capture; they never write it automatically. Discarded nested reports
do not create invisible reminders.

A due backlog item creates one display-only card and a short toast, never an agent turn.
Opening Pi from the home directory suppresses project injection and wakes.

## Storage and development

Under `<agentDir>/persona-mind/`: persona/shared facts in `memory/ltm/`, durable repository facts
in `memory/project/`, working facts in `memory/stm/`,
deferred work in `backlog/`. Session notes live in Pi's session file. Writes use exclusive locks,
ownership checks, atomic rename and a last-known-good backup. Imports of old memory data remain
non-destructive. Scanning and escaped injection reduce unsafe-content exposure; they do not
prove saved facts true or arbitrary text harmless.

An import exceeding the turn's wait budget continues in the background with a temporary information
notice. That alone does not mean data loss; older entries may become available later. Use
`/persona-mind doctor` for its state and actual warnings. After fixing a reported import problem,
`/reload` rechecks the retained original files.

```bash
npm ci
npm run typecheck
npm test
npm run eval:memory
npm audit --audit-level=low
```

Tests isolate profile/environment and exercise the real Pi 1.4 SDK with an offline provider.
Qualify an installed host with current pi-persona and optionally an extracted Mind tarball:

```bash
node --import tsx scripts/qualify-host.mjs <pi-package-root> <pi-persona-extension> [<packed-mind-extension>]
node --import tsx scripts/qualify-package.ts <extracted-package>/src/index.ts <pi-persona-extension>
```

The evaluation reports deterministic retrieval on a small synthetic corpus, including a prior
substring baseline and context estimates. It does not measure model merge quality or cloud cost.
These checks verify host integration, not provider authentication or semantic memory quality. Pi supplies
runtime peers. Development security overrides do not patch a separately installed Pi.

[Design and limits](docs/DESIGN.md) · [Changes](CHANGELOG.md) · [MIT license](LICENSE)
