<h1 align="center">pi-persona-mind</h1>

<p align="center">
  Durable memory and a short-lived work backlog for <a href="https://github.com/earendil-works/pi">Pi</a>.
</p>

Keep preferences, verified lessons and unfinished work across compaction and restarts.
Mind reads a small, bounded memory block into each turn. It uses local JSON files, without
embeddings, a database, an external service or background model calls. The injected block
uses normal context tokens.

It works standalone. With [pi-persona](https://github.com/AeonDave/pi-persona), long-term
memory follows the active persona and delegated workers receive a lean, read-only version.

## Install

Requires **Pi 1.0.0+** and **Node.js 22.19.0+**. Windows, Linux and macOS are supported.

```bash
pi install git:github.com/AeonDave/pi-persona-mind
```

Restart Pi or run `/reload`. Mind registers the `memory` and `backlog` tools and the
`/mind` command. No initial setup is required.

For local development, run `pi -e ./src/index.ts` from this checkout.

## The three faculties

| Faculty | Use it for | Scope | Lifetime |
|---|---|---|---|
| Long-term memory | Preferences, conventions, invariants and verified lessons; a pinned objective | Persona + optional shared tier | Until explicitly forgotten |
| Short-term memory | Notes about the current project | Project | 48 hours by default |
| Backlog | Work deferred for later, with optional reminders | Project | 48 hours by default; a later wake extends it |

Short-term notes and backlog entries expire and are deleted. Promote knowledge that must
survive. Mind does not archive the chat: a transcript is not curated memory.

### Capture

An explicit user request such as "remember that I prefer small changes" is saved **before**
the model starts, with a visible confirmation. This does not depend on the model remembering
to call a tool. Casual cues suggest a capture instead of writing automatically.

| Setting | Effect |
|---|---|
| `PI_PERSONA_MIND_CAPTURE=auto` | Explicit direct-user cues are saved; default |
| `PI_PERSONA_MIND_CAPTURE=prompt` | Cues suggest a tool call; no automatic writes |
| `PI_PERSONA_MIND_CAPTURE=off` | Disable cue detection and capture |
| `PI_PERSONA_MIND_NUDGE=off` | Disable optional suggestions, not explicit automatic capture |

Invalid capture values use `auto`. Quoted/fenced text, child reports, intercom and exocom
messages are not direct user input. Mind accepts pi-persona's reserved
`pi-persona-deferred-input` replay so a queued user request is not lost. This is a
cooperation convention between trusted extensions, not authentication against another
extension in the same Pi process.

When nothing needs capturing, the input hook skips migration and storage waits. Announcement
and hint deduplication are session-scoped, so a new session does not inherit the previous
session's muted hints.

## Tools (agent-facing)

- `memory remember`: save a declarative fact with `term: long|short`, `kind`, `text`
  and optional `tags`, `shared`, `ttlHours`, `source` or `supersedes`.
- `memory recall`: search with optional `query`, `scope` and `max`.
- `memory forget`: remove an entry by `id`.
- `memory promote`: make a short-term entry durable.
- `backlog add`: defer work with `text`, optional `tags`, `dueInSeconds` and `ttlHours`.
- `backlog list|take|done|drop`: inspect, claim or close an item; taking an already claimed
  item succeeds without changing it.

Prefer facts such as "the user prefers small changes", not instructions such as "always
make small changes". The `objective` memory kind is pinned above ordinary entries.

Writes and injected entries are scanned for secrets, suspicious instructions and invisible
Unicode. Flagged entries are withheld from injection with a placeholder. These checks are
defense in depth, not a guarantee that arbitrary text is safe.

Tool cards have compact previews and lossless expansion using Pi's configured key, usually
`ctrl+o`. They do not repeat the same status header or hide the full result.

## `/mind`

`/mind` shows a read-only snapshot of the objective, durable memory, working notes and open
backlog.

```text
/mind doctor          effective scope, capture policy, storage paths and recovery warnings
/mind reset           clear this project's short-term memory and backlog; cancel its wakes
/mind reset workspace same as /mind reset
/mind migrate-persona explicit migration for ambiguous older persona aliases
```

Workspace reset preserves long-term memory. `/mind reset all` is intentionally refused;
use `memory forget` for individual durable facts. Doctor does not dump hidden or corrupt
entry contents.

### Reminders

A due backlog item appears as a **collapsed, display-only transcript card** and a short
toast. It never starts an agent turn. Reminders survive restarts, are acknowledged after
display, and have bounded previews. Open/due entries remain in the next turn's memory block
until closed or expired.

Opening Pi from the home directory injects only long-term memory, not another project's
backlog or its reminders.

## Delegation-aware

A delegated leg (`PI_PERSONA_LEG=1` or `PI_PERSONA_CHILD=1`) inherits only the objective and
long-term memory. It has no `memory`/`backlog` write tools, project working state or wakes.
Disabling pi-persona yourself does not turn a standalone supervisor into a worker.

A visible `[BLOCKED]` or `FLAG: UNKNOWN` report can suggest `backlog add`. Nested
codemode results that the outer tool discards do not create a suggestion; a blocked report
actually relayed in the outer result still does. This is a suggestion, not an automatic
backlog write.

## Per-persona

Under `<agentDir>/persona-mind/`:

```text
memory/ltm/<persona>.json  persona-private long-term memory
memory/ltm/_shared.json    shared long-term memory
memory/stm/<project>.json  decaying project notes
backlog/<project>.json     deferred project work
```

The injected block combines shared and active-persona long-term memory with this project's
non-expired notes and backlog. Switching persona swaps the private tier, not the project's
work. Backlog `list` defaults to the current persona; `all: true` includes every persona.

## Storage & durability

Writes use a same-directory temporary file, fsync and atomic rename, with exclusive
lockfiles, ownership checks and a last-known-good backup. Corrupt data is recovered or
quarantined, not silently replaced with an empty store. No POSIX lock or native database
addon is required.

Older stores are imported non-destructively: source files are never moved or deleted.
The 0.7 root is `persona-mind/`; earlier `pi-persona-mind/` data remains available for
migration. Migration is bounded, deduplicating and idempotent; a slow lock does not hold
startup indefinitely. Scope changes reconcile canonical project paths.

The durable-store pattern is adapted from [OpenLore](https://github.com/clay-good/openlore)
(MIT). See [DESIGN.md](docs/DESIGN.md) for locking, migration, injection limits and known
limitations.

## Develop

```bash
npm ci
npm run typecheck
npm test
npm audit --audit-level=low
```

Tests isolate the Pi profile and environment. They cover the pure core, lifecycle races and
the **real Pi 1.0 SDK loader and tool pipeline**, using an offline provider without cloud
credentials. CI runs on Windows, Ubuntu and macOS.

After packing and extracting into a temporary directory, run
`node --import tsx scripts/qualify-package.ts <package>/src/index.ts` from this checkout to
verify the extracted extension's host loading, memory write and recall.

Pi supplies the host packages and `typebox`; runtime peers stay on `*`, with pinned
development copies for the supported minimum. Do not bundle another Pi runtime.

[Design](docs/DESIGN.md) · [Changes](CHANGELOG.md) · [MIT license](LICENSE)
