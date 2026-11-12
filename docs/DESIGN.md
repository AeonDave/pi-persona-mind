# pi-persona-mind — current design

This is the binding implementation contract. Release history belongs in [CHANGELOG](../CHANGELOG.md);
the user workflow is in [README](../README.md). Local design rationale and evaluation boundaries are in
[MEMORY-RESEARCH](MEMORY-RESEARCH.md).

## Host and module boundaries

This design contract describes the current development tree; released changes are recorded separately
in CHANGELOG.md.

Target the latest stable Pi only, currently 1.5.2, and Node >=22.19. All four development Pi packages
are pinned together; runtime host/typebox packages remain optional wildcard peers. No second host
runtime or historical hook-shape adapter is bundled. A development-only security override does not
patch an installed host.

Mind requires a loaded compatible pi-persona through its versioned local companion handshake.
Missing/incompatible presence leaves tools inactive and suppresses capture, storage/import,
injection and reminders. A settings file or installed npm package is not proof of an active
companion. Mind 0.8.7 requires Persona 1.17.5 or later for these paired contracts. Its optional npm
peer declares that requirement without auto-installing or activating another extension.

The node-only core has no Pi imports. The factory wires native Pi hooks, tools, scope, scheduling
and lifecycle owners. Session persistence uses Pi's public SessionManager and appendEntry contracts.
Command parsing/presentation lives outside the factory. Important seams:

| Module | Responsibility |
|---|---|
| core/service.ts | Scope-bound memory/backlog operations, mutation ordering |
| core/store.ts | Atomic writes, exclusive ownership, recovery, strict snapshots and CAS |
| core/memory.ts, backlog.ts | Validated facts and deferred-work state |
| core/scope.ts, mind-settings.ts | Project identity, safe paths and canonical Mind preferences |
| extension/persona-dependency.ts | Loaded capability and actual memory-owner contracts |
| core/migrate.ts | Bounded, non-destructive import of previous memory layouts |
| core/session-memory.ts, session-memory.ts | Session event validation/replay and native owner adapter |
| core/optimize.ts, optimize-service.ts | Pure consolidation rules and short-lived staged plans |
| core/optimize-history.ts | Bounded durable before images and conflict-checked undo |
| core/retrieval.ts, context-budget.ts | Explainable task ranking and shared context estimate |
| core/memory-read.ts | Full explicit retrieval without clipped discovery or recovery writes |
| tools/memory.ts, memory-optimize.ts | Model-facing action validation and result formatting |
| extension/mind-command.ts | One command handler for persona-mind and mind |
| ui/ | Sanitized compact cards, full expansion and native custom-entry renderers |

## Four lifetimes

- **Durable facts:** persona-private LTM, explicit shared LTM and repository-scoped project LTM.
  Never expire automatically. Project facts remain repository-bound across persona changes.
- **Working project facts:** STM with persona attribution; 48-hour default TTL. Project injection can include
  other personas' observations, but optimizer mutations require the current persona's ownership.
- **Session notes:** native custom entries on the active branch, including source session identity.
- **Deferred intent:** project backlog, open/taken/done/dropped. Default expiry is 48 hours; a later
  reminder extends it. A repeated take is idempotent; re-add does not reopen completed work.

LTM/STM facts have content identity based on kind, text and sorted tags; provenance is excluded.
Exact re-recording updates identical normalized content (not semantic equivalence). lastSeenAt tracks recording/promotion, not
recall frequency. Read operations do not boost ranking or reset expiry. `term` alone selects lifetime:
`kind: objective` is not automatically promoted, so a short objective remains expiring project context
and a session objective remains on that active native session branch.

Supersession retires an active row. derivedFrom stores bounded IDs. Optimizer before images provide
bounded recoverability; ordinary supersession/forget are not a temporal database or unlimited undo.
Every long-term `remember` requires an explicit destination: project LTM, persona LTM, or shared LTM;
there is no implicit persona destination. Short-term memory remains project-scoped by default. Promotion
defaults to project LTM and requires an owned live STM source; persona/shared promotion destinations
must be explicit. A scope value selects API routing intent; it is not authenticated user consent. Use
session for task-specific or uncertain choices (models, strategies, task constraints), project for
stable repository facts, persona for facts intended across all projects of the same persona, and shared
only for facts truly intended across personas. Existing persona facts are never reassigned to guessed projects. Promotion removes
only its exact source row; equal-text observations from another owner retain their provenance.

