# HydraDB: what we verified, and what surprised us

Everything below was measured against a live `ghcr.io/hydra-db/hydradb:latest`
`graph-node`, not inferred from documentation. Each item changed a design
decision in Blast Radius, so they are recorded here with the evidence.

The engine is genuinely good at what this project needs — bounded path
traversal at ecosystem scale is one call and single-digit milliseconds. The
sharp edges below are the kind you only find by running the thing.

---

## 1. `pathCount` is a total budget, and it defaults to 1

This is the most dangerous default in the API for a tool like this one.

`algo.SSpaths` / `algo.MSpaths` take a `pathCount` option. It is not a
per-target limit — it is the total number of paths the call will return, and
when omitted it is **1**.

Probe, on a 10-node chain where 8 nodes are reachable backwards from the source:

| `pathCount` | paths returned | reachable endpoints |
|---|---|---|
| 1 (default) | 1 | `[11]` |
| 10 | 8 | `[11,12,13,14,15,16,17,18]` |
| 100 | 8 | `[11,…,18]` |
| 1000 | 8 | `[11,…,18]` |

A blast-radius query that leaves `pathCount` unset returns one path and looks
like it worked. For a security tool, "your blast radius is 1 repository" when
the answer is 40 is worse than an error.

**What we did.** `pathCount` is always set explicitly (`BLAST_PATH_COUNT`,
default 20000), and any report that comes back holding exactly its budget is
flagged `truncated` and printed with a warning rather than presented as
complete. `blastradius doctor` asserts the semantics on every run, so a future
engine change that alters them fails loudly.

---

## 2. `algo.MSpaths` with `pairwise: true` silently drops pairs

**This is a correctness defect, and it is silent.**

In `pairwise: true` mode, a (source, target) pair whose **source vertex id is
greater than the target's** returns no path — even though the path exists and
every other procedure finds it.

Reproduced on three independent pairs, on a chain where each edge points from
the higher id to the lower:

| pair | true path | `pairwise: true` | `pairwise: false` |
|---|---|---|---|
| 18 → 11 | exists (outgoing) | **0 paths** | 1 path |
| 19 → 12 | exists (outgoing) | **0 paths** | 1 path |
| 14 → 13 | exists (outgoing) | **0 paths** | 1 path |
| 11 → 18 | exists (incoming) | 1 path | 1 path |

Every direction loses it — `outgoing`, `incoming` and `both` all return nothing
for the high→low orientation. `algo.SSpaths` and `algo.SPpaths` find the same
path without difficulty, so the path is unambiguously there.

Because node ids are an internal allocation detail, building the multi-repo
exposure check on pairwise mode would drop roughly **half of all exposures at
random**, with no error.

**What we did.** Blast Radius uses **non-pairwise** `MSpaths` — which is the
correct shape for this query anyway (one compromised version against N repos)
and is correct in every direction. The spec asked for `pairwise: true`; we
implemented the correct thing and left `--pairwise` available so the difference
can be demonstrated. `tests/integration/mspaths-pairwise.test.ts` pins the
discrepancy down and will fail when the engine is fixed.

---

## 3. Node ids must be non-negative integers

`npm:left-pad@3.4.1` cannot be a node id. Ids are integers, full stop.

**What we did.** Domain keys live in a `key` string property and a persisted
sequential registry (`data/snapshot/id-map.json`) assigns the integers. A hash
would have been stateless, but a 53-bit-safe hash over ~100k keys carries a real
collision probability, and a collision here silently merges two packages into
one node — corrupting a blast radius in a way no test would obviously catch.
Sequential allocation is collision-free by construction.

Property indexes are maintained automatically, so `MSpaths` selectors
(`sourceLabel` / `sourceProperty` / `sourceValues`) resolve against the string
`key` with no DDL at all.

---

## 4. There is no temporal type, and no `IS NULL`

Property values are integers, floats, booleans and strings. `WHERE` supports
`=`, `<>`, `<`, `>`, `<=`, `>=`, `STARTS WITH` and boolean combinations — but
**not** `IN`, `CONTAINS`, `ENDS WITH` or `IS NULL`.

