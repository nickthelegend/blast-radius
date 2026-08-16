# Submission draft answers

Ready to paste. Adjust the URLs before submitting.

---

**Project name**

Blast Radius

**Track**

2A — Supply Chain Blast Radius

**One-line description**

A live, queryable supply-chain attack graph on HydraDB that answers not just
"which services are exposed now" but "which services were exposed during the six
minutes the malicious version was actually live".

---

**What it does**

Blast Radius keeps the real npm dependency graph and an organisation's lockfile
history in HydraDB, so supply-chain exposure becomes a graph traversal rather
than a static scan.

Given a compromised package version it answers, in one native traversal:

- which repositories are exposed, transitively, and the exact dependency chain
  that explains each one (`design-system → serve-static → send → debug`);
- which repositories had a lockfile that resolved the bad version *during the
  compromise window* — the **Lockfile Time Machine**, and the query a
  current-state scanner structurally cannot answer;
- which other packages share a maintainer, so a stolen publish credential's
  reach is visible before anything is compromised;
- which real packages on npm have names suspiciously close to your own
  dependencies.

It also **scans real repositories**: point `blastradius scan` at any JavaScript
project and its actual lockfile — every pinned version, npm's own hoisting
resolution, the file's mtime as the capture instant — joins the graph. Scanning
Blast Radius's own repository finds that it is itself exposed, through
`vitest@2.1.9 → debug@4.4.3`.

And it answers the follow-up question: `blastradius remediate` takes every
published version of each offending dependency, throws them all at the graph in
one `algo.MSpaths` call, and reports the minimal change that stops the
compromised version being resolved — labelling rollbacks as rollbacks.

It also answers **what changed**: `blastradius diff` compares exposure at two
instants from a single read, so the two sides of the diff cannot straddle a
write — the question an incident commander asks on the second morning.

And it closes the loop into CI. `blastradius ci` exits 0 clean / 1 exposed / 2
could-not-run, and with `--sarif` emits SARIF 2.1.0 that the shipped GitHub
Actions workflow uploads to code scanning — so the gate is not a script that
exits non-zero but findings in the repository's Security tab that annotate the
pull request and close themselves when the exposure clears. That is live on this
repository right now.

It ships a CLI, an eight-view live dashboard, and a scripted incident simulator
that replays the May 2026 TanStack worm pattern against the real graph with an
attack clock.

---

**Why the "now vs then" distinction matters**

They are different sets, and both matter.

In the demo dataset, three repositories were exposed during the incident window
and are clean today — every scanner on the market reports them safe, and all
three ran the malicious build. Two others are exposed right now but never
touched the malicious artifact, because they picked the version up after it was
pulled. Conflating those two groups sends an incident response after the wrong
repositories.

Answering it requires knowing what each lockfile resolved to at a past instant.
That is a bitemporal graph question, and it is the reason this is built on a
graph engine with pinned snapshots rather than a scanner with a database behind
it.

---

**How HydraDB is used**

- **`algo.SSpaths`** — the core blast radius. One call from the compromised
  `Version` with `relDirection: 'incoming'` over `RESOLVED_TO` +
  `RESOLVED_DIRECT` + `HAS_SNAPSHOT` returns the shortest chain to every
  reachable node. Also drives the Maintainer Web and the worm's propagation
  along `MAINTAINS` edges.
- **`algo.MSpaths`** — many indexed sources against many targets in one round
  trip: the multi-repo check, and the simulator's combined-exposure measurement
  across every version the attacker controls.
- **Pinned snapshots** — every query is point-in-time, which is what makes the
  Time Machine a query rather than a framework.
- **`causal` / `strong` reads** — the dashboard's "verified" toggle; `strong`
  refreshes from object storage before pinning.
- **Batched `UNWIND` writes** — 43,651 rows in 95 round trips, ~2.4 seconds.
- **Bolt (Neo4j wire protocol)** — `blastradius doctor --bolt` connects a stock
  `neo4j-driver`, runs `algo.SSpaths` through it, and asserts the result matches
  the same query over HTTP.
- **Automatic property indexes** — `MSpaths` selectors resolve against a string
  `key` property with no DDL.

Paths return with node labels and properties attached, so a single response
yields the exposed repository, the dependency chain, the lockfile it came
through, and whether that lockfile is current — with no follow-up query.

---

**What we found in the engine**

Documented with evidence in `docs/hydradb-findings.md`. Two would silently
produce wrong security answers:

1. **`pathCount` is a total path budget and defaults to 1.** A blast-radius
   query that leaves it unset returns a single path and looks like it worked. We
   set it explicitly, flag any result that comes back holding exactly its budget
   as truncated, and assert the semantics in `blastradius doctor`.

2. **`algo.MSpaths` with `pairwise: true` silently drops any pair whose source
   vertex id is greater than its target's.** Reproduced on three independent
   pairs; the identical pair returns its path in non-pairwise mode, and both
   `SSpaths` and `SPpaths` find it. Since node ids are an allocation detail this
   would drop roughly half of all exposures at random. We ship the non-pairwise
   form and pinned the defect in `tests/integration/mspaths-pairwise.test.ts`.

Also documented: the batch-write grammar and its exact rejection messages, the
cursor-buffer admission limit on large path responses (we degrade gracefully),
and that SlateDB's GC cannot run against local-filesystem storage, so long-lived
local instances slow down until the volume is recreated.

---

**Data**

Real. ~300 of the most-depended-on npm packages expanded through their actual
dependency trees: 1,399 packages, 12,351 versions, 9,846 resolved edges, 313
maintainers, and 40 genuine OSV.dev advisories matched to versions in the graph.
Version ranges are resolved with `semver`, exactly as a package manager would.

Only the organisation is synthetic — 18 repositories and 123 lockfile captures
across a simulated timeline, generated deterministically from a fixed seed so a
clean clone reproduces the documented output exactly.

---

**How to run it**

```bash
git clone <repo> && cd blast
make demo          # Docker + Node 20+; no network needed, snapshot is committed
make exposure
make time-machine
make serve         # dashboard on http://127.0.0.1:4000
```

`make doctor` verifies connectivity and asserts every engine capability used.
`make test` runs 113 tests in ~70s.

---

**Repository**

`<public GitHub URL>` — MIT licensed. First commit August 2026; no pre-hackathon
history.

**Demo video**

`<URL>` — under 3 minutes. Script in `docs/demo-script.md`.

---

**Anything else?**

The two engine findings above were reported back rather than worked around
quietly — the pairwise defect in particular has a regression test that will fail
when it is fixed, which felt like the more useful contribution than silently
using the other code path.