## Scope and companion integration

The active persona comes only from pi-persona:memory-owner:v1, a synchronous query bound to the
native session ID. Its response identifies the loaded provider, readiness and actual persona (or
null for no persona). pi-persona:memory-owner-changed:v1 broadcasts readiness and selection changes.
Before Persona finishes startup, Mind returns without memory IO; it must not await a later extension's
session_start. Missing, ambiguous or stale owners refuse access. Saved selection and CLI flags are
not substitutes for the runtime owner, including when Persona persistence is disabled.

Mind capture/nudge preferences are session snapshots from canonical
<agentDir>/persona/settings.json. The retired state.json and PI_PERSONA_STATE_FILE are not runtime
sources; Persona owns its settings migration. Contribute effective Mind preferences through
pi-persona:settings:collect:v1; never edit companion settings or start another service.

Use the canonical project path and collision-safe persona scope names. Reserved shared/default
names, lossy Unicode conversions and Windows device names must not merge unrelated personas.
Home is not a project: skip project injection and reminders there.

A delegated leg is sampled at factory activation through PI_PERSONA_LEG / PI_PERSONA_CHILD.
PI_PERSONA_DISABLE alone does not designate a worker. Workers get lean objective/LTM injection,
no project/session notes, no memory/backlog tools and no reminders. Both Persona engines freeze the
launching persona. In-process workers receive it through their own extension bus; child processes
receive a scrubbed spawn-local payload. A later parent selection cannot move a worker's memory scope.

Intercom/Exocom and worker output stay foreign reference material, not automatic capture requests.
Only the reserved pi-persona-deferred-input custom type replays direct user input. This is a
trusted-extension convention, not authentication against other code running in the same process.
Do not read Persona's private result archive. The supervisor explicitly retrieves a report through
Intercom before curating a fact. A saved ref remains an opaque source string, not a cross-session grant.

## Session notes

Version-1 save/forget events live under pi-persona-mind-session-note. Reads replay only the active
branch; all session events count toward the lifetime budget. Branching/forking follows native Pi
history; new sessions do not inherit notes. Forked notes preserve originSessionId. A forget appends
a branch-local tombstone and does not erase previous transcript bytes.

Limits: 64 active notes, 8,000 text characters per note, 1,000 source characters, 256 lifetime events,
512 KiB encoded event data. Unknown versions, unsafe history or exceeded bounds fail closed.
Admission and replay both scan content. No append occurs after owner revocation; owner identity
includes the native manager, session ID and file. No asynchronous gap separates validation and append.

Receipts distinguish session storage from memory-only storage; Pi controls disk flushing.
Injection is reference data, escaped and bounded to a 600-token planning estimate (UTF-8 bytes / 3)
with excerpts of at most 700 characters. It shares the total memory budget. Current task matching
precedes recency, with objective priority. Omitted entries and clipping are disclosed. Explicit read returns the whole note.
An in-memory session is not advertised as restart-durable.

## Explicit consolidation