**What we did.** Every timestamp is epoch milliseconds. This turned out to be a
feature rather than a workaround: the Time Machine's window test is a plain
inclusive integer range that the property index serves directly. "Never
compromised" is the sentinel `compromised_from = 0` alongside
`is_compromised = false`, because an absent property could not be queried.

The absence of `IN` is why a few places issue one small query per key instead of
a single disjunction.

---

## 5. The batch-write forms are narrow, and the error messages are precise

Bulk loading has to go through `UNWIND`, and only these shapes are accepted:

```cypher
-- vertices: MERGE by id, then SET. Folding properties into the MERGE pattern
-- is rejected, because the pattern is the identity being matched on.
UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:Label, n.p = row.p

-- edges: MERGE *requires* an explicit relationship id.
UNWIND $rows AS row
  MATCH (s:L {id: row.source_vertex}), (d:L {id: row.destination_vertex})
  MERGE (s)-[r:TYPE {id: row.relationship_vertex}]->(d) SET r.p = row.p
```

Things that are rejected, with the exact message:

| Attempt | Message |
|---|---|
| `UNWIND … MATCH … SET` | `UNWIND MATCH must end in RETURN or DELETE` |
| `MATCH … SET … RETURN` | `mutation queries cannot continue with MATCH, RETURN, or WITH after writes` |
| `MERGE (s)-[r:T]->(d)` in a batch | `UNWIND relationship MERGE requires id: row.<field>` |
| `SET r.weight = 1` in a batch | `UNWIND relationship SET values must read from the row map` |

**What we did.** Updating existing nodes in bulk (marking a set of versions
compromised) uses the *vertex upsert* form — `MERGE` by id matches the existing
node and the trailing `SET` applies to it — because there is no batched
`MATCH … SET`. Relationship ids come from the same registry as node ids, which
makes every edge write idempotent.

One consequence worth knowing: a relationship id must be unique *within a batch*
or the whole batch is rejected with `idempotency key conflict for
relationship-import request key <id>`. Real registry metadata triggers this
easily — a manifest can list the same package under both `dependencies` and
`peerDependencies` — so `DEPENDS_ON` ids include the dependency kind, and the
loader additionally de-duplicates and reports what it dropped.

---

## 6. Whole paths are large, and there is an admission limit

A path procedure returns entire paths, and every node in every path carries its
full property map. A wide blast radius is therefore a large response: ~1000
paths of ~10 nodes each exceeded the default 64MB cursor buffer and was rejected
with:

```
client_cursor_buffer_bytes rejected by admission control:
actual 69473214 exceeds limit 67108864
```

**What we did.** `docker-compose.yml` raises `GRAPH_MAX_CURSOR_BUFFER_BYTES`,
and the client also degrades gracefully: on that rejection it halves the path
budget, retries, and reports the reduction rather than silently returning a
smaller answer.

---

## 7. `CLOUD_PROVIDER=local` eventually fails writes, not just garbage collection

This one escalated the more we looked at it, and it is the reason Blast Radius
ships against MinIO rather than the local filesystem.

SlateDB needs **conditional writes** — `put_opts` with `PutMode::Update` — to
update its manifest. The `object_store` LocalFileSystem backend does not
implement them:

```
object store error: Operation `put_opts` with mode `PutMode::Update`
not yet implemented by LocalFileSystem(file:///data/store)
```

It shows up in three escalating stages:

1. **Garbage collection fails silently.** Every cycle logs
   `error collecting garbage [resource=Manifest, ...]` and storage accumulates.
2. **Reads get slower.** After ~50 failed GC cycles on one instance,
   `blastradius stats` took **38 seconds**; recreating the volume brought the
   identical query back to **1.8 seconds**.
3. **Writes start failing outright** with HTTP 500 `internal query execution
   error` once the manifest actually needs updating. This is what broke the
   integration suite — `beforeAll` could not write its fixture, so whole test
   files were skipped rather than run.

