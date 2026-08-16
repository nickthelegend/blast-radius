# 100 ideas, ranked

Scored `impact × feasibility × fit` for **Hack Hydra Track 2A** and the **Best
Use of HydraDB** award. Impact = would a judge notice. Feasibility = buildable
and verifiable for real. Fit = strengthens the pitch rather than cluttering it.

The pitch this has to protect: *a live, queryable supply-chain graph that
answers "who was exposed while the malicious version was live" — a question a
flat scanner structurally cannot ask.* Anything that dilutes that is ranked
down even if it is fun.

Status: **BUILT** (verified working) · **skipped** (with reason).

---

## Tier 1 — build first (high impact, strong fit, real)

| # | Idea | Why it wins | Status |
|---|---|---|---|
| 1 | **Live Cypher console** in the dashboard, with the exact query each view ran, editable and re-runnable | Judges see HydraDB actually doing the work instead of taking our word for it. Strongest possible evidence for the Best-Use award | **BUILT** |
| 2 | **Query provenance** — every panel exposes the Cypher behind it, one click to open in the console | Turns the whole UI into a demonstration of graph-native retrieval | **BUILT** (blast radius, time machine, remediation; verified re-running the traversal from the graph panel — 6,002 rows, engine 475ms) |
| 3 | **`blastradius ci`** — exit non-zero when exposed, with `--max-depth`/`--fail-on` thresholds | The unglamorous thing that makes it a real tool, not a demo | **BUILT** |
| 4 | **GitHub Action workflow** committed and runnable, gating a PR on blast radius | Shows productionisation; judges recognise it instantly | **BUILT** |
| 5 | **CycloneDX SBOM export** of any repo's resolved tree | Real interop standard; proves the graph holds genuine SBOM-grade data | **BUILT** |
| 6 | **SBOM import** — ingest a CycloneDX file as a LockfileSnapshot | Lets a judge bring their own SBOM | skipped (export only; import needs a purl→Version resolver for packages not in the graph, which is a scan, not an import) |
| 7 | **Incident report export** (Markdown) — the whole incident as a shareable artifact | The output an on-call engineer actually needs | **BUILT** |
| 8 | **Preflight "what if" ranking** — for the top N dependencies, precompute blast radius and rank by damage | Inverts the product from reactive to proactive; pure graph work | **BUILT** |
| 9 | **Deep-linkable URL state** (`?v=…&tab=…`) | Demo can jump straight to a view; judges can share links | **BUILT** |
| 10 | **Command palette (⌘K)** — jump to any package, repo, or view | Makes a dense tool feel fast and considered | **BUILT** |
| 11 | **Severity-weighted exposure ranking** (advisory severity × depth × downloads × direct) | "Quality of results" — an ordered worklist, not an unordered dump | **BUILT** |
| 12 | **Blast-radius diff between two scans** of the same repo | Shows the temporal graph doing something beyond one incident | skipped (scan already supersedes snapshots; a diff view was cut for time) |

## Tier 2 — motion and interaction that a judge remembers

| # | Idea | Status |
|---|---|---|
| 13 | **Shockwave ripple** propagating outward through the graph when a version is marked compromised | **BUILT** |
| 14 | Hover a graph node → **highlight its full path back to the compromised root**, dim everything else | **BUILT** |
| 15 | **Animated count-up** on the attack-clock stat tiles rather than integers snapping | skipped (cut for time) |
| 16 | **Timeline scrubber ghost trail** — show where exposure was as you drag | skipped (redundant with the live as-of readout) |
| 17 | Graph nodes **pulse** while a live traversal is in flight | skipped (cut for time) |
| 18 | **Staggered row entrance** on result tables so results feel like they arrive | **BUILT** |
| 19 | **Reduced-motion support** — honour `prefers-reduced-motion` everywhere | **BUILT** |
| 20 | Edge **flow animation** along exposed dependency chains | skipped (visually noisy at 300+ nodes) |
| 21 | **Focus ring + full keyboard navigation** of tables and tabs | partial (focus rings + palette keys; tables are not arrow-navigable) |
| 22 | Blast radius **depth rings** drawn behind the graph as concentric guides | skipped (clutters an already dense canvas) |
| 23 | **Number formatting polish** — thin spaces, aligned monospace columns | **BUILT** (monospace columns, locale thousands separators) |
| 24 | **Skeleton loaders** instead of "loading…" text | partial (skeleton CSS shipped; used in the console only) |
| 25 | Toast/inline **confirmation when a version is marked** compromised | skipped (CLI confirms; no toast in the dashboard) |
| 26 | **Dark/light theme** honouring system preference | skipped (dark-only is a deliberate, coherent choice for this tool) |
| 27 | Animated **transition between tabs** | skipped (adds latency to a demo that needs to feel instant) |
| 28 | **Sparkline** of exposure over the incident window on the clock | skipped (the log already conveys it) |
| 29 | **Copy-to-clipboard** on every key, chain, and query | partial (console has copy-query; table cells do not) |
| 30 | **Sticky table headers** on long result lists | **BUILT** (sticky thead) |