Bare `/mind optimize` (and `/mind optimize all`) launches one bounded real Persona-hosted LLM review for each currently allowed nonshared target, sequentially, at most three workers; home allows only persona. A named `/mind optimize project|project-long|persona` remains one target. Each worker uses the exact session model and existing worker admission, prompt, strict JSON validation, provenance, preview, CAS apply and durable receipt pipeline. Explicit requests bypass automatic dirty/token/cooldown/auto-off gates but honor current owner, idle/busy, single-flight and safety checks. The command returns after scheduler acceptance, before store inspection or worker admission; the default toast lists allowed targets and says one bounded window per tier will run sequentially. Completion is displayed as ordinary target-qualified Mind result cards, without a separate activity row. Each tier inspects only one bounded page/window; no-input results show target-local counts, page coverage and a typed reason (invalid input, empty/exhausted page, no safe/owned facts, a single short fact, or insufficient full-record budget), followed by the explicit statement that no worker started and no memory changed. An empty page is not a claim that the whole target is empty. A completed worker returning no operations is a reviewed no-op, not a skipped tier. Skipped tiers and reviewed no-ops allow the batch to continue; cancellation, owner change, failed/refused/uncertain workers or writes stop later tiers. A terminal explicit batch report names the accepting/current target and, when any remain, prominently lists the exact tiers not yet examined; earlier skipped, reviewed, or applied tiers are not called unreviewed. Stale lifecycle work emits no report. Worker refusal/failure diagnostics include run ID, model/thinking, and a retained result reference when available, but never echo malformed worker output or source records; the reference lets the operator inspect the archived result. Strict parent parsing and source/provenance validation remain unchanged. Persona 1.17.6 can make one bounded retry after syntactically invalid JSON, within the same tracked worker and original deadline. Mind still validates the returned proposal independently; its v1 companion contract does not require this optional retry. Reports are target-qualified in batch mode. Interrupted/stale work cannot apply, emit stale reports or schedule a manual retry. Shared is explicitly refused for LLM review and points to `/mind optimize inspect shared` plus manual review. Read-only inspection is `/mind optimize inspect [target]`; inspect/history defaults are unchanged.

The manual workflow is inspect → stage exact replacements → apply plan ID. An omitted replacement tag
list inherits the normalized union from selected sources; an explicit empty list clears tags. Lexical
rules never approve semantic changes. Learned decay rates, recall counters and age-based LTM deletion
remain outside the contract.

Inspection reads a strict store snapshot without recovery/quarantine writes. It returns at most 100
safe entries (20 by default), an exact raw-byte fingerprint, omission counts and at most 12 lexical
candidate pairs. Similarity is advisory: negation can preserve nearly all words while reversing meaning.
Inspection exposes offset/matched/nextOffset so old facts remain reachable in bounded pages;
fingerprint changes invalidate a paginated inspection's snapshot. Pairs compare one page only.
The foreground agent must inspect full text and current evidence before proposing replacements.

Each plan affects one store: `project` STM, `project-long` durable repository memory, persona LTM,
or shared LTM. Both project tiers require the current persona's ownership. One source rewrites a fact;
multiple sources consolidate facts. Explicit deletion remains memory forget. Operations specify exact
persisted source IDs; ambiguous/overlapping IDs, unsafe content, mixed ownership, replacement collisions,
expired sources, malformed stores and provenance overflow refuse the plan.

A replacement keeps earliest recording time, all bounded source origins and lineage. Project replacements
keep the earliest source expiry; consolidation cannot revive or extend stale working context.
Unselected entries are preserved. No capacity-enforcing truncation is allowed.

At most four plans per session/scope owner, ten-minute lifetime. Preview is immutable to callers.
Invalidation during an asynchronous preview read also refuses that preview; it cannot stage a new
plan belonging to the invalidated owner after the read returns.
Apply rechecks raw-byte fingerprint, lifetime, source expiry and owner invalidation under the store lock
and Mind's mutation lock. Even a same-sequence external file replacement invalidates the fingerprint.
Concurrent apply cannot commit twice. Session/scope changes discard plans; applying never spawns a model.

Before replacement, persist a scoped before/after receipt to `<store>.optimize-history.json`, under
its transaction lock and the memory mutation lock. Maximum 32 receipts / 2 MiB per target, plus the
standard backup. Evict settled receipts only; refuse the replacement if unresolved prepared receipts
or the new receipt exceed capacity. A generic IO failure may occur after the memory rename, so its
receipt remains prepared with outcome uncertainty. Known pre-write conflicts/lifecycle refusals are
rejected. Finalization failure after a successful memory commit returns success with a warning.

History/undo survive optimizer recreation. History is bounded, owner-filtered and scanner-filtered.
Undo restores only exact affected facts, preserving unrelated current records; it refuses changed
replacements, source collisions, expired facts and owner revocation. Check the lifecycle generation
inside the store mutation callback. An ambiguous interrupted receipt is never presumed applied or
discarded; unresolved IO failures can require manual recovery. This is consolidation recovery,
not rollback of arbitrary user edits or a claim of semantic correctness.

