# Memory design decisions and evaluation

This document records Mind's local design rationale and verification boundaries. The binding
implementation contract is [DESIGN](DESIGN.md); callable operations and setup are described in
[README](../README.md). It is not a comparative quality ranking or a claim of perfect memory.

## Responsibilities and boundaries

Mind preserves deliberately selected facts, working project context, native session notes and deferred
work. It does not replace the host's conversation compactor, continuously archive every tool result,
provide a semantic-search database or infer universal user preferences from a task-specific choice.

Each destination has a distinct purpose:

- Session notes belong to the active native branch. They can survive compaction and resume when
  session history is persisted; a new independent session does not inherit them.
- Working project memory has a bounded lifetime. Durable project memory remains tied to the repository.
- Persona memory crosses projects for the same persona. Shared memory crosses personas as well.
  These are deliberately broad destinations, not defaults for operational choices.
- Backlog records deferred work rather than turning an incomplete task into a durable preference.

Long-term writes must name their destination. Content kind does not authorize a longer lifetime:
requesting a short objective does not make it durable. Automatic direct-user capture is provisional
session capture only. Broader persistence requires a separate deliberate scoped operation; a
model-supplied scope is routing intent, not authenticated proof of user consent.

Existing facts are not automatically moved or deleted based on wording. Repairing already mis-scoped
facts requires inspection and an explicit reviewed maintenance plan.

## Retrieval and context

Mind uses deterministic lexical, tag and path ranking, with explicit full reads separate from bounded
injection. This is explainable and avoids an additional indexing service, but differently worded
queries may miss relevant facts. No general semantic-recall guarantee follows from a passing test.

Injection is a planning budget, not a billing measurement. Preserve wrappers, omission counts and
whole admitted excerpts within the documented limits. The runtime estimate operates on UTF-8 bytes;
it must not select a correction factor by detecting a language. A comparison against a named reference
encoding remains a comparison to that encoding, not a count for every possible session model.

## Consolidation and recovery

1. Exact content deduplication and expiry of working memory/backlog remain deterministic.
2. A semantic review receives explicit bounded source records and proposes structured replacements;
   it does not write stores directly. Similarity may suggest candidates but does not approve a merge.
3. The parent validates source ownership, provenance, freshness and the target fingerprint before
   applying an immutable plan. Preserve unrelated records, lineage and the shortest applicable expiry.
4. Reject ambiguity instead of guessing which fact or owner an identifier addresses. Scope changes
   and lifecycle revocation prevent stale work from applying to a new owner.
5. Do not infer obsolescence from age, store size or recall frequency. Durable facts do not acquire
   automatic decay or semantic eviction. Automatic review remains bounded, visible, cancellable and
   subject to the admission and cost-control rules documented in [DESIGN](DESIGN.md).
6. Retain bounded before/after receipts and guarded undo. This is recovery of affected consolidation
   records, not unlimited history or rollback of unrelated user edits.

Successful validation establishes structural permission and freshness, not semantic truth. A worker
can still propose a bad summary. Keep proposals inspectable and state that limitation explicitly.

## What verification can establish

The local suite exercises store concurrency, atomic replacement, stale-plan refusal, provenance,
owner isolation, session replay, bounded context and recovery paths. The offline evaluator exercises
synthetic retrieval cases against an explicit baseline. These checks answer narrower questions than
whether a model will remember every useful detail on real project work.

Useful evaluation cases include:

- later corrections paired with historical queries, so current and earlier facts remain distinguishable;
- negated facts and exceptions that must not disappear from the retained evidence;
- source and owner provenance, including project facts that must not become cross-project preferences;
- malformed delimiters and Unicode text that must remain data rather than instructions;
- explicit omissions and bounded excerpts rather than silent claims that the whole store was reviewed.

Measure individual ranks, retained evidence and identified omissions. A detector needs a negative
control showing that it notices a deliberately corrupted result; fixture self-consistency alone is
not evidence of retrieval quality. Synthetic success does not replace a real-world semantic evaluation.

Token diagnostics need an independently inspectable reference tied to exact fixture bytes and a pinned
implementation or published vector source. Record its provenance and limitations. Do not infer the
isolated memory contribution from the provider's total conversation usage, fabricate unavailable
reference counts or automatically tune the production budget from a small fixture set.

## Review standard

Preserve each verification command's own exit status, not a downstream formatter's status. Distinguish
observed command/API results from inference and worker claims. A digest being present or computed is
not a verified match without an observed expected-versus-actual comparison.

Report a demonstrated failure, an uncorroborated claim and an untested case differently. Fewer records
or shorter text are improvements only when the relevant exceptions, history and provenance remain
available. No unsupported accuracy, cost-saving or superiority claim belongs in the release notes.
