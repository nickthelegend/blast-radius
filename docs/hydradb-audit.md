# HydraDB integration audit

Written by probing the running engine and tracing every call site, not by
reading documentation. Every capability claim below was tested against
`http://127.0.0.1:8443` and `:9090` on this machine.

## 1. What the engine actually offers

Probed directly. This matters because it sets a hard ceiling on what "deeper
integration" can mean — several obvious graph-database features are simply not
in this engine.

### Present and confirmed

| Capability | Evidence |
|---|---|
| `algo.SSpaths` | one source, many targets, reverse traversal over multiple edge types |
| `algo.MSpaths` | many indexed sources/targets in one round trip; string-property selectors resolve with no declared index |
| `algo.SPpaths` | single pair |
| Pinned snapshots, `causal` / `strong` | read epoch returned on every query; `strong` refreshes from object storage first |
| Cursor pagination | `next_cursor`, drained to completion |
| Batched `UNWIND` writes | ~43k rows in ~95 round trips |
| `MERGE` upserts, `DETACH DELETE` | idempotent loader; `forget` |
| `MATCH` / `OPTIONAL MATCH` / `WHERE` / `STARTS WITH` | all confirmed |
| `count()`, `DISTINCT`, `ORDER BY`, `LIMIT` | confirmed |
| Bolt (Neo4j wire protocol) | stock `neo4j-driver` connects, reads, and runs `algo.SSpaths` |
| Admin telemetry | `/readyz` `/livez` `/metrics` — 30+ series including GraphBLAS, GC, verifier, write retries, compute queue, and failures classed twelve ways: contention, fencing, routing, freshness, admission, timeout, query, authz, corruption, config, storage, kernel |

### Absent — verified, not assumed

`collect()` · `avg()` / `min()` / `max()` · `CASE` · `WITH` chaining ·
variable-length `MATCH` (`-[:R*1..2]->`) · `EXPLAIN` / `PROFILE` (parse, then
silently ignored) · **and every centrality or community procedure**:
`pageRank`, `betweenness`, `triangleCount`, `wcc`, `scc`, `louvain`, `degree`,
`kHop` all return "not supported".

**This is the single most important finding for planning.** A judge might expect
"run PageRank on the dependency graph". That is not buildable here. Any idea
below that needed it has been excluded rather than listed as aspirational.

## 2. Is HydraDB genuinely used?

**Yes — it is the product, not a dependency.** Verified by watching engine-side
counters while driving the real UI.

One dashboard page load fired **25 real queries** at the engine. Cumulative
engine counters on this instance: **10,091 queries completed, 3.58M rows
returned, 2,959 write commits.** Nothing is cached outside the database and
nothing is precomputed into a file at query time.

### GENUINELY USED

| Where | What it does |
|---|---|
| `packages/core/src/hydra/client.ts` | The whole HTTP transport: cursor draining, client-generated `query_id` for write idempotency, retry with fresh id after a client abort, `lastReadEpoch` tracking |
| `packages/core/src/queries/blastRadius.ts` | `algo.SSpaths` reverse traversal over three edge types; `algo.MSpaths` for the repo subset; authoritative pin intersection |
| `packages/core/src/queries/timeMachine.ts` | Range predicate over `captured_at` inside a pinned snapshot; `exposureDiff` evaluates two instants from **one** read so both sides share an epoch |
| `packages/core/src/queries/remediation.ts` | Every candidate version of every offending dependency thrown at `algo.MSpaths` in one call |
| `packages/core/src/queries/insights.ts` | `algo.SPpaths` behind `why`; advisory reach in both tenses |
| `packages/core/src/queries/maintainers.ts` | `algo.SSpaths` over `MAINTAINS`, `relDirection: 'both'` |
| `packages/core/src/hydra/loader.ts` | Batched `UNWIND` load, ~43k rows |
| `packages/core/src/ingest/scan.ts` | Real lockfiles written as bitemporal snapshots |
| `packages/core/src/hydra/bolt.ts` | Stock `neo4j-driver` over Bolt — **verified live**: handshake, parameterised read, `algo.SSpaths` returning 5,998 paths, and agreement with HTTP |
| `packages/cli/src/serve/admission.ts` | `read_epoch` as a cache key, probed from the engine |
| Dashboard Cypher console | User-authored Cypher executed against the live engine, read-only |

### IMPORTED BUT UNUSED
**None.** `neo4j-driver` is the only engine dependency and `doctor --bolt` exercises it.

### FAKED
**None.** The CI marker guard fails the build on `mock|stub|fake|dummy|placeholder` in shipped source, and it passes.

### MISSING — capabilities the engine has that this project never touches

