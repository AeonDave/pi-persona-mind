# Post-release audit — 2026-11-12

## Scope and baseline

The published baseline is `v0.8.7` (`6308494`). The source baseline for this audit is
`f131da5`: three subsequent commits, 48 changed files, 2,260 additions and 615 deletions.
The registry still reports 0.8.7. This review does not publish or tag a release.

The audit covered the source delta and current memory, storage, retrieval, scheduler,
companion and presentation boundaries. Independent implementation and review work was divided by
file ownership; the supervisor integrated changes and checked the final evidence.

| Existing commit | Concrete value retained |
|---|---|
| `44838ec` | Explicit durable destinations; provisional session-only cue capture; preserved caller-selected objective lifetime; shared Persona card rendering and native expand hints; current Pi 1.5.2 integration; bounded retrieval evaluation and token-reference diagnostics. |
| `8fe3cad` | Automatic proposals archived without large proposal cards; multi-source consolidation only; no model admission without a compatible same-kind pair; no-op silence. |
| `f131da5` | Lowercase system notification headings while preserving custom titles and stored evidence. |

The evaluation/reference changes are diagnostics, not runtime ranking changes, billing measurements
or proof of semantic model quality. The additional host rendering contract avoids maintaining a
second styled card implementation. No new runtime dependency or service was added by this audit.

## Corrections

| Defect or requested behavior | Result |
|---|---|
| Manual review did not affect automatic launch accounting | All actual launches reset the automatic cooldown/input-token baseline. Explicit commands still bypass automatic admission gates. |
| Completed manual inputs were absent from restored digest suppression | Settled explicit inputs share the existing digest history; interrupted explicit attempts never grant automatic retry. |
| An old interrupted input could reappear after a retry of changed records | Restore uses the latest attempt per target. |
| Failed attempt persistence released the active slot before cancellation completed | Join the worker before releasing the slot; emit one owner-current failure report and suppress stale-owner reports. |
| Unexpected preview/apply failure could restore an automatic retry of uncertain work | Persist terminal suppression without advancing coverage; preserve the inspection warning. Failed persistence itself cannot guarantee durable suppression. |
| Invalidation during asynchronous preview could create a new stale plan | Check the captured generation after reading, before staging. |
| Session recall used a separate all-words substring algorithm | Reuse the canonical lexical/path ranker, preserving source lookup, native branch recency ties and result bounds. |
| Query parsing repeated for every archive record | Prepare query terms and paths once per retrieval invocation; no cache or new ranking policy. |
| Save receipts promised unconditional context reinjection | Explain explicit recall/read and bounded, ranked automatic context selection. |
| Windows recovery-gate creation could fail with transient `EPERM` under concurrent processes | Treat the failure as bounded contention; never bypass the gate, delete it without ownership or enter overlapping callbacks. |
| Automatic completion added routine result cards | One lowercase informational toast after a clean application; no-op remains silent. Full proposals, durable receipts and undo remain available; warnings and manual reports retain detail. |
| Persona-owned Mind rows still used uppercase labels | Lowercase `mind` across local activity, grouped summaries, tracked worker names and live rows; routing IDs remain unchanged. |
| Live qualification still expected old cards and accepted singleton rewrites | Verify toast count, hidden proposal audit, actual multi-source receipt, persisted replacement/provenance and successful undo in both engines. |
| Installed-host qualification assumed nested `node_modules` paths | Resolve public ESM exports from the selected host entry, including npm's hoisted layout. |

## Long-project evidence and limits

The full-capacity scenario uses 10,000 valid durable project records below the 4 MiB store limit.
It exercises retrieval of the oldest fact after a year, full ID read, bounded injection, the last
inspection page, reopen, refusal of record 10,001 without changing store bytes, consolidation and
undo through a recreated optimizer. Undo restores the selected original and all 9,999 unrelated
records; another project does not receive the repository fact.

Existing scenarios also cover native session compaction/resume, branch-local notes, concurrent
process writes, strict snapshot conflicts, corruption recovery, expired working context, receipt
finalization uncertainty and provenance/owner checks.