The third stage is the one that matters: a store that cannot complete a write is
not a database you can build on.

**What we did.** `docker-compose.yml` runs **MinIO** and points HydraDB at it
over the S3 API (`CLOUD_PROVIDER=aws`, `AWS_ENDPOINT=http://minio:9000`). MinIO
implements conditional puts, so the engine behaves exactly as it would against
real S3. After the switch: zero `PutMode::Update` errors, zero GC errors, and
the full suite runs 100/100 with nothing skipped.

This is not a defect in HydraDB — it is object-store-native by design, and the
local filesystem simply is not an object store. It is worth documenting loudly
because `CLOUD_PROVIDER=local` looks like the obvious way to start.

---

## 8. Write idempotency is keyed on `query_id`, which the server auto-numbers

The HTTP API accepts an optional `query_id`. If the client omits it, graph-node
assigns `http-query-<N>` from an in-process `AtomicU64`.

That counter restarts at 1 when graph-node restarts — but the object store still
holds the idempotency keys from before the restart. The next batched write then
reuses a key that already stored *different* content, and the whole request is
rejected:

```
idempotency key conflict for relationship-import request key
http-query-94.unwind-relationship-merge: this key already stored a …
```

Surfaced to the client as an opaque `500 internal: internal query execution
error`. It is easy to miss because it needs a restart *plus* an existing store
to reproduce — a fresh container never shows it, so it survived several
full-suite runs before appearing.

**What we did.** The client generates its own `query_id` (a UUID) for every
query, held constant across retries of the same logical write so a retry lands
under the same key rather than a new one. `tests/unit/client.test.ts` pins all
four properties: an id is always sent, ids are unique across queries, a retry
reuses its id, and every chunk of a batch gets its own.

---

## 9. `/healthz` does not exist

The upstream README lists `GET /healthz` among the admin endpoints. The router
actually serves `/livez`, `/readyz` and `/metrics` — `/healthz` returns 404.
Minor, but it is the kind of thing that makes a health check silently useless.

---

## 10. Container storage permissions

The image runs as uid 10001. A host bind mount — especially on macOS, or any
filesystem mounted `noowners` — leaves `/data` unwritable for that uid, and the
node dies immediately after logging `starting graph node`:

```
Error: Os { code: 13, kind: PermissionDenied, message: "Permission denied" }
```

The first thing `run_node` does is `create_dir_all(data_cache_dir)`, which is
what fails. `docker-compose.yml` uses a named volume with an init container that
chowns it, so this never bites a user of this repo.

---

## 11. `EXPLAIN` and `PROFILE` are accepted and silently ignored

Both prefixes parse, and the query then runs normally and returns its *results*
rather than a plan.

```
$ curl -s .../v1/graphs/default/query -d '{"query":"EXPLAIN MATCH (v:Version) RETURN count(*) AS n", ...}'
{"query_id":"exp-25902","columns":["n"],"rows":[[{"type":"integer","value":12463}]],"read_epoch":1972,...}
```

12,463 is the true row count, not an estimate: the `EXPLAIN` was discarded and
the count executed. `PROFILE` behaves identically.

The query response carries `query_id`, `columns`, `rows`, `read_epoch`,
`next_cursor` and `bookmark` — and no plan, cost, or access-path field of any
kind. The optimizer *does* produce that information: the node logs it as a
structured warning on stdout, including the chosen access path and whether it
fell back to a scan.

```json
{"level":"WARN","message":"query plan warrants attention",
 "hydradb.query.access_path":"FullEdgeScan:RESOLVED_TO",
 "hydradb.query.full_scan":true,
 "hydradb.query.rows_estimated":1000000,
 "hydradb.query.optimizer_passes":"FullScanFallback,JoinOrder",
 "reason":"full_scan", "planning_elapsed_ms":2}
```

**Consequence for this project.** A client cannot tell whether a query it just
issued did an index lookup or scanned every `RESOLVED_TO` edge, because the only
channel carrying that verdict is the server's log stream. Blast Radius therefore
does **not** ship an in-product query-plan panel: it would have to tail container
logs it does not own, and correlating a log line to a specific response would
mean matching on `query_id` across two transports. Surfacing a plan the client
guessed at would be worse than not surfacing one.