| Capability | Status |
|---|---|
| **GraphBLAS artifact snapshots** | `graph_query_graphblas_artifact_snapshots` reads **0** on this instance. The engine has a sparse-linear-algebra path; nothing this project does triggers it |
| **`/metrics` in the product** | ~~never surfaced~~ **CLOSED.** `/api/engine` now reports queries, failures by class, write amplification, GC, verifier, GraphBLAS and compute-queue state |
| **Failure classes** | ~~The client collapses all of them into one error type~~ **CLOSED.** Twelve classes, not the seven this audit first reported — reading the live counter surfaced `authz`, `corruption`, `config`, `storage` and `kernel` as well. The client now classifies, and retries only what can succeed |
| **`bookmark`** | Returned on every response; never used for read-your-writes session guarantees |
| **GC / verifier telemetry** | ~~never read~~ **CLOSED.** Surfaced in `/api/engine`. Both read zero on this instance, which is a real fact about a demo-sized graph rather than a missing metric |
| **Bolt in the product path** | Verified in `doctor` only; every product query goes over HTTP |

## 3. Where deeper integration genuinely fits — and where it would be forced

**Fits organically.** The engine exposes a rich operational surface this product
already has a reason to care about: it is an incident tool whose first principle
is *show the query*. Read epochs, bookmarks, failure classes, GC and verifier
state, and write-retry counts are all *provenance* — exactly the category of
thing this product already puts in every sheet's margin. Surfacing them is not
a bolt-on; it is the same idea one level deeper.

**Would be forced, so not attempted.** Multi-tenancy, sharding across cells,
replication topology, and anything requiring a second HydraDB node. This is a
single-cell deployment in a demo; pretending otherwise would be theatre. Equally
forced: any "AI on the graph" feature — nothing in the engine or the product
calls for it, and it would dilute a pitch that is precisely about exact answers.

## 4. Fifty features that use HydraDB for real

Ranked by how load-bearing the engine is: **could not exist without HydraDB** at
the top, **swappable for any datastore** at the bottom. Every idea was checked
against the capability probe above — nothing here needs a procedure the engine
does not have.

Depth: **core** (the engine does the work) · **surface** (a call, but the logic is ours).