These are authorization mechanics, not truth verification: an explicit memory tool call has the same
mutation authority as existing remember/forget. The LLM chooses the destination by meaning and context;
users need not provide API scope names or a literal “global” keyword, and no new per-save confirmation
loop is imposed. Truly portable preferences remain eligible for persona/shared memory. Background
review eligibility does not restrict ordinary model-facing saves, updates or staged curation. The
runtime does not silently invent operator approval.
The full proposal is reviewable before application; no additional mandatory confirmation loop is added.

## Automatic semantic review

The user-authorized automatic path uses the same validation and fingerprint-checked mutation boundary.
It is session-scoped, on by default unless `PI_PERSONA_MIND_OPTIMIZE=off`; `/mind optimize auto
[status|on|off]` reads or changes that session's setting. Off cancels running review and clears queued
targets/retry permissions; saves while off do not queue work. On waits for the next successful save.
Doctor reports the scheduler's current status. No persistent preference is silently written.

A successful remember/promotion marks its eligible tier dirty. The first eligible burst needs no
token minimum. Later attempts require dirty memories and 1,000,000 main-session input tokens since
the preceding actual launch, including an explicit review; output, cache read/write and worker tokens are excluded. Usage alone
cannot dirty a tier. Rapid additions coalesce, and dirty tiers left after a review wait for the same
token gate rather than launching in a cleanup loop. Token counters restart at zero on activation;
the native session's attempt records preserve whether the first attempt already happened.
Requests coalesce for two seconds after native `agent_settled`, while idle and without queued work.
Actual worker attempts have a five-minute cooldown and only one may be in flight per Mind instance.
Explicit commands bypass automatic admission gates but record their actual launches and settled
digests. They never receive automatic retry permission when interrupted. Failed attempt persistence
cancels and joins the admitted worker before releasing the active slot.
Separate started/settled receipts preserve the attempt target and cooldown without treating an
interrupted review as completed. Restore considers only the latest attempt for each target, so an
older interrupted input cannot reappear after its changed-input retry has settled. A semantic digest
skips unchanged settled inputs, including terminal refusals. Only a retry of the interrupted attempt
bypasses the token gate; it still requires a later native settled event and cooldown. Cancellation
alone never rearms it. Unexpected current-owner failures persist terminal suppression without advancing
the page cursor; a warning asks for inspection when an apply may have completed. If persistence itself
fails, durable retry suppression cannot be guaranteed and the failure remains visible.
Incoming input, `agent_start`, off,
session/persona/workspace changes and shutdown cancel and invalidate pending plans. Delegated legs
do not recursively schedule automatic workers. Shared memories are excluded.

Persona hosts a real asynchronous Mind worker, visible in its standard agent view. The exact current
session model is the only allowed selection: no alternate provider/model or fallback. The worker has
no arbitrary tools, a 180-second deadline, and at most 12 full source records within 24,000 JSON
characters, with explicit IDs and provenance. Selection reserves the newest eligible record and
rotates bounded windows within a page and across older pages. Progress is session/scope-local and
advances only for completed reviews or explicitly ineligible/already-reviewed sets; cancelled work
does not count as reviewed. Byte-excluded records remain eligible on later passes. Coverage requires
further admitted triggers, never an unbounded autonomous sweep. Its output is strict JSON with at most four replacement
operations and at most 12 source IDs per operation, never direct storage writes. Automatic application
requires at least two compatible supplied source IDs in every operation. A proposal containing a
single-record rewrite is not staged or applied automatically; the completed attempt is settled without
an automatic retry loop. Single-record correction remains available through explicit workflows. A
selected automatic window with no same-kind pair starts no worker and consumes no actual-attempt
allowance. A merge count alone still does not establish semantic truth; conflicting conclusions must
not be adjudicated by the background reviewer.

The parent rejects malformed, unsafe, unattributed, stale or foreign-owner changes and applies accepted
replacements through the existing plan/CAS boundary. Kind does not change lifetime: consolidating
owned short-term objectives stays in project STM and preserves the earliest expiry. Unrelated rows
survive, and semantic deletion by age is not introduced.

