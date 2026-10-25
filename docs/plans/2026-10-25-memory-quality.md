# Memory quality and maintainability

Implement the reviewed gaps on top of the existing companion/optimizer work; no release or rewrite.

## Contracts

- Add durable project memory alongside project working memory. Explicit `scope: project` with
  `term: long` stores repository knowledge without exporting it to every project. Promotion defaults
  to durable project scope; persona/shared promotion must be explicit. Existing files retain their
  meaning; do not guess the project of existing persona facts or bulk-move user data.
- Keep `project` optimizer target for expiring working memory and add `project-long` for durable
  project facts. Project stores carry persona attribution; consolidation only mutates the current
  owner's facts. Workers retain their lean injection contract.
- Rank bounded context using the current task, with deterministic lexical/path-aware retrieval,
  a small pinned core and one conservative token estimate across all injected memory tiers. No
  embedding service or background retrieval model. Expose omissions and full retrieval.
- Rotate automatic review through old eligible facts within existing worker/input/cooldown limits.
  A bounded pass is not a claim of exhaustive semantic validation; cancellation must not mark work
  reviewed. Preserve newest-fact admission without starving old records.
- Coalesce the first eligible save burst after native idle. Later attempts require new dirty memory
  and 1M main-session input tokens since the prior actual launch, excluding output/cache/worker usage.
  Usage alone cannot schedule work. Interrupted attempts retain their own retry permission and still
  wait for native settlement and the five-minute cooldown; other tiers cannot borrow that exception.
- Keep bounded durable consolidation receipts and allow explicit undo only when affected facts
  still match. Preserve unrelated writes; reject conflicts and expired sources. Recovery records
  must be durable before a destructive replacement can commit. Never revive expired STM.
- Add reproducible evaluation fixtures for scope isolation, retrieval relevance, temporal changes,
  exceptions and optimizer coverage. Report measured deterministic behavior separately from model
  semantic quality and total cloud cost; no invented comparative performance claims.

## Delivery

Use cohesive domain modules, focused regression tests first, then integration/typecheck/full tests,
dependency audit and package inspection. Update current design, README and command help together;
remove obsolete descriptions and avoid parallel policy implementations. Preserve unrelated pending
changes. Model-driven quality qualification requires a working provider and must be reported honestly.

## Adversarial corrections

Regression tests reproduced and closed loss of a colleague's matching STM fact during promotion,
byte-window starvation in automatic review, unsafe text resurfacing in ambiguous-ID diagnostics,
cross-project deletion races with persona/shared writes and background imports, and a promotion
whose carried lineage became ambiguous across stores. Promotion now preserves the new durable fact
and reports skipped ambiguous retirement. All memory mutations and imports share one profile lock;
per-store comparison still protects affected facts against a changed raw snapshot.

The final suite also exposed startup rejoining a blocked migration through expiry cleanup. Startup
and injection now defer that disk hygiene while import is pending, preserving read-time expiry
filtering; state-based tests keep the destination locked until after startup has returned. Automatic
off/on clears pending work and guards late worker/inspection completion against requeueing. Mind's
worker row now displays the selected model and effort through the standard Persona tree renderer.

## Final qualification — 2026-10-25

- Official Node 22.23.3: Mind **458/458** tests, zero skips; Persona **2,921 passed / 2,923 total**, the
  two documented Windows skips only. Both strict typechecks pass. Both complete dependency audits
  report zero vulnerabilities; whitespace checks pass.
- Real separate-process tests preserve concurrent project writes, isolate persona/shared scopes,
  and refuse the losing concurrent consolidation. Root review and independent Luna/Sol reviews
  verified the corrected concurrency, retrieval, undo and lifecycle paths.
- Final tarballs contain **42 Mind + 212 Persona files**, matching checkout bytes and explicit
  allowlists, without test/draft/dependency files. The extracted pair passes both the development SDK
  and actual installed **Pi 1.4.0** qualification, including project promotion, full retrieval,
  consolidation history/undo, stale-plan refusal, owner isolation and display-only wakes. Installed
  host qualification makes seven scripted requests and zero fetch requests.
- Packed-pair worker smokes pass on **in-process and child engines**: launch-persona ownership,
  exclusion of project/session/backlog context and memory-writing tools, and no delegated capture.
  Automatic smokes on both engines verify native settled admission, the real agent widget with
  model/effort, terminal archive, before/after cards, a **2 → 1** replacement, and an undo receipt.
  Exactly one foreground turn: maintenance does not wake the supervisor.
- `npm run eval:memory`: 31 hand-authored facts / 28 retrieval cases; ranked hit@1 1.0 versus 0.481
  substring baseline on 27 judged cases, plus one correct abstention. The memory-only injected block
  stays below the 2,400 estimated-token cap. These small synthetic fixtures exercise relevance and
  bounds, not general semantic accuracy or competitive superiority.

Runtime smokes use a scripted local provider, not a cloud semantic-quality benchmark. The earlier
cloud attempt failed authentication (`invalid_grant`); no successful real-model semantic assessment
is claimed. The current research document compares six similar projects against pinned upstream
revisions and records capabilities Mind still does not provide.

Evidence: `%TEMP%/mind-quality-qualification-20261025/` contains the final suite logs,
`final-installed-host.log`, the four `final-{auto,owner}-{inproc,child}.log` files, final pack manifests,
tarballs and the byte/allowlist comparison script. No version bump, commit, push or publication.
Both updated checkouts are needed together; native `/reload` activates the new extension factories.

## Paired release qualification — 2026-10-25

The user subsequently authorized publication of Persona **1.17.5** and Mind **0.8.4**, the first npm
release of `@aeondave/pi-persona-mind`. Public manifests now include the author, repository/support
metadata, explicit banner asset, pinned Pi gallery image and the optional Persona >=1.17.5 peer.
README installation instructions use the scoped packages and explain switching from Git sources.

After release metadata updates: Mind **459/459**, Persona **2,921 passed / 2,923 total** with only the
two expected Windows skips; typechecks and complete audits pass. Final packed contents are 43 Mind
files and 212 Persona files, qualified against the installed Pi 1.4.0 host.

The earlier cloud-authentication limitation was superseded by successful real-provider smokes on
`zai/glm-5.3`: Persona's three-worker fan-out produced one automatic wake after 8,384ms with no
polling; automatic Mind review passed on both engines, each with one foreground settlement,
visible model/effort, archived proposal/result and a checked two-to-one replacement. Pi normalizes
this model's unsupported xhigh to max; the qualification compares the worker against the actual
supervisor effort. The synthetic provider continues to assert xhigh strictly. These small real-model
fixtures qualify the execution path, not long-term semantic accuracy or superiority over competitors.

Release evidence is in `%TEMP%/persona-paired-release-20261025/`, with live logs in
`%TEMP%/mind-release-rerun-VVrEWD/` and `%TEMP%/persona-release-live-Fe5fFW/wake.log`.
