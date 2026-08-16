# Blast Radius

**A live, queryable supply-chain attack graph, built on [HydraDB](https://github.com/hydra-db/hydradb).**

> A package is compromised at 09:00. Which of your services are exposed by 09:06?

Every tool in this space — Socket, Snyk, OSV-Scanner, JFrog, Cloudsmith,
`depscan` — answers that with a static scan of your *current* lockfiles. That
tells you what you ship today. It cannot tell you what you shipped at 09:03,
while the malicious artifact was live, because it has no notion of what was true
then.

Blast Radius keeps the whole npm dependency graph *and* your organisation's
lockfile history in a graph database, so both questions are ordinary queries:

- **Exposed now** — walk `RESOLVED_TO` backwards from the compromised version to
  every repository that depends on it, transitively, with the dependency chain
  that explains why.
- **Exposed *then*** — the **Lockfile Time Machine**: which repositories had a
  lockfile that resolved to the bad version *during the exact window it was
  live*. A repo that has since upgraded looks clean to every scanner on the
  market. It still ran the malicious build.

Those two sets are different, and the difference is the product.

```
EXPOSED NOW  vs  EXPOSED DURING THE WINDOW
repo                      exposed now     during window
----------------------------------------------------------
admin-dashboard           yes             yes
customer-portal           yes             no
design-system             yes             no
internal-cli-tool         yes             yes
notifications-worker      no              yes
onboarding-frontend       no              yes
payments-service          yes             yes
search-indexer            no              yes

! 3 repos were exposed during the incident but are clean now:
  search-indexer, notifications-worker, onboarding-frontend
  A scanner that only reads current lockfiles reports these as safe.
  They ran the malicious build.
```

---

## Contents

- [Quick start](#quick-start)
- [What is in the graph](#what-is-in-the-graph)
- [Usage — six worked examples](#usage--six-worked-examples)
- [The dashboard](#the-dashboard)
- [How HydraDB is used](#how-hydradb-is-used)
- [What this project loses without HydraDB](#what-this-project-loses-without-hydradb)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Tests](#tests)
- [Data sources and attribution](#data-sources-and-attribution)
- [License](#license)

---

## Quick start

Requirements: **Docker**, **Node 20+**. Nothing else — HydraDB runs from the
published image, and the graph snapshot is committed, so the demo needs no
network access.

```bash
git clone <this repo> && cd blast
make demo
```

`make demo` builds the packages, starts HydraDB on a clean volume, loads the
vendored graph (~43k rows in ~95 batched round trips, about 2 seconds), and
marks the demo incident compromised. Then:

```bash
make exposure       # full blast radius        (algo.SSpaths)
make time-machine   # exposed now vs exposed then
make maintainers    # shared-maintainer risk   (algo.SSpaths over MAINTAINS)
make typosquats     # near-name packages
make simulate       # replay the worm with a live attack clock
make serve          # dashboard on http://127.0.0.1:4000
```

`make doctor` verifies connectivity and asserts every engine capability the
project depends on. Run it first if anything looks wrong.

To rebuild the graph from the live registry instead of the committed snapshot:

```bash
make ingest         # ~90s: npm registry + OSV.dev, cached under data/cache/
make load
```

---

## What is in the graph

The package graph is **real**, crawled from the public npm registry. Only the
organisation on top of it is synthetic — a plausible company whose repositories
depend on real packages, with a generated history of lockfile captures.

| | count |
|---|---|
| `Package` | 1,399 |
| `Version` | 12,351 |
| `Maintainer` | 313 |
| `Repo` | 18 |
| `LockfileSnapshot` | 123 |
| `RESOLVED_TO` edges | 9,846 |
| `RESOLVED` edges | 6,942 |
| `MAINTAINS` edges | 815 |
| `NAME_SIMILAR_TO` edges | 200 |
| real OSV advisories matched | 40 |

Seeded from ~300 of the most-depended-on npm packages and expanded through their
real dependency trees. Version ranges are resolved to concrete versions with
`semver`, exactly as a package manager would, so `RESOLVED_TO` is a real
resolution rather than a guess.

### Schema

**Nodes** — `Package`, `Version`, `Maintainer`, `Org`, `Repo`, `LockfileSnapshot`

**Relationships**

| edge | meaning |
|---|---|
| `(:Version)-[:DEPENDS_ON {range, kind}]->(:Package)` | a declared dependency — a *range*, unresolved |
| `(:Version)-[:RESOLVED_TO]->(:Version)` | what that range actually resolves to |
| `(:Maintainer)-[:MAINTAINS]->(:Package)` | who can publish |
| `(:LockfileSnapshot)-[:RESOLVED {direct}]->(:Version)` | every version this lockfile pinned |
| `(:LockfileSnapshot)-[:RESOLVED_DIRECT]->(:Version)` | just the direct dependencies |
| `(:Repo)-[:HAS_SNAPSHOT]->(:LockfileSnapshot)` | a repo's lockfile history |
| `(:Package)-[:NAME_SIMILAR_TO {distance, score, reason}]->(:Package)` | precomputed typosquat proximity |

Two modelling decisions are worth explaining, because both were forced by real
behaviour rather than chosen on paper:

**Why `DEPENDS_ON` *and* `RESOLVED_TO`.** A range is what a manifest says; a
resolution is what a build actually did. Conflating them is precisely what makes
a scanner unable to answer "who shipped the bad build".

**Why `RESOLVED` *and* `RESOLVED_DIRECT`.** A lockfile pins its entire tree, not
just the packages you named — so `RESOLVED` has an edge to every transitive
package. That completeness is what the Time Machine needs: "this lockfile pinned
this precise version" must be a single-hop fact. But it is the wrong edge to
traverse for a blast radius: because every transitive package is *also* pinned
directly, a shortest-path traversal takes the one-hop shortcut and reports every
exposure as depth 1, losing the chain that explains it. Blast radius therefore
enters through `RESOLVED_DIRECT` and walks `RESOLVED_TO` from there, recovering
the real dependency chain. Both edges are honest; they answer different
questions.

---

## Usage — six worked examples

Every command below is real, copy-pasteable, and produces the output shown after
`make demo`. The compromised package is whatever ingestion recorded in the
snapshot — `blastradius incident` prints it, and the Makefile targets read it
from there so nothing drifts.

### 1 — Mark a package compromised, then get the full report

```bash
blastradius mark-compromised npm:debug@4.4.3 \
    --from "2026-08-14T09:00:00Z" --to "2026-08-14T09:06:00Z" \
    --advisory BLAST-DEMO-2026-0001

blastradius exposure npm:debug@4.4.3
```

```
BLAST RADIUS REPORT — npm:debug@4.4.3
compromise window 2026-08-14T09:00:00Z → 2026-08-14T09:06:00Z  (BLAST-DEMO-2026-0001)
Currently exposed (live graph, causal read):
  repo: admin-dashboard          depth 2   path: admin-dashboard
                                                 -> yeoman-generator@8.1.2
                                                 -> debug@4.4.3
  repo: customer-portal          depth 2   path: customer-portal
                                                 -> finalhandler@2.1.1
                                                 -> debug@4.4.3
  repo: internal-cli-tool        depth 2   path: internal-cli-tool
                                                 -> istanbul-lib-source-maps@5.0.0
                                                 -> debug@4.4.3
  repo: payments-service         depth 2   path: payments-service
                                                 -> https-proxy-agent@9.1.0
                                                 -> debug@4.4.3
  repo: design-system            depth 3   path: design-system -> serve-static@2.2.1
                                                 -> send@1.2.1 -> debug@4.4.3

Exposed only through a superseded lockfile (upgraded since — see `blastradius time-machine`):
  repo: auth-gateway             depth 2   lockfile 2026-07-24T14:55:30Z
  ...

Exposed packages in the dependency graph: 226
Query time: 7ms  (algo.SSpaths, maxLen=10, pathCount=20000)
Paths returned: 1024
```

Those are real npm packages and real dependency chains. `design-system` is
exposed three hops deep, through `serve-static → send → debug`.

Add `--which-version` to print the version timeline showing where the flaw
entered, and `--verified` to read with strong consistency.

### 2 — Exposure during the exact live window (the killer query)

```bash
blastradius time-machine npm:debug@4.4.3 --verified
```

```
LOCKFILE TIME MACHINE — exposure window 09:00:00–09:06:00 UTC, Aug 14 2026
package: npm:debug@4.4.3

Snapshots resolved to the bad version DURING the window:
  repo: search-indexer           lockfile captured 09:00:09Z  ← EXPOSED DURING WINDOW
  repo: notifications-worker     lockfile captured 09:01:39Z  ← EXPOSED DURING WINDOW
  repo: onboarding-frontend      lockfile captured 09:02:22Z  ← EXPOSED DURING WINDOW
  repo: payments-service         lockfile captured 09:04:02Z  ← EXPOSED DURING WINDOW
  repo: admin-dashboard          lockfile captured 09:04:49Z  ← EXPOSED DURING WINDOW
  repo: internal-cli-tool        lockfile captured 09:05:00Z  ← EXPOSED DURING WINDOW

Snapshots that have since upgraded past the bad version
(no longer live-exposed, but WERE exposed during the incident — still worth a security review):
  repo: search-indexer           captured 09:00:09Z, superseded 10:10:47Z
  repo: notifications-worker     captured 09:01:39Z, superseded 09:50:13Z
  repo: onboarding-frontend      captured 09:02:22Z, superseded 10:08:27Z

Still pinned to the bad version right now:
  repo: payments-service         captured 09:04:02Z  ← STILL EXPOSED
  repo: admin-dashboard          captured 09:04:49Z  ← STILL EXPOSED
  repo: internal-cli-tool        captured 09:05:00Z  ← STILL EXPOSED

Query time: 38ms  (strong consistency, pinned snapshot, verified)
Read epoch: 97
```

Followed by the side-by-side comparison at the top of this README. `--verified`
reads with `strong` consistency, which refreshes from object storage before
pinning the snapshot — so the answer is guaranteed to include every write
committed before the query began.

### 3 — Proactive maintainer risk, before anything is compromised

```bash
blastradius maintainers npm:debug
```

```
SHARED-MAINTAINER RISK for npm:debug
  maintainers: tootallnate, qix

  npm:color-convert                  shares maintainer "qix"
  npm:util-deprecate                 shares maintainer "tootallnate"
  npm:bcrypt                         shares maintainer "tootallnate"

Risk score: LOW (no other package sharing a maintainer with debug is in your dependency set)
Query time: 11ms  (algo.SSpaths over MAINTAINS, relDirection='both', maxLen=2)
```

A compromised publish credential compromises every package it can publish to.
One `algo.SSpaths` call over `MAINTAINS` with `relDirection: 'both'` and
`maxLen: 2` walks `Package ← Maintainer → Package`, so the reason for the risk
comes back with the risk. Risk is scored by how many of *your* dependencies sit
behind one account.

### 4 — Typosquat check against your own dependency list

```bash
blastradius typosquats --org acme-corp
```

```
POSSIBLE TYPOSQUATS of your top dependencies (org: acme-corp)
  "inherits" vs "@ryancavanaugh/inherits"  (edit distance 0)
                                           10 weekly downloads and a high-risk edit pattern — SUSPICIOUS
                                           same package name as "inherits" under different ownership (dependency confusion)
                                           first published 2016-05-17T03:49:59Z

  "supports-color" vs "@cjser/supports-color" (edit distance 0)
                                           published 21 days ago with 10 weekly downloads — SUSPICIOUS
                                           same package name as "supports-color" under different ownership

  "performance-now" vs "performancenow"    (edit distance 1)
                                           4 weekly downloads — SUSPICIOUS
                                           punctuation variant of "performance-now"

Summary: 84 suspicious, 16 watch, 100 likely legitimate
```

These are **real packages on npm**, found by searching the registry for names
near the org's own dependencies — the dependency crawl only ever reaches
packages that are legitimately depended on, so a squat is by construction not in
anybody's tree and has to be searched for.

Proximity alone decides nothing: `preact` is one edit from `react` and entirely
legitimate. The graph stores the edge *and the reason*, and the verdict combines
the kind of edit with the candidate's age and download volume.

### 5 — Full incident simulation

```bash
blastradius simulate --scenario tanstack-worm-2026
```

```
INCIDENT SIMULATION — TanStack-style self-propagating npm worm
Seed package:   npm:debug@4.4.3
Live window:    09:00:00Z → 09:06:00Z (6 minutes)
Artifacts:      up to 43 malicious versions

Every measurement below is a live algo.SSpaths traversal against HydraDB.
------------------------------------------------------------------------
T+00:00  PUBLISH  npm:debug@4.4.3                        via initial compromise
T+00:30  PUBLISH  npm:ajv@8.20.0                         via blakeembrey
T+00:30  PUBLISH  npm:mime-types@3.0.2                   via ulisesgascon
T+00:30  EXPOSED  9   repos  226 packages    4 malicious versions live  737ms
T+01:00  PUBLISH  npm:on-finished@2.4.1                  via ulisesgascon
T+01:00  PUBLISH  npm:depd@2.0.0                         via dougwilson
T+01:00  EXPOSED  10  repos  226 packages    8 malicious versions live  814ms
T+03:00  PUBLISH  npm:send@1.2.1                         via ulisesgascon
T+03:00  EXPOSED  10  repos  226 packages    22 malicious versions live 1.69s
T+04:30  PUBLISH  npm:body-parser@1.20.6                 via ulisesgascon
T+04:30  EXPOSED  10  repos  226 packages    32 malicious versions live 1.08s
```

The worm spreads along **real maintainer edges** — `ulisesgascon` and
`dougwilson` genuinely co-maintain much of the Express ecosystem, so a stolen
credential really would reach `send`, `body-parser`, `serve-static` and the rest.
Propagation is itself a traversal: `algo.SSpaths` over `MAINTAINS` with
`relDirection: 'both'` and `maxLen: 6` is "publish to this account's packages,
harvest the co-maintainers' credentials, repeat".

Every `EXPOSED` line is a real query. `--speed` compresses the window into that
many wall-clock seconds; `--json` emits newline-delimited events.

### 6 — Many repos in one round trip

```bash
blastradius exposure npm:debug@4.4.3 \
    --repos payments-service,billing-api,onboarding-frontend,internal-cli-tool
```

```
BLAST RADIUS REPORT — npm:debug@4.4.3
Currently exposed (live graph, causal read):
  repo: internal-cli-tool        depth 2   path: internal-cli-tool
                                                 -> istanbul-lib-source-maps@5.0.0
                                                 -> debug@4.4.3
  repo: payments-service         depth 2   path: payments-service
                                                 -> https-proxy-agent@9.1.0
                                                 -> debug@4.4.3

Exposed only through a superseded lockfile:
  repo: billing-api              depth 2   lockfile 2026-07-27T03:05:08Z
  repo: onboarding-frontend      depth 2   lockfile 2026-08-14T09:02:22Z

Query time: 77ms  (algo.MSpaths, maxLen=10, pathCount=20000)
Paths returned: 45
```

One `algo.MSpaths` call resolves all four repositories inside the engine instead
of fanning out four traversals from the client.

> **On `pairwise: true`.** This build of HydraDB **silently drops** any pair
> whose source vertex id is greater than its target's — the identical pair
> returns its path in non-pairwise mode, and both `SSpaths` and `SPpaths` find
> it. Since node ids are an allocation detail, pairwise would drop roughly half
> of all exposures at random, with no error. Blast Radius uses non-pairwise
> `MSpaths`, which is the correct shape for one-source-many-targets anyway.
> `--pairwise` is available to demonstrate the difference, and
> `tests/integration/mspaths-pairwise.test.ts` pins it down. See
> [`docs/hydradb-findings.md`](docs/hydradb-findings.md#2-algomspaths-with-pairwise-true-silently-drops-pairs).

---

## The dashboard

```bash
make serve   # http://127.0.0.1:4000
```

Five views, all backed by live queries — nothing precomputed, nothing mocked:

- **Blast radius** — exposed repos with dependency chains, plus a force-directed
  graph of the exposure rendered from the paths the traversal returned. Toggle
  "verified read" for strong consistency, or switch to the MSpaths subset check.
- **Time machine** — the timeline of every lockfile capture that ever pinned the
  version, with the compromise window shaded; a scrubber that re-queries
  exposure as of any instant; and the side-by-side now-vs-then comparison with
  an explicit explanation of why the columns differ.
- **Maintainer web** — a radial graph of the accounts that can publish to a
  package and everything else they can reach, with your own dependencies in red.
- **Typosquats** — findings filtered by verdict, with the reason for each.
- **Attack clock** — runs the scenario over SSE and animates exposure spreading,
  with the elapsed incident clock and the latency of each live traversal.

---

## How HydraDB is used

Every native feature this project leans on, and where:

| HydraDB feature | Where it is used |
|---|---|
| **`algo.SSpaths`** | The core blast radius. One call from the compromised `Version`, `relDirection: 'incoming'`, over `RESOLVED_TO` + `RESOLVED_DIRECT` + `HAS_SNAPSHOT`, returns the shortest chain to every reachable node — repos, lockfiles and packages together. Also the Maintainer Web (`MAINTAINS`, `both`, `maxLen: 2`) and worm propagation (`MAINTAINS`, `both`, `maxLen: 6`). |
| **`algo.MSpaths`** | The multi-repo check (`--repos`), and the simulation's combined-exposure measurement — every compromised version as an indexed source against every repo as a target, in one round trip. Non-pairwise, deliberately. |
| **`algo.SPpaths`** | Used in the regression suite to prove a path exists that pairwise `MSpaths` loses. |
| **Pinned snapshots** | Every query runs against one consistent point-in-time view. This is what makes the Time Machine a *query* rather than a framework: a range predicate over `captured_at` inside a snapshot that cannot shift underneath it. |
| **`causal` vs `strong` reads** | The dashboard's "verified" toggle and `--verified`. `strong` refreshes the reader from object storage before pinning, guaranteeing every committed write is visible. |
| **Batched `UNWIND` writes** | The entire loader. ~43k rows in ~95 round trips, ~2s. One statement per node or edge would be hopeless at ecosystem scale. |
| **OpenCypher subset** | All lookups, aggregates (`count`, `collect`), `ORDER BY` / `LIMIT`, `DISTINCT`, `STARTS WITH` prefix search, and `MERGE`-based idempotent upserts. |
| **Automatic property indexes** | `MSpaths` selectors resolve `sourceValues` against the string `key` property with no DDL at all. |
| **Bolt** | `HYDRA_BOLT_URL` is configured and the endpoint is exposed; the client uses the typed HTTP/JSON API because it gives direct access to path payloads with node properties attached. |

Paths come back with **node labels and properties attached**, which is load-
bearing: the report renders the dependency chain, attributes each exposure to a
lockfile, and distinguishes current from superseded — all from one response,
with no follow-up round trip.

The engine's sharp edges — and how each one changed the design — are documented
in **[`docs/hydradb-findings.md`](docs/hydradb-findings.md)**, with the probe
evidence for each. The `pathCount` default and the pairwise defect are the two
that would silently produce wrong security answers.

---

## What this project loses without HydraDB

Concretely:

- **Without native bounded path traversal**, the blast-radius query becomes a
  recursive SQL CTE materialising the transitive closure of a 10k-edge graph on
  every request, or a hand-rolled BFS in application code that holds the graph in
  memory and cannot persist it. The traversal here is one call and single-digit
  milliseconds.
- **Without paths as a return type**, you get "exposed: yes" and need a second
  pass to reconstruct *why*. The chain `design-system → serve-static → send →
  debug` is the whole value of the report, and it arrives with the answer.
- **Without snapshot-consistent reads**, the Time Machine is not implementable
  as stated. Point-in-time exposure over a graph that can shift mid-query is not
  a point-in-time answer. This feature specifically is why the project is on a
  graph engine with pinned snapshots rather than on Postgres with a timestamp
  column.
- **A vector index cannot express any of this.** "Which repositories resolved
  this exact version between 09:00:00 and 09:06:00" has no similarity component
  at all — it is graph reachability crossed with a time window, and the answer
  must be exact. A nearest-neighbour result would be actively harmful during an
  incident.

---

## Architecture

```
                    npm registry API          OSV.dev
                          │                      │
                          ▼                      ▼
   ┌──────────────────────────────────────────────────────┐
   │  ingest/   crawl → semver-resolve → advisories →      │
   │            synthetic org + lockfile history →         │
   │            typosquat candidate search                 │
   └──────────────────────────┬───────────────────────────┘
                              │  data/snapshot/graph.json  (committed)
                              ▼
   ┌──────────────────────────────────────────────────────┐
   │  loader     batched UNWIND writes  ~43k rows / ~95 RTs│
   └──────────────────────────┬───────────────────────────┘
                              ▼
                    ┌───────────────────┐
                    │      HydraDB      │  Bolt 7687 · HTTP 8443 · admin 9090
                    │  object-store     │
                    │  native graph     │
                    └─────────┬─────────┘
             algo.SSpaths / algo.MSpaths / pinned snapshots
                              │
   ┌──────────────────────────┴───────────────────────────┐
   │  queries/  blastRadius · timeMachine · maintainers ·  │
   │            typosquats · combinedExposure             │
   └───────┬──────────────────────────────────┬───────────┘
           ▼                                  ▼
   blastradius CLI                    Express API → React dashboard
                                       (SSE for the attack clock)
```

```
packages/
  core/        HydraDB client, model, ingestion, queries, simulation
  cli/         the `blastradius` command + the dashboard API server
  dashboard/   Vite + React + d3-force
data/
  snapshot/    the committed graph (graph.json, id-map.json)
  cache/       raw registry responses (gitignored, regenerable)
docs/
  hydradb-findings.md   what we verified about the engine, with evidence
tests/
  unit/        proximity scoring, semver resolution, OSV ranges, determinism
  integration/ traversal depth, window boundaries, maintainers, MSpaths defect
```

---

## Configuration

Every tunable is documented in [`.env.example`](.env.example); copy it to `.env`
to change anything. The ones that matter most:

| variable | default | why it matters |
|---|---|---|
| `BLAST_MAX_DEPTH` | `8` | Dependency-chain depth. The engine caps total path length at 16 hops and Blast Radius spends 2 reaching the owning repo, so the ceiling is 14 — enforced at startup with an explanatory error. |
| `BLAST_PATH_COUNT` | `20000` | **`pathCount` is a total budget and defaults to 1 in HydraDB.** Left unset it silently returns one path. Any report that comes back holding exactly its budget is flagged truncated. |
| `BLAST_VERIFIED_CONSISTENCY` | `strong` | What `--verified` switches to. |
| `TYPOSQUAT_MAX_DISTANCE` | `2` | Edit-distance ceiling for a `NAME_SIMILAR_TO` edge. |
| `INGEST_SEED_COUNT` | `300` | Seed packages for the crawl. |
| `INGEST_FULL_METADATA_DEPTH` | `0` | Full packuments carry per-version publish times and maintainers but are huge (typescript's is 15MB); only the seeds get one. |
| `ORG_RANDOM_SEED` | `20260814` | Generation is fully deterministic, so a clean clone reproduces this README's output exactly. |

### Operational note

With `CLOUD_PROVIDER=local`, SlateDB's garbage collector cannot run against the
local filesystem, so a long-lived instance accumulates storage and reads get
slower — we measured `stats` degrading to 38s, back to 1.8s after recreating the
volume. `make db-reset` does that and is what `make demo` uses. For anything
longer-lived, point `CLOUD_PROVIDER` at MinIO or S3.

---

## Tests

```bash
make test
```

70 tests, ~35s against a running HydraDB.

**Unit** (no database): proximity scoring and every typosquat threshold,
including the false-positive classes we had to suppress; semver range
resolution; OSV half-open `[introduced, fixed)` range arithmetic; scoped-key
parsing; version-timeline "which version introduced it"; PRNG determinism.

**Integration** (against a real graph): traversal correctness at depths 1, 2 and
3 with chain verification; depth-limit behaviour; truncation flagging;
`MSpaths` subset checks; **Time Machine window boundaries — exactly-at-start,
exactly-at-end, one-millisecond-before, one-millisecond-after**, inverted
windows, missing windows, and causal/strong equivalence; point-in-time
`exposureAsOf` including superseded snapshots; maintainer sharing; and the
`MSpaths` pairwise regression test.

Integration tests build their own fixture graph in a reserved id range, so they
neither depend on nor disturb the demo data.

---

## Data sources and attribution

- **npm registry** (<https://registry.npmjs.org>) — package metadata, versions,
  dependencies, maintainers, publish timestamps. Accessed through the public
  API; responses are cached under `data/cache/`.
- **npm downloads API** (<https://api.npmjs.org>) — weekly download counts, used
  in typosquat risk scoring.
- **OSV.dev** (<https://osv.dev>) — real vulnerability advisories, including
  GitHub Security Advisory records. 40 advisories in the committed snapshot are
  genuine OSV records matched against versions in the graph.
- **HydraDB** (<https://github.com/hydra-db/hydradb>) — the graph engine.
  AGPL-3.0. Used unmodified via its published container image and its public
  Bolt / HTTP interfaces.
- **[`semver`](https://github.com/npm/node-semver)** (ISC) — version range
  resolution, so `RESOLVED_TO` matches what a package manager would pick.
- **[`d3-force`](https://github.com/d3/d3-force)** (ISC) — dashboard graph layout.
- **React**, **Vite**, **Express**, **commander**, **vitest** — MIT.

The `tanstack-worm-2026` scenario is modelled on the May 2026 TanStack npm/PyPI
worm (84 malicious artifacts across 42 packages in ~6 minutes, self-propagating
via maintainer credentials). Blast Radius replays the *pattern* — timing,
fan-out, propagation along maintainer edges — against the real ingested graph. It
does not reproduce or distribute any malicious code, and no real package in the
graph is a real compromise: compromise markings are applied at runtime by the
user or the simulator.

The organisation (`acme-corp`), its repositories, and their lockfile history are
synthetic. Everything beneath them is real.

---

## License

MIT — see [LICENSE](LICENSE).

HydraDB itself is AGPL-3.0 and is used as an unmodified external service over
its network interfaces; no HydraDB code is included in or linked into this
repository.