Before apply, the complete automatic proposal is appended to an unrendered native audit entry; append
failure still prevents application. Durable store before images and guarded undo remain unchanged.
An actual automatic change produces one lowercase `mind` information toast using the scheduler's
existing structured target and summary, without adding a routine transcript result card.
Automatic no-ops settle silently while retaining attempt/digest/status evidence. Failures, refusals and
uncertain receipt finalization remain visible with an important warning. Explicit/manual reports keep
their detailed cards. The unrendered proposal audit preserves worker/model/effort and result reference;
`/mind optimize history <target>` exposes durable changes and undo provenance. The real worker's
normal Persona row uses lowercase `mind` and terminates through the same tracked lifecycle.
No semantic-quality guarantee or invented token savings follows from execution.

## Durable files and recovery

Under <agentDir>/persona-mind/:

- memory/ltm/<persona>.json and memory/ltm/_shared.json
- memory/project/<project>.json
- memory/stm/<project>.json
- backlog/<project>.json

Stores carry version, sequence, updatedAt and entries. Mutations use same-directory temporary writes,
fsync, atomic rename, exclusive lockfiles and ownership checks. Directory fsync is best-effort on
Windows. A live/foreign/malformed lock holder is never stolen merely for being old. Corruption is
recovered or quarantined with diagnostics, never silently treated as an empty valid store.
Windows sharing conflicts during recovery-gate acquisition return to the existing bounded lock
wait; they never authorize entering the protected callback or deleting another recovery gate.
Ordinary memory stores default to 10,000 entries and 4 MiB; writes over capacity fail without truncating
existing facts. Backlog terminal retention and optimizer history have their own bounds. Retrieval and
injection remain bounded independently of archive size.
Third-party attribution and license notices are retained in [LICENSE](../LICENSE).

Multi-store memory decisions serialize through one profile-wide memory transaction lock, anchored
beside shared LTM. A project-only lock is insufficient: persona/shared facts are visible across
projects, and another Pi could otherwise invalidate an ambiguity check before deletion. Lock order
is memory transaction → target history transaction → individual store; backlog remains independently
serialized. This is local same-profile coordination, not cross-host replication. Exocom scope aliases
do not change Mind's actual workspace identity or import another Pi's memory. Intercom/Exocom reports
remain untrusted material for explicit supervisor curation.

Ordinary recovery and migrations preserve user data. Imports scan bounded historical layouts,
deduplicate by semantic identity and reconcile the later record; originals are not removed.
A background import is bounded per turn and may finish after the turn continues. Incomplete import
means imported facts may not yet be available; it does not by itself prove corruption.
While import is pending, startup/injection defer disk expiry cleanup instead of waiting again on
the import's transaction lock. Read-time expiry filtering stays active; a later ordinary turn resumes
disk cleanup. Progress is informational, shown once per import and cleared when the import settles.

Expiry cleanup operates on the current entries under the mutation lock. Never compute a retained
backlog snapshot before acquiring the write lock: a concurrent add would otherwise be erased.
Promotion writes LTM before removing STM, so interruption leaves a duplicate rather than data loss.
Backlog cleanup retains active items and bounded terminal history.

## Capture, injection and UI

Persona exposes pi-persona:companion:v1 as a synchronous local capability query. Exactly one
valid loaded provider is required; disabled, absent, ambiguous or incompatible responses refuse
Mind access. Tools remain guarded even through programmatic executeTool. Real delegated legs
receive memory capability for lean injection, not write tools or activity publishing.

Local explicit optimization publishes pi-persona:activity:v1 only for actual inspect/stage/apply work. The closed
payload contains session identity, activity identity, phase, state and target, never memory text,
paths, model or token claims. Persona projects it as a Mind activity row, separate from agents and
wake sources. It cannot be steered, stopped as a worker, counted as an agent or exported as agent
telemetry. Pending proposals are staged, not running. Native owner and scope changes suppress
late events; terminal rows have bounded retention. This is cooperative UI, not task authority.

In AUTO mode, strong direct-user persistence cues may be captured deterministically before the model
starts, but every such capture is provisional and writes only a native active-branch session note—never
external project/persona/shared memory, migration destinations, or optimizer dirty state. This includes
“remember”, “from now on”, and explicitly durable/permanent wording. The receipt says session-only, says
no durable store was written, and invites a separate deliberate scoped memory call if broader retention
matches actual user intent; it does not forbid deliberate durable curation. A session append failure
has no durable fallback. Prompt mode remains nudge-only and off disables detection/capture. Quoted,
fenced, peer, worker, extension-follow-up and unattributed content are not direct-user capture input.
No-cue input skips migration waits. Lifecycle/current-input/owner generations prevent stale capture
notices; accepted notes stay with the original native owner and are never copied to a replacement session.

