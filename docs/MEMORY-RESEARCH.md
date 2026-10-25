# Memory consolidation: evidence and decisions

Reviewed 2026-10-25 against Mind 0.8.3, the current working changes, Pi 1.4.0 and
pi-persona main 476d3a3. Tavily was unavailable because its quota was exhausted; primary
sources were opened directly. This is an architectural review, not a Mind quality benchmark.

## What the sources actually establish

- [Mem0 update prompt](https://raw.githubusercontent.com/mem0ai/mem0/main/mem0/configs/prompts.py)
  specifies ADD, UPDATE, DELETE and NONE. It delegates semantic decisions to a model; this is
  useful precedent for explicit operations, not proof that lexical rules safely choose them.
  See also the [Mem0 paper](https://arxiv.org/abs/2504.19413).
- [Letta memory documentation](https://docs.letta.com/configuration/memory) describes editable
  memory and background dreaming over agent experience. Background compute requires its own
  lifecycle and model budget. Mind's explicit tools remain available; its user-authorized automatic
  review now supplies a separate idle-only worker lifecycle using the current session model.
- [Graphiti](https://github.com/getzep/graphiti) retains temporal relationships and episode
  provenance. That is stronger historical storage than Mind's active-row supersession plus lineage
  IDs. Mind should not claim equivalent temporal history or recoverability.
- [Human-Inspired Memory Architecture for LLM Agents](https://arxiv.org/html/2605.08538v1)
  reports 97.2% retention precision and roughly 58% store reduction on its VSCode issue-event
  dataset, not LongMemEval. On LongMemEval S-tier, raw accuracy was 78.4%, deduplicated 76.8%,
  with overlapping intervals; aggressive consolidation fell to 48.4%. The paper's roughly
  29-day half-life concerns events awaiting consolidation in its tested configuration, not a
  universal expiry policy for durable facts. The preference result was directional, not an
  individually significant general guarantee. Its embedding/calibration pipeline does not
  validate automatic lexical merging in Mind. Detail loss is a concrete risk, not a minor nit.
- [Vectorize's consolidation discussion](https://hindsight.vectorize.io/blog/2026/05/21/agent-memory-consolidation)
  is a useful design framing around importance, merging, decay and eviction. It is vendor guidance,
  not independent evidence that applying all four improves this project.

## Related systems checked 2026-10-25

These are source-level feature comparisons against the current [Mind design](DESIGN.md), not hands-on
reviews or quality rankings. Repository links pin the surveyed `main` revision; descriptions are not
evidence of comparative accuracy.

- [jayzeng/pi-memory](https://github.com/jayzeng/pi-memory/tree/1e276a762a666a7031459fdf7af018cc7966663e)
  uses editable Markdown, daily logs and a scratchpad, with optional qmd BM25, vector and hybrid
  search. That gives it a semantic route for differently worded queries, at the cost of qmd and an
  embedding model for semantic modes. Its default stable snapshot also intentionally delays prompt
  refresh after writes. Mind instead ranks explicit records by task terms, paths, tags and bounded
  priority without an embedding/index service; it cannot claim the same paraphrase recall.
- [josephkern/pi-memory](https://github.com/josephkern/pi-memory/tree/312627ffc5a47de690b3066276009e7d651f8729f)
  keeps global and trusted-project Markdown, injects a capped index and reads detail pages on demand;
  its current README also describes staged writes and page-table sidecars. Project files can be
  reviewed and shared through Git. Mind has more distinct owner/lifetime tiers, native branch-scoped
  session notes and a combined bounded injection, while its project facts live in the local Mind
  profile rather than as team-edited repository files.
- [feveromo/pi-hybrid-memory](https://github.com/feveromo/pi-hybrid-memory/tree/068977fd09e3c3dd9b9fbeb7c5b7de71558282a4)
  is the closest Pi-side overlap: local JSONL/Markdown, repo-map context, lexical/path/symbol ranking,
  bounded redacted injection and explicit untrusted-memory framing. Its optional model-assisted audit
  is separate from retrieval. Mind shares deterministic path-aware ranking and trust fences, but does
  not build a repo map or infer symbol links; it focuses on Persona-owned memory lifetimes, project
  facts/backlog and native session notes. Neither repository's feature list establishes retrieval
  quality on real tasks.
- [Letta Code](https://github.com/letta-ai/letta-code/tree/6f4e4886caa0934341eea75c306fc0364509218e)
  is a stateful agent harness: its README describes editable memory blocks, self-improvement and
  scheduled dreaming, message search, and Git-tracked MemFS. That supports broader agent learning and
  cross-agent history search, but adopts Letta's agent/runtime and lifecycle model. Mind remains a
  Pi extension integrated with the active Persona owner and Pi's native session branches; it does not
  rewrite its own harness or provide Letta-wide message search.
- [Graphiti](https://github.com/getzep/graphiti/tree/5c27edfa8d3e0f49b2571bcebb4261bcc89ee037)
  models entities, temporal relationships and source episodes, and documents hybrid semantic,
  keyword and graph retrieval. It can answer historical validity/provenance questions that Mind's
  active-row supersession and bounded lineage do not represent. Graphiti's usual setup adds a graph
  backend and model/embedder configuration (the README also documents embedded FalkorDB Lite); Mind
  avoids that infrastructure and does not offer temporal-graph queries.
- [claude-mem](https://github.com/thedotmack/claude-mem/tree/abd9aaab61995c53060a6bd15ce41e236f7c53e)
  advertises automatic lifecycle-hook capture and model compression, then serves SQLite/FTS and
  Chroma hybrid search through a local worker and progressive-disclosure tools. Its README lists
  several host integrations, so it is not limited to Claude Code, but its hook/worker/database stack
  and broad activity capture are a different operational and privacy choice. Mind is narrower:
  Pi/Persona owner-scoped records and cue-gated direct-user capture, with deterministic retrieval and
  no embedding database. Mind consequently has no semantic search index over captured activity.

No benchmark superiority is claimed. These upstream descriptions do not establish how any system
performs on Mind's users, memories or real project histories.

## Decisions for Mind

1. Keep exact deduplication and STM/backlog expiry automatic. They already existed.
2. Add genuine branch-scoped session notes through Pi's native persistence instead of another
   cross-session scratch store. Full retrieval is separate from bounded discovery/injection.
3. Let the foreground model reassess facts against new evidence, with explicit source IDs and
   reviewable before/after text. The user additionally authorized automatic semantic review through
   a visible Mind subagent. Similarity suggests pairs; it never approves merging or deletion.
4. Stage immutable plans and apply through fingerprint-checked transactions. Preserve unrelated
   facts, source origins, lineage and the shortest STM lifetime. Reject ambiguity rather than guess.
5. Do not infer obsolescence from age, store size or recall frequency. No automatic LTM decay or
   semantic eviction is introduced. The earlier foreground-only decision is superseded by the user's
   explicit request for automatic review: same session model, visible worker, idle admission,
   cancellation on new input, bounded records and strict JSON, parent ownership/freshness/CAS checks.
   Shared memory stays excluded. New memories mark work pending; the first burst may run when idle.
   Subsequent attempts need new pending memories AND 1,000,000 main-session input tokens since the
   preceding attempt, excluding output/cache/worker usage. Usage alone never schedules work. This
   user-selected threshold, two-second idle coalescing and five-minute cooldown are cost-control
   choices, not findings established by these papers. Interrupted attempts may retry after a later
   settled event and cooldown without another token floor.
6. Measure actual changes (entries/text), not invented token savings or accuracy. Fewer lines
   are useful only when they retain the exceptions and evidence needed for future work.

## Corrections to the preliminary GLM plan

The preliminary plan confused dataset results and proposed a universal decay heuristic without
adequate support. It also described reset as merely explanatory and entry renderers as missing;
both reset and native wake renderers already existed. Exact deduplication, lineage IDs, expiry,
bounded injection and atomic stores were foundations to reuse, not features to rebuild.

The current implementation contracts are in [DESIGN](DESIGN.md), and the callable command list
is in [README](../README.md). No claim of a “perfect memory” or benchmark superiority is made.
Semantic evaluation across real project histories remains separate from runtime correctness tests.