It is worth noting because it is genuinely the one piece of engine telemetry
this workload most wants. `/api/stats` counts four edge types and every one of
them logs `full_scan`; that is exactly the query a plan field would have let the
tool flag and cache deliberately rather than by measurement.

## What this project would lose without HydraDB

Not a rhetorical question — it is worth being specific.

- **Bounded reverse traversal is one call.** `algo.SSpaths` walking three
  relationship types backwards returns, for every reachable node, the shortest
  chain from the compromised version out to it — including the intermediate
  nodes with their properties. In SQL this is a recursive CTE that materialises
  the transitive closure of a 10k-edge graph per query; in application code it
  is a hand-rolled BFS that has to hold the graph in memory and cannot persist.
- **Paths come back as paths.** The dependency chain *is* the result, so the
  report explains itself. An endpoint-only query would answer "exposed: yes" and
  need a second pass to say why.
- **Point-in-time queries are ordinary queries.** Every read runs against one
  pinned snapshot, and `strong` refreshes from object storage before pinning. The
  Time Machine is a range predicate over that snapshot, not a bitemporal
  framework bolted on top.
- **A vector index cannot do any of this.** "Which repositories resolved this
  exact version between 09:00 and 09:06" has no similarity component whatsoever.
  It is a graph reachability question crossed with a time window, and the answer
  must be exact — a nearest-neighbour result would be actively harmful in an
  incident response.

## 12. The GraphBLAS path is never taken by path procedures

`/metrics` exposes a sparse-linear-algebra subsystem —
`graph_query_graphblas_artifact_snapshots`, `graph_query_graphblas_rebuilt_snapshots`,
`graph_query_graphblas_cache_microseconds`, `graph_cache_graphblas_hits` /
`_misses`, and `graph_query_rust_sparse_fallbacks`. On this deployment **every
one of them reads zero**, and stays zero under load.

What was tried, all against the running engine:

- `algo.SSpaths` with a path budget of 100,000 over three edge types at depth 20
- `algo.MSpaths` with multiple indexed sources and targets, 50,000 paths
- The product's full workload — ~10,000 queries returning 3.6M rows

The counters did not move. There is no documented switch: the `graph-node`
binary takes no `--help` and exposes no GraphBLAS configuration through the
query API.

**The conclusion is not "the feature is broken."** It is that this engine's path
procedures are served by a traversal executor rather than by sparse matrix
multiplication, and the GraphBLAS artifact path belongs to a different class of
query — plausibly the whole-graph analytics (centrality, community detection)
that this engine does not currently expose either. Both observations point the
same way, which is itself the evidence.

Blast Radius surfaces the zero in the Engine sheet with that explanation rather
than hiding the row. A metric that reads zero for a knowable reason is more
informative than one that is absent.

## 13. Bolt can come back from a restart publishing no route

Seen once, and recorded as unexplained rather than explained.

After a `docker compose restart`, the engine answered HTTP normally within six
seconds while Bolt stayed unusable for a full minute of polling. The driver
error names the condition exactly:

```
Could not perform discovery. No routing servers available.
Known routing table: RoutingTable[database=default, routers=[], readers=[], writers=[]]
```

The engine's own log showed the placement view at `hydradb.placement.state:
"fresh"` and never advancing. `docker compose up -d --force-recreate hydradb`
cleared it on the first attempt.

**The honest limit of this finding:** four subsequent restarts all came back
with Bolt healthy, so a restart is not sufficient to reproduce it. The remedy is
known; the trigger is not. `blastradius doctor --bolt` now recognises the empty
routing table and prints the recreate command, because the raw driver message
reads like a client bug when the client is fine — but it says "seen
intermittently" rather than naming a cause the evidence does not support.

This matters beyond the demo: an application that health-checks only the HTTP
API would consider this node healthy while every Bolt consumer fails.