A paired local diagnostic over 10,000 records compared original and revised query preprocessing:
two warmup pairs and nine alternating measured pairs, median 67.10 ms before and 34.90 ms after.
The complete ranking output had identical SHA-256
`e96d3a4ca65a0fb615fc4e6d5bfca405f1b476b3763c8324b1e646382b2fea10`.
This is a Windows/Node local microbenchmark, with concurrent tooling potentially adding noise;
it is not an end-to-end latency guarantee. No timing threshold was added to tests.

Memory injection remains a ranked selection within a 2,400-token planning estimate, including
session context. It is not the complete archive or a provider tokenizer. Explicit recall/read and
paginated inspection remain necessary for facts outside that selection. Lexical retrieval cannot
guarantee every paraphrase, and an executed model consolidation does not establish semantic truth.

## Architectural decisions

- Keep one retrieval policy and one scope/provenance/strict-store mutation boundary.
- Reuse scheduler report metadata for the toast; do not parse model prose or add a parallel result protocol.
- Keep presentation in Persona and expose it through the existing companion contract, with Mind's
  plain-text fallback for retained entries.
- Keep durable store receipts separate from display-only notifications. A missing toast does not
  erase an applied receipt, and a worker's completion alone does not prove a successful apply.
- Retain small domain modules and existing lifecycle contracts. No universal task class, new
  inheritance hierarchy, persistent index, model, daemon or dependency is warranted.

## Qualification

Windows, Node 26.3.0, Pi 1.5.2:

| Gate | Final result |
|---|---|
| Mind typecheck and complete suite | 541 passed, 0 failed, 0 skipped |
| Persona typecheck and complete suite, including paired UI and reviewed native-tool change | 3,122 passed, 0 failed, 2 documented Windows skips |
| Full Mind dependency audit | 0 vulnerabilities |
| Package dry run and actual candidate extraction | 44 shipped files; no tests, scripts, drafts or audit reports bundled |
| Installed registry Pi 1.5.2 with extracted Mind | PASS; 7 faux requests, 0 outbound fetches; owner/isolation, session notes, full read, CAS refusal, provenance, undo, settings and lean-worker checks |
| Extracted Mind automatic smoke, inproc and child | PASS; exact one info toast, zero result cards, proposal audit, applied receipt, 2-to-1 consolidation and actual undo |
| Real `openai/gpt-6-luna`, xhigh, inproc and child on final source | PASS; exact selected model/effort, lowercase worker view, 2-to-1 apply and undo, one foreground turn only |
| Windows recovery stress | 12 consecutive trials, 144 child contenders, no overlapping callbacks |
| Whitespace/error checks | Clean |

The real provider smoke used two isolated facts and verifies the execution path; it is not a broad
semantic-quality benchmark. Profiles and stores were temporary, and shutdown preceded disposal.

One intermediate full suite exposed the Windows recovery-gate `EPERM` race. A deterministic regression
failed before the fix; the complete final suite and repeated process stress passed afterward. An initial
installed-host attempt also exposed the qualifier's invalid nested-dependency assumption, corrected
before the final installed-artifact run. Earlier green checks were not used to certify those failures.

The local unreleased 0.8.7 candidate tarball has SHA-256
`a78bca237d6543c07b69503b97093825977e658cf86c09ac1fd0c735f570eaca`.
All 44 shipped files matched source bytes after qualification. It is not the published 0.8.7 artifact.
Local evidence is under `%TEMP%/mind-audit-1794504781245/`: `mind-stable-verify.log`,
`persona-final-test.log`, `live-final-inproc.log`, `live-final-child.log` and `packed/final/report.json`.
The separate reproduction/performance evidence is under `%TEMP%/mind-deep-audit-proof-x1gyx3gd/`.

The concurrently authored Persona native-tool change was also reviewed and its SDK test strengthened.
It suppresses automatic extra native tools for an in-process worker when the supervisor CLI explicitly
selects tools, while preserving explicit per-worker grants, empty grants and exclusions. This is not
a claim that every supervisor CLI option is inherited by both worker engines.

No new Linux/macOS or minimum-Node run was performed here. The two new Windows-specific race
regressions skip on other operating systems. No push, tag, release or npm publication is part of
this audit.
