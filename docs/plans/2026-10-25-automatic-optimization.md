# Automatic memory consolidation

The user explicitly authorizes automatic LLM consolidation, using an asynchronous Persona worker
with its own native view and the current session model. This supersedes the earlier foreground-only
policy; ordinary backlog reminders remain display-only.

Successful saves and promotions mark their owned tier dirty. The first dirty batch for a new owner can
run after the usual two-second idle coalescing window. Later attempts require both dirty memory and
1,000,000 main-session input tokens accumulated since the previous actual worker attempt; output,
cache input/output and worker usage do not count, and usage alone never starts a review. The attempt
cooldown remains five minutes. If several tiers are dirty, one worker reviews one bounded batch; other
tiers remain dirty until another million main input tokens and the cooldown have elapsed. Wait for Pi
1.4 `agent_settled` and idle/no pending work, and never start in workers or print mode. Use one job at
a time and semantic-digest suppression. New input, resumed foreground activity, owner changes,
shutdown and opt-out cancel outstanding work.

Persona owns execution: its normal tracker, launch pool, progress, F9 stop, usage and terminal archive.
A closed companion request launches a fixed tool-less Mind worker, pinned to the session provider/model
and effort, without fallback or installed-agent prerequisites. Completion belongs to Mind and must not
wake the supervisor into another model turn. Admission still observes Persona capability limits.

Mind owns policy and writes: inspect only current-persona project/private stores, select bounded full
records, send them as untrusted evidence, validate strict JSON proposals against supplied IDs, then use
the existing staged-plan/CAS path. Shared/session/backlog stores stay outside automatic consolidation.
Never infer obsolescence from age or recency alone. Empty proposals are valid. Record the before/after
proposal in the native operator history before applying; refusal leaves the store unchanged.

Verification: deterministic eligibility/response tests; scheduler lifecycle/cancellation/no-loop tests;
Persona admission/tracker/control tests; actual Pi SDK integration, both full suites/typechecks, packed
qualification and a real same-model asynchronous worker smoke. No release is requested.

## Final implementation and verification — 2026-10-25

Implemented in small pure-policy, scheduler, Pi-lifecycle and companion-client modules. Persona owns
the fixed worker and its ordinary tracker, controls, concurrency and archival. No direct companion
import, separate model client, daemon or historical-host compatibility path was introduced.

- The token floor is **1,000,000 main-session input tokens**, paired with dirty memory for every
  post-first attempt. Native accounting excludes output, cache reads/writes and duplicate events;
  worker usage is in separate sessions. The first eligible dirty batch is exempt; an owner restored
  with an attempt receipt is not, and resumes with zero accumulated tokens.
- Saves are coalesced for two seconds after settlement. Actual attempts have a five-minute
  cooldown, one worker at a time, with current model/provider/effort and no fallback or tools.
- Interrupted reviews remain eligible after the next settled event and cooldown without needing a
  new million-token interval. Only that same target gets the retry exception; other dirty tiers still
  require the normal token floor and cooldown. Separate started/settled receipts prevent treating
  cancelled work as a completed review; cancellation alone never rearms it. A restored started receipt
  matching a settled digest is not retried, and empty/already-reviewed target sets clear stale retry
  eligibility. Home-directory project stores are not automatically reviewed.
- Selection reserves the newest eligible fact before old candidate pairs. Strict proposals refer
  only to supplied records. The full bounded before/after plan is saved before parent-owned CAS
  application; age alone never invalidates a fact and shared stores remain excluded.
- `/mind optimize auto [status|on|off]` and the `/persona-mind` alias control the session. README,
  design, research decisions and both companion contracts describe the implemented behavior.

Earlier qualification of the initial automatic-worker slice (before the later retrieval, history,
project-memory and 1M scheduling changes). The final current-tree qualification is recorded in
[memory quality and maintainability](2026-10-25-memory-quality.md):

- Mind: official Node **22.23.3**, **400/400** tests, zero skips; typecheck clean.
- Persona: **2,920 passed / 2,922 total**, only the two accepted Windows skips; typecheck clean.
- Both full dependency audits: zero vulnerabilities. Both diff whitespace checks clean.
- Final packed pair loads outside both checkouts through the actual installed Pi **1.4.0**.
  Host qualification covers owner isolation, session notes, full reads, explicit optimization,
  stale-plan refusal and display-only backlog wakes (seven synthetic requests, zero fetches).
  The development SDK package check independently passes. All **251** published files match the
  source bytes: 39 Mind files and 212 Persona files; tests, plans, scripts and dependencies excluded.
- Actual asynchronous integration on **both in-process and child engines**, using the packed pair
  and a deliberately scripted local provider: native `agent_settled`, real RPC UI/agent widget,
  matching provider/model and requested/effective xhigh, persistent terminal report, before/after
  card and a checked **2 → 1** store replacement. Exactly one foreground turn; maintenance never
  wakes a second one. These are real runtime integrations, not semantic-quality benchmarks.
- Independent adversarial review reproduced and closed cancellation rearming, permanent suppression
  of interrupted reviews, fresh-fact starvation and missing task policy. Native child qualification
  also caught and fixed loss of the pinned provider on an exact bare-model observation. Regressions
  were run failing before the fixes.
- The scheduler token-floor follow-up passes **45/45** focused tests across auto selection, runtime,
  scheduler and memory-quality-refuter coverage; `npm run typecheck` is clean. This focused run does
  not replace current full-suite, dependency-audit or packed-host qualification.

The attempted cloud run on `openai/gpt-6-luna` could not authenticate: the copied existing OAuth
credential was expired and refresh returned `invalid_grant`. No successful cloud result or LLM
semantic-quality claim is made for this slice. The original authentication profile was not modified.
The previous owner-only cloud smoke in the earlier record does not qualify this new automatic path.

Evidence retained outside the package:

- `%TEMP%/mind-auto-full-node22.log`
- `%TEMP%/pi-persona-mind-worker-final-tests.log`
- `%TEMP%/mind-auto-packed-inproc.log`
- `%TEMP%/mind-auto-packed-child.log`

No version bump, commit, push or publication. Load both updated source checkouts together and use
native `/reload` for the new factory/hooks; published Persona 1.17.4 predates these companion seams.
