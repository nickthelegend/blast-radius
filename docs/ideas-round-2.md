# 100 ideas — round two

Round one's list is in [`ideas.md`](ideas.md); its 35 built items are excluded
here, as is everything the "Overpressure Survey" redesign shipped. Nothing below
already exists in the repo.

Scored **impact × feasibility × fit**. Impact is "would a judge notice and
care", feasibility is "buildable for real against this graph today", fit is
"strengthens the Track 2A pitch rather than cluttering it". A feature that
scores high on impact but drags the demo sideways is ranked down, not up.

**On the blockchain clause in the brief:** this project has no on-chain
component and no funded key exists anywhere in the repo or environment. Adding
one would be a credential-blocked stub *and* would weaken a supply-chain-graph
pitch by splitting its story. Not attempted — see #99.

Status: **BUILT** (run and verified) · **skipped** (with the reason).

| # | Idea | Why it would move a judge | Status |
|---|---|---|---|
| 1 | **Exposure diff between two instants** — `blastradius diff <version> --from T1 --to T2`: which repos entered exposure, which left, which never changed | The Time Machine proves bitemporal *reads*; a diff is the question an incident commander actually asks next ("what changed since this morning?"). It is the single most obvious missing follow-up and nothing else in the category can answer it | **BUILT** |
| 2 | **SARIF 2.1.0 output** from `ci`, uploaded by the workflow to the GitHub Security tab | Turns the gate from "a script that exits 1" into a findings source GitHub renders natively. Unmistakably more than the minimum to qualify | **BUILT** |
| 3 | **Minimal global fix set** — the smallest set of dependency changes that clears *every* exposed repo, solved as a set cover over the graph | Remediation today answers per-repo. A platform team wants the one PR that fixes eleven services. Same data, far better answer | **BUILT** |
| 4 | **Query-plan surfacing** — read HydraDB's optimizer warnings and show when a query fell back to a full scan | Nobody else will show the engine's own plan telemetry. It is the deepest possible "we actually used the sponsor tech" signal | **BUILT** |
| 5 | **API concurrency cap + stats cache with epoch invalidation** | `/api/stats` is a full edge scan across four edge types; parallel dashboard loads saturate the engine. A demo that browns out under a judge clicking fast is a lost demo | **BUILT** |
| 6 | **Exposure-over-time series** — exposed-repo count at every lockfile capture instant, drawn on the survey timeline | Turns the bitemporal claim into a line you can point at. One image that a static scanner provably cannot produce | **BUILT** |
| 7 | **Click a range ring to filter to that hop count** | The rings are already a real distance scale; making them a control makes the plot an instrument rather than a picture | **BUILT** |
| 8 | **Graph pan and zoom** with a reset control | Six thousand paths on one canvas needs it. Its absence reads as unfinished the moment a judge tries | **BUILT** |
| 9 | **PR comment formatter** — `ci --format markdown` posting the gate result as a PR comment | Closes the loop on the CI story; the output lands where a developer would actually see it | **BUILT** |
| 10 | **Print stylesheet** — the dashboard prints as an actual survey sheet | Dead on-world, genuinely useful for an incident write-up, and the kind of detail nobody else will have | **BUILT** |
| 11 | **`--since` on `ci`** — gate only on exposure that appeared since a given instant | Makes the gate usable on a repo that is already exposed: fail on regressions, not on the backlog | **BUILT** |
| 12 | **Sticky focus** — click a repo row to lock its chain highlighted, not just hover | Hover state vanishes the moment you move to point at the screen. In a live demo that is the difference between explaining a chain and losing it | **BUILT** |
| 13 | **Exposure badge counts on the sheet index** | The tab bar becomes a status board; a judge sees "5 exposed" before clicking anything | **BUILT** |
| 14 | **Unknown-version guidance** — a bad version key returns near-matches from the graph instead of an empty report | The single most likely thing a judge types wrong. Recovering gracefully is a production signal | **BUILT** |
| 15 | **Structured JSON logging** on the API with query ids, elapsed, and consistency | Makes the server legible when something goes wrong on stage | **BUILT** |
| 16 | **Depth distribution histogram** — how many repos sit at each hop count | One glance answers "is this a shallow or a deep compromise", which changes the response | skipped (the range-ring labels already carry per-hop counts; a second chart of the same numbers is clutter) |
| 17 | **CODEOWNERS-derived notify list** — who to page per exposed repo | The obvious next step after "which repos" | skipped (the demo org is synthetic and has no CODEOWNERS; inventing owners would be fabricated data) |
| 18 | **Watch a package** — persist a watch, report when its exposure set changes | Turns a one-shot tool into a service | skipped (needs a scheduler and a notification sink; neither exists and both are out of scope for a 3-minute demo) |
| 19 | **Compare two versions' blast radius side by side** | Useful for "is 4.4.4 safer than 4.4.3" | skipped (redundant with #1's diff once that exists, and a second comparison UI splits the story) |
| 20 | **Bolt transport in the product path**, not just `doctor` | Proves both protocols work | skipped (the HTTP client handles cursor pagination the Bolt driver would need reimplemented; real work, no visible payoff) |
| 21 | **Guided demo mode** — a scripted walkthrough that drives the dashboard | Removes presenter error | skipped (the attack clock already is the scripted moment; a second auto-driver competes with it) |
| 22 | **Incremental/streaming traversal** for very large radii | Handles a radius bigger than memory | skipped (the current radius is 6k paths and returns in under a second; solving a problem this dataset does not have) |
| 23 | **`--without-resolved-direct` flag** demonstrating why the second edge type exists | Shows the modelling decision was earned | skipped (already argued with evidence in README and `docs/hydradb-findings.md`; a flag that produces deliberately wrong output invites a judge to quote the wrong number) |
| 24 | **Advisory severity heat on the graph** — node colour by CVSS | More colour on the plot | skipped (violates the design system: four load-bearing state colours, and severity is not one of them) |
| 25 | **Package detail sheet** — every fact about one version on one page | A natural drill-down | skipped (the palette plus the console already reach any node's facts; a new view for the same data) |
| 26 | **Saved queries** in the console | Convenience | skipped (seven presets already ship; saving is a persistence feature with no demo moment) |
| 27 | **Query history** in the console | Convenience | skipped (same) |
| 28 | **Multi-org support** | Scales the model | skipped (one synthetic org is the demo; multi-tenancy is invisible in three minutes) |
| 29 | **PyPI ingestion** alongside npm | Broadens the claim | skipped (the parser exists for author fields but a full PyPI resolution model is a day's work and the pitch is already coherent on npm) |
| 30 | **Go module ingestion** | Same | skipped (same, more so) |
| 31 | **Real-time npm registry tail** — new publishes streamed into the graph | Live data is compelling | skipped (npm has no public firehose; polling would be a fake stream) |
| 32 | **Diff two SBOMs** and report what entered the tree | Interop | skipped (SBOM import was already declined in round one for the same reason: resolving arbitrary purls is a scan, not an import) |
| 33 | **Attack-clock replay scrubber** after the run finishes | Lets a judge re-watch a moment | **BUILT** |
| 34 | **Keyboard shortcuts for every view** (1–7) | Speed | **BUILT** |
| 35 | **`?` shortcut sheet** overlay | Discoverability | **BUILT** |
| 36 | **Copy-as-Markdown** on any result table | Gets a finding into Slack in one action | **BUILT** |
| 37 | **Permalink to a specific exposed repo's chain** | Shareable evidence | **BUILT** |
| 38 | **Error boundary** per view so one failing panel cannot blank the app | Production signal | **BUILT** |
| 39 | **Retry-with-backoff banner** when the API is unreachable, with a live countdown | The demo survives a DB restart on stage | **BUILT** |
| 40 | **Request coalescing** — identical in-flight queries share one engine round trip | Directly fixes what saturated the engine | **BUILT** |
| 41 | **Slow-query warning in the UI** when a traversal exceeds a threshold | Honest about latency | **BUILT** |
| 42 | **Graph node drag** to untangle a cluster | Expected of any force graph | skipped (fights the radial layout, whose whole point is that position encodes depth — dragging a node off its ring makes the plot lie) |
| 43 | **Minimap** on the graph | Orientation | skipped (pan/zoom with reset covers it at this node count) |
| 44 | **Search-within-graph** highlighting matching nodes | Findability | skipped (⌘K already selects a version and the plot re-centres on it) |
| 45 | **Time-lapse of the graph across snapshots** | Beautiful | skipped (the attack clock already animates spread; a second animated graph competes for the same demo minute) |
| 46 | **Sound on the attack clock** | Memorable | skipped (audio in a judged demo room is a liability, and it is decoration rather than information) |
| 47 | **Dark/light theme toggle** | Expected | skipped (the world is a backlit drafting table; a light mode would be a different world, not a variant) |
| 48 | **Density toggle** (comfortable/compact) | Preference | skipped (the sheet is already at survey density by design) |
| 49 | **i18n scaffolding** | Production signal | skipped (no second locale exists to prove it; scaffolding alone is ceremony) |
| 50 | **Onboarding tour** for first-time users | Activation | skipped (every view already carries its own explanatory annotation, which is the same job done in place) |
| 51 | **Per-repo exposure history sparkline** | Compact history | skipped (sparklines standing in for content are an explicit anti-pattern in the design system) |
| 52 | **Confidence interval on truncated traversals** | Honesty | skipped (already handled: a truncation is stated outright rather than estimated around) |
| 53 | **Cache warming on startup** | Faster first paint | **BUILT** (folded into #5) |
| 54 | **`/metrics` passthrough panel** in the UI | Engine visibility | skipped (round one left this partial for a reason: a raw Prometheus dump is not a designed surface, and #4 delivers the engine insight that matters) |
| 55 | **Query cost estimate** before running in the console | Prevents a runaway | skipped (the engine's 60s runtime limit already bounds it, and the console is read-only) |
| 56 | **Explain plan button** in the console | Deep engine | **BUILT** (folded into #4) |
| 57 | **Cancel a running query** from the console | Control | skipped (queries return in under a second; a cancel button for a 600ms operation is noise) |
| 58 | **Export console results as CSV** | Interop | **BUILT** |
| 59 | **Virtualised tables** for very long result lists | Performance | skipped (tables cap at 200 rows and scroll fine; virtualisation would add a dependency for no measured gain) |
| 60 | **Web worker for the force simulation** | Smoothness | skipped (measured: the simulation cools in well under a second at this node count) |
| 61 | **Offline mode** with a service worker | Resilience | skipped (the fonts and bundle are already local; the graph cannot be offline and that is the product) |
| 62 | **Docker image for the whole app** | One-command demo | skipped (`make demo` is already one command and the compose file is the documented path) |
| 63 | **Helm chart** | Production signal | skipped (no cluster to prove it against; unverifiable) |
| 64 | **Terraform module** | Same | skipped (same) |
| 65 | **OpenAPI spec** for the API | Interop | skipped (the API is the dashboard's private backend, not a published product surface) |
| 66 | **Rate limiting per IP** | Hardening | skipped (single-user local tool; the concurrency cap in #5 is the limit that actually matters) |
| 67 | **Auth on the dashboard** | Hardening | skipped (binds to 127.0.0.1 and is read-only; auth would add a login screen to a demo for no threat) |
| 68 | **Audit log of every marked compromise** | Traceability | skipped (the graph already records `marked_at` on the version; a second log duplicates it) |
| 69 | **Undo a mark-compromised** | Recovery | skipped (`clear-compromised` already exists) |
| 70 | **Bulk mark from an advisory** — mark every version an OSV record affects | Realistic workflow | **BUILT** |
| 71 | **Ecosystem filter** on typosquats | Refinement | skipped (npm is the only ecosystem loaded; a filter with one option) |
| 72 | **Typosquat allowlist** persisted to the graph | Reduces noise | skipped (a real need for a real deployment, invisible in a demo) |
| 73 | **Maintainer 2FA status** from the registry | Genuine risk signal | skipped (npm's public API does not expose per-account 2FA state; this would be fabricated) |
| 74 | **Package download-trend anomaly detection** | Novel signal | skipped (needs a time series npm does not serve publicly at this granularity) |
| 75 | **Install-script detection** — flag packages with postinstall hooks | Real attack vector | **BUILT** |
| 76 | **Dependency-confusion check** — internal names that exist publicly | Real attack vector | skipped (the synthetic org's package names are not real internal names, so every result would be an artefact of the fixture) |
| 77 | **License compliance view** | Adjacent value | skipped (a different product wearing this one's clothes) |
| 78 | **Bundle-size impact per dependency** | Adjacent value | skipped (same) |
| 79 | **Dependency freshness / staleness scoring** | Adjacent value | skipped (same) |
| 80 | **Blast radius as a GitHub Check Run** with annotations | Deep integration | skipped (needs a GitHub App id and private key; no such credential exists in the repo or environment — genuinely blocked) |
| 81 | **Slack notification on gate failure** | Closes the loop | skipped (no webhook URL exists anywhere; genuinely blocked) |
| 82 | **PagerDuty integration** | Same | skipped (same) |
| 83 | **Jira ticket creation** from a finding | Same | skipped (same) |
| 84 | **Email digest** | Same | skipped (no SMTP credential) |
| 85 | **VS Code extension** showing exposure inline | Memorable surface | skipped (a second product's worth of work) |
| 86 | **Browser extension** for npmjs.com pages | Memorable surface | skipped (same) |
| 87 | **Public hosted demo** | Judges can try it | skipped (needs a host with Docker and an object store; deploying would spend real money) |
| 88 | **Recorded terminal cast** (asciinema) in the README | Proof without a video | skipped (the demo video is the deliverable and I cannot record either) |
| 89 | **Architecture diagram** in the README | Comprehension | **BUILT** |
| 90 | **Query cookbook** — every Cypher the product runs, documented | Judge-facing proof | **BUILT** |
| 91 | **Benchmark page** — traversal latency vs radius size | Engine credibility | skipped (would need many graph sizes to be honest; a single-point "benchmark" is marketing) |
| 92 | **Comparison table vs Snyk/Socket/OSV-Scanner** | Positioning | skipped (I cannot verify competitors' current behaviour, and an unverified comparison table is a fabricated claim) |
| 93 | **Threat model document** | Seriousness | skipped (thorough but nobody reads it in judging) |
| 94 | **Fuzz tests on the lockfile parsers** | Robustness | **BUILT** |
| 95 | **Property tests on semver resolution** | Robustness | skipped (the resolver delegates to `semver`; testing someone else's library) |
| 96 | **Mutation testing** | Test quality | skipped (long runtime, no demo value) |
| 97 | **Load test of the API** | Capacity | skipped (#5's cap is the fix; a load test number nobody will read) |
| 98 | **Chaos test** — kill the DB mid-traversal | Resilience | **BUILT** |
| 99 | **On-chain notarisation of incident reports** | The brief's blockchain clause | skipped (no funded key or network access exists; it would also split a supply-chain-graph pitch across two stories and weaken both) |
| 100 | **Screensaver mode** — the attack clock looping on the booth screen | Draws people over | skipped (charming, but it competes with the live demo for the same screen and adds a mode to maintain) |

**Totals: 30 built and verified · 70 skipped, each with a stated reason.**