Normal injection uses entry caps (8 persona/shared LTM, 4 project LTM, 5 STM, 6 backlog), plus a
combined 2,400-token planning estimate across all memory blocks, including session notes (up to 600),
wrappers and omission notices. The estimate is UTF-8 bytes / 3, not a provider tokenizer or billing
guarantee. Whole excerpts are admitted, with bounded objective/invariant priority; they never bypass
the cap. Full reads are
explicit; no whole worker report is inserted as a memory merely because it exists. Scanner checks
run on admission and resurfacing, including new full-read source/tags. Scanning/fencing mitigates
unsafe content but cannot prove semantic truth or provide a security boundary against same-process code.

Nested report provenance follows Pi parentToolCallId, never guessed ID syntax. Only a visible relayed
blocked report from delegate/council/flow can suggest backlog capture. Discarded nested reports do not.
Bound and clear relay state at settlement.

Wakes are display-only appendEntry plus a short toast, never sendUserMessage/triggerTurn. Acknowledged
due reminders are not replayed. Newly due reminders are armed immediately and cancel on closure.
Keep pending/delivered deadline identity across maintenance re-arms.

Standalone cards use Persona's single `createCardFrame` implementation through the synchronous local
`pi-persona:card-frame:v1` presentation query. Mind mirrors the small structural contract and queries
at each renderer invocation, without hard-importing an optional package or caching a factory across
reload. Missing, incompatible, ambiguous or throwing providers use a minimal sanitized full-text
history fallback, not a second styled card engine. This port conveys no memory, scheduling or
security authority. Presentation models carry title, semantic state, full body, width-aware preview,
optional metadata and Markdown; the frame owns theme, truncation, expansion and padding.

Entry cards read the current public `pi.getSettings().outputPad` (native 0/1, default 1) because entry
render options omit it, and use host-provided expand hints. Native memory/backlog tool results retain
Pi's shell and receive no duplicate padding or standalone frame. Saved-memory receipts use a compact
summary with an expand hint; expansion reveals the original receipt, including its addressable ID,
without rewriting the tool payload or repeating the call title. A session read is not a save receipt. Optimization previews must retain their
selected-window qualification and never imply every record was reviewed; expansion retains worker,
model/effort and terminal-reference provenance. Commands retain reports in custom-entry history;
warnings/toasts stay short and are not duplicate durable cards. Display callbacks must still belong
to their accepting session and scope after asynchronous reads.

## Verification boundaries

The source-checkout `eval:memory` command reports individual paired sentinel ranks and actual bounded
injection outcomes, retaining historical queries and corruption/removed-fact negative controls.
Token diagnostics compare the unchanged UTF-8-bytes/3 estimate to pinned published reference vectors,
with exact input/token-ID hashes and source provenance. All inputs use the same calculation: no
language detector, language-specific factor, local tokenizer execution or runtime network request.
The reference encoding is not the current model's billing counter, and eight curated vectors do not
establish broad language coverage or justify automatic budget tuning. The runtime budget is unchanged.

Tests isolate PI_PERSONA_* and a throwaway PI_AGENT_DIR, use the actual Pi 1.5.2 SDK/tool pipeline and
offline providers, and join session_shutdown before SDK disposal. Native session tests cover persisted
reopen, branch/fork, in-memory behavior and owner revocation. Store tests cover lost writes, stale plans,
invalid inputs and concurrent apply. Installed-host/package qualification complements source tests.

The [post-release source audit](https://github.com/AeonDave/pi-persona-mind/blob/main/docs/reviews/2026-11-12-post-release-audit.md)
records the qualified snapshots, large-store checks, concurrent-writer stress tests and real-provider
smokes, with their evidence and platform limits.

Passing these checks proves tested behavior, not perfect memory, semantic compression quality, external
provider authentication or every operating system. CI provides separate Windows/Linux/macOS evidence.