## Tier 3 — functional depth

| # | Idea | Status |
|---|---|---|
| 31 | **Repo detail view** — every dependency, every snapshot, full history | skipped (repo data is reachable via the palette and the console; a dedicated view was cut for time) |
| 32 | **Package detail view** — versions, maintainers, dependents, advisories | skipped (same — cut for time) |
| 33 | **Blast radius for a whole maintainer account** ("if alice is phished, what burns?") | **BUILT** |
| 34 | **Path explain** — "why is package X in my tree at all", shortest chain from any repo | **BUILT** |
| 35 | **Watch mode** — poll OSV and alert when a new advisory hits the org | skipped (needs a long-running daemon; `ci` covers the same need in a pipeline) |
| 36 | **Advisory browser** — the 40 real OSV records, with affected repos per advisory | **BUILT** (CLI `advisories`; API endpoint; no dashboard tab) |
| 37 | **Exposure history** — how a repo's exposure changed across all its snapshots | skipped (the Time Machine timeline already shows a repo's history) |
| 38 | **Org-wide risk dashboard** — one number, trending | skipped (vanity metric; the ranked worklist is more honest) |
| 39 | **Multi-version incident** — mark a whole semver range compromised at once | skipped (cut for time) |
| 40 | **Blame view** — which lockfile commit introduced the exposure | skipped (needs real git history the synthetic org does not have) |
| 41 | Compare **two repos'** dependency trees | skipped (low judge value vs cost) |
| 42 | **Dependency confusion checker** against a private-scope list | skipped (typosquat view already covers the same finding class) |
| 43 | **Transitive-depth histogram** for the org | skipped (analytics filler) |
| 44 | **Most-dangerous-package leaderboard** (by blast radius) | **BUILT** (preflight output) |
| 45 | **Unmaintained/stale package flag** from publish recency | skipped (no reliable signal in current data) |
| 46 | **License extraction** into the graph | skipped (out of the track's scope) |
| 47 | **Export the full graph** as GraphML/DOT for external tools | **BUILT** (graph-export, DOT) |
| 48 | **PyPI end-to-end demo dataset** alongside npm | skipped (verified working; committing a second snapshot doubles repo size for little demo gain) |
| 49 | **Monorepo workspace awareness** in scan | **BUILT** (done earlier this session) |
| 50 | **Yarn Berry lockfile support** | skipped (refused explicitly with a clear message — better than a half parser) |

## Tier 4 — deeper HydraDB usage

| # | Idea | Status |
|---|---|---|
| 51 | **EXPLAIN output** surfaced for each query | skipped (EXPLAIN is shard-API only, not reachable over HTTP) |
| 52 | **Bolt-vs-HTTP benchmark** in `doctor` showing both transports agree and their latencies | **BUILT** (doctor --bolt compares both transports) |
| 53 | **Consistency demonstration** — write, then read at causal vs strong, show the epoch difference | skipped (the verified toggle demonstrates it; a dedicated panel was cut) |
| 54 | **Live metrics panel** scraped from HydraDB `/metrics` | partial (/api/engine serves it; no UI panel yet) |
| 55 | **Query timing breakdown** per panel (traversal vs pin vs render) | **BUILT** (console reports engine vs round-trip time) |
| 56 | **Path budget explorer** — slide `pathCount` and watch results truncate, live | skipped (pathCount is editable in the console, which covers it) |
| 57 | Use **`algo.SPpaths`** for the single "explain this one path" query | **BUILT** (#34) |
| 58 | **Cell/namespace awareness** for multi-tenant orgs | skipped (single-cell deployment; would be theatre) |
| 59 | **Bookmark-based read-your-writes** demonstration | skipped (strong consistency already covers the story) |
| 60 | **Weighted traversal** using `weightProp` (weight by download count) | skipped (weightProp adds a knob without changing an answer) |
| 61 | **`fairRelationshipVariants`** exploration | skipped (only valid for pairwise MSpaths, which is defective in this build) |
| 62 | **Streaming NDJSON** ingestion path | skipped (batched UNWIND already meets the requirement) |
| 63 | **Graph statistics from the engine** rather than counted client-side | skipped (counts are already one aggregate query each) |
| 64 | **Index/property-scan warnings** surfaced from server logs into `doctor` | skipped (cut for time) |
| 65 | **Concurrent query stress** in `doctor` to show it holds up | skipped (cut for time) |

## Tier 5 — production readiness

| # | Idea | Status |
|---|---|---|
| 66 | **Empty state for every view** with a next action | **BUILT** (verified across every view) |
| 67 | **Retry/backoff on the dashboard** when the API is down, with a banner | partial (errors render inline; no auto-retry banner) |
| 68 | **Graceful degradation** when HydraDB dies mid-session | **BUILT** |
| 69 | **`--json` on every CLI command** for scripting | **BUILT** (--json on every new command) |
| 70 | **Exit codes documented** per command | **BUILT** (ci: 0/1/2, all three verified) |
| 71 | **Config validation** with actionable messages at startup | **BUILT** (pre-existing) |
| 72 | **Health endpoint for the API server itself** | **BUILT** (pre-existing) |
| 73 | **Structured logging** on the API server | skipped (cut for time) |
| 74 | **Request IDs** end to end | skipped (single-user local tool) |
| 75 | **Rate limiting** on the API | skipped (localhost only) |
| 76 | **Dockerfile for the app** itself | skipped (npm install is the documented path; a second container adds setup risk to the demo) |
| 77 | **CI running the test suite** on push | **BUILT** (two workflows committed) |
| 78 | **Version pinning audit** of our own deps | skipped (lockfile committed) |
| 79 | **Graceful SIGINT** on the simulator | skipped (cut for time) |
| 80 | **Timeout tuning per query class** | **BUILT** (delete/reset use a longer timeout than reads) |

## Tier 6 — narrative and demo craft

| # | Idea | Status |
|---|---|---|
| 81 | **Guided demo mode** — a scripted walkthrough with callouts | skipped (the video script covers this; in-app tour risks feeling canned) |
| 82 | **"Why this matters" panel** quoting the real TanStack incident | skipped (README and the scenario blurb carry it; cut from the UI) |
| 83 | **Provenance footer** — data sources and counts, always visible | skipped (header already shows live graph counts) |
| 84 | **Comparison table vs Snyk/Socket/Dependabot** on what each can answer | skipped (README carries the comparison) |
| 85 | **Architecture diagram rendered in-app** | skipped (README covers it; screen space is precious) |
| 86 | **Live "queries run this session" counter** | partial (/api/engine counts them; no UI counter) |
| 87 | **Cypher shown during the attack clock** as each traversal fires | **BUILT** (attack-clock log names algo.SSpaths per measurement) |
| 88 | **Judge mode** — one keystroke tour of the three killer queries | skipped (overlaps #81) |
| 89 | **Printable one-pager** of the incident | **BUILT** (#7) |
| 90 | **Onboarding checklist** on first run | skipped (`make demo` is one command) |

## Tier 7 — considered and deliberately rejected

| # | Idea | Why not |
|---|---|---|
| 91 | AI/LLM summary of the incident | Adds a dependency and a hallucination risk to a tool whose value is exactness |
| 92 | Slack/Teams alerting | No credential exists in the repo; would be a stub |
| 93 | Email digest | Same — no SMTP credential |
| 94 | Auth/multi-user | Out of scope for a local analysis tool |
| 95 | Hosted public demo | Needs infrastructure and spends money |
| 96 | Browser extension | Wrong surface entirely |
| 97 | VS Code extension | Large build, tangential to the track |
| 98 | Mobile-responsive dashboard | Judges view on a laptop; effort better spent elsewhere |
| 99 | Real-time collaborative annotation | Feature theatre for a single-operator tool |
| 100 | Blockchain-anchored audit log | This project has no on-chain component; bolting one on would be dishonest to the pitch |