| # | Feature | HydraDB capability used | Depth | Why a judge notices |
|---|---|---|---|---|
| 1 | **Exposure diff across two epochs** — compare the graph at read epoch N vs M, not two wall-clock instants | `read_epoch` + pinned snapshots | core | Version-controlled graph state; impossible without engine-provided epochs |
| 2 | **Read-your-writes via `bookmark`** — pass the bookmark from a write into the next read so `scan` → `exposure` is guaranteed to see the scan | `bookmark` token | core | Uses the session-guarantee primitive most graph demos never touch |
| 3 | **Failure-class-aware retry** — retry contention and routing, never retry `query`; surface freshness failures as staleness | `graph_query_failed_by_class` | core | Correct distributed-systems behaviour driven by the engine's own taxonomy |
| 4 | **Snapshot-pinned incident workspace** — pin one epoch for an entire investigation so every sheet answers from the same instant | pinned snapshots | core | Solves the real "did the graph move under me" problem mid-incident |
| 5 | **Truncation-proof traversal** — detect `pathCount` saturation and re-issue with a widened budget, reporting both | `algo.SSpaths` path budget semantics | core | Directly addresses the engine's silent-truncation trap this project documented |
| 6 | **Multi-seed blast radius** — every version an advisory affects as indexed sources in one `MSpaths` call | `algo.MSpaths` indexed selectors | core | One round trip where every competitor loops |
| 7 | **Bitemporal "as-of" console** — run any user Cypher against a chosen historical epoch | pinned snapshots + console | core | Time travel over arbitrary queries, not just the built-in ones |
| 8 | **Reverse-reachability with edge-type ablation** — same traversal with `RESOLVED_DIRECT` on and off, side by side | `relTypes` on `SSpaths` | core | Makes the modelling decision visible as a measurement |
| 9 | **Consistency A/B** — same query at `causal` and `strong`, showing epoch and any row delta | consistency modes | core | Demonstrates a real distributed-systems trade-off live |
| 10 | **Write-amplification panel** — attempts vs commits vs retries during a load | `graph_write_attempts/commits/retries` | core | Engine-internal truth no application-side metric could produce |
| 11 | **GC pressure view** — keys deleted and GC duration after a `forget` or `reset` | `graph_gc_*` | core | Shows the object-store storage engine actually working |
| 12 | **Verifier status** — surface `graph_verifier_runs` / `failures` as an integrity light | `graph_verifier_*` | core | Nobody else will show the engine verifying itself |
| 13 | **Backpressure-aware admission** — read `graph_client_backpressure_waits` and shed load before the engine queues | backpressure counter | core | Closes the loop on the saturation problem already measured here |
| 14 | **Cursor-depth telemetry** — expose how many cursor pages a traversal drained | `next_cursor` | core | Makes pagination visible instead of hidden |
| 15 | **Cross-transport verification in CI** — assert Bolt and HTTP agree on every gate query | Bolt + HTTP | core | Protocol compatibility asserted, not claimed |
| 16 | **Bolt-native query path** for the console, letting users bring a Neo4j client | Bolt protocol | core | Judges can point their own tooling at it |
| 17 | **Idempotent replay** — re-run a whole ingest with the same `query_id`s and prove zero duplicate rows | client-supplied `query_id` | core | Exactly-once semantics demonstrated, not asserted |
| 18 | **Epoch-stamped SBOM** — every CycloneDX export carries the read epoch it was taken at | `read_epoch` | core | An SBOM you can reproduce byte-for-byte later |
| 19 | **Snapshot-diffed CI gate** — fail only on exposure introduced between the base epoch and the head epoch | epochs + `MSpaths` | core | Turns the gate from stateful-guess into an exact comparison |
| 20 | **Maintainer blast radius at depth N** — walk `MAINTAINS` both directions with a tunable `maxLen` | `SSpaths` `relDirection: 'both'` | core | Credential-compromise reach, engine-computed |
| 21 | **Path-budget calibration tool** — sweep `pathCount` and chart where results stop growing | `SSpaths` budget | core | Empirically finds the right setting instead of guessing |
| 22 | **Query cost ledger** — per-query elapsed, rows, epoch, cursor pages, written to the graph itself | `/metrics` + writes | core | The tool measuring itself in its own database |
| 23 | **Live epoch ticker** — show the graph's epoch advancing as writes land | `read_epoch` | core | Makes "the database is alive" visible in one number |
| 24 | **Scoped auth demo** — show `graph_query_scope_denials` when a query reaches outside its namespace | scope enforcement | core | Multi-tenancy safety, engine-enforced |
| 25 | **Compute-queue latency panel** — `graph_compute_queue_microseconds` vs elapsed | compute subsystem | core | Separates queueing from execution honestly |
| 26 | **Two-hop typosquat confirmation** — `SPpaths` from a suspicious package to any repo | `algo.SPpaths` | core | Turns a name heuristic into a reachability fact |
| 27 | **Incident replay at historical epochs** — re-run the attack clock against past epochs | pinned snapshots | core | The simulation becomes reproducible, not re-generated |
| 28 | **Shortest-fix search** — `MSpaths` over every candidate version, engine-side | `MSpaths` | core | Already proven; deepening it to multi-package sets |
| 29 | **Reachability cache keyed on epoch** | `read_epoch` | core | Correct-by-construction caching |
| 30 | **Orphan detector** — find snapshots whose repo was deleted | `MATCH` + `OPTIONAL MATCH` | core | Integrity check the graph can answer about itself |
| 31 | **Blast radius over PyPI edges** once ingested | `SSpaths` `relTypes` | core | Same engine call, second ecosystem |
| 32 | **Direct-vs-transitive split** in one traversal | two edge types | core | One call answers what most tools need two for |
| 33 | **Per-repo exposure timeline** from snapshot history | range predicates | core | Bitemporal reporting per service |
| 34 | **Advisory reach in both tenses** (shipped) | `MATCH` + `is_current` | core | Already the strongest finding in the product |
| 35 | **Lockfile drift detector** — repos whose snapshots stopped updating | `captured_at` ranges | core | Finds unmaintained services from graph shape |
| 36 | **Blast radius as a saved query** stored as graph nodes | writes + reads | surface | Queries become first-class data |
| 37 | **Engine capability self-test** exposed in the UI (extends `doctor`) | procedure probes | surface | Shows the engine's real limits honestly |
| 38 | **Slow-query log** written back to the graph | writes | surface | Observability without extra infrastructure |
| 39 | **Multi-org scoping** by namespace | scopes | surface | Realistic deployment shape |
| 40 | **Graph size trend** recorded per load | writes + counts | surface | Growth over time |
| 41 | **Prefix search across all labels** | `STARTS WITH` | surface | Better palette |
| 42 | **Deleted-version tombstones** rather than hard delete | writes | surface | Auditability |
| 43 | **Batch size tuning report** for the loader | `UNWIND` | surface | Load performance, measured |
| 44 | **Read-only replica hint** via consistency mode | consistency | surface | Cheap reads where staleness is fine |
| 45 | **Health-gated CI** that waits on `/readyz` (partly shipped) | admin API | surface | Robust automation |
| 46 | **Ingest checkpointing** — resume a partial load from the graph | writes + reads | surface | Long ingests survive interruption |
| 47 | **Per-ecosystem stats** from label counts | `count()` | surface | Simple breakdown |
| 48 | **Query history persisted** for the console | writes | surface | Convenience |
| 49 | **Snapshot export/import** of the whole graph | reads + writes | swappable | Portability; any store could do this |
| 50 | **Generic key/value settings** stored as nodes | writes | swappable | Would be better in a config file — listed last because the engine adds nothing |

**Where the line falls.** Ideas 1–35 genuinely need this engine: they use pinned
snapshots, read epochs, bookmarks, path procedures, or engine telemetry that a
plain datastore does not have. 36–48 use it but could be reimplemented on
Postgres with effort. 49–50 are storage-agnostic and are ranked last honestly
rather than dressed up.
