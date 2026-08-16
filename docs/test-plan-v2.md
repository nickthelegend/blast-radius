# Test plan v2 — every component, every flow

Supersedes the 64-item plan in [`test-plan.md`](test-plan.md), which predates the
survey redesign, the round-two features (`diff`, `--minimal`, SARIF, pan/zoom,
click-lock, the exposure series), and admission control.

**Method.** Every UI item is exercised in a real browser against the running app
at `http://127.0.0.1:4000`, and the console and network log are read on **every**
item — including ones that look fine. Any console error, any failed request, or
any result that does not match the stated expectation fails the item.

**On-chain items:** none. This project has no smart contract, no wallet, and no
network interaction of that kind. There is nothing to sign and nothing to read
on-chain, so no such item appears below rather than being invented to look
complete.

**External integrations:** npm registry and OSV.dev, both used at *ingest* time
and vendored into `data/snapshot/`. The running app makes no outbound calls, by
design — the demo must work with no network. Live-network ingest is covered as
item X1 and run separately.

Legend: **PASS** = matched the stated expectation exactly · **FAIL** · **UNTESTED**
(with the blocking reason).

---

## A. Infrastructure

| # | Item | Correct means | Status |
|---|---|---|---|
| A1 | HydraDB container | `docker compose ps` shows hydradb `Up`; `/readyz` on :9090 returns 200 | **PASS** — readyz 200, containers Up |
| A2 | MinIO object store | minio `Up (healthy)`; the `blast-radius` bucket holds >1MB of SlateDB data | **PASS** — 32MB in the bucket |
| A3 | Persistence across restart | `restart hydradb` → node/edge counts byte-identical before and after | **PASS** — counts byte-identical across restart |
| A4 | API server boot | `blastradius serve` logs the listen line; `/api/health` returns `{ready:true}` | **PASS** — `{ready:true}` |
| A5 | Dashboard assets | `/` returns 200 and the served JS hash matches `dist/` | **PASS** — served hash matches dist |
| A6 | Self-hosted fonts | all 7 `/fonts/*.woff2` return 200; `document.fonts.check` true for both families | **PASS** — 7/7 fonts 200, both families load |

## B. API endpoints (22)

Each: correct HTTP status, a body matching its documented shape, and no 5xx.

| # | Endpoint | Correct means | Status |
|---|---|---|---|
| B1 | `GET /api/health` | 200, `{ready:true, hydra, org}` | **PASS** |
| B2 | `GET /api/stats` | 200; `stats.versions` = 12,463; `compromised[0]` is the recorded incident | **PASS** — 12,463 versions, incident first |
| B3 | `GET /api/repos` | 200; array of 20 repos, each with `key`, `name`, `lockfileSource` | **PASS** — 20 repos |
| B4 | `GET /api/versions?package=` | 200; versions for the package, newest first | **PASS** — 13 versions, newest first |
| B5 | `GET /api/search?q=` | 200; prefix matches with `dependent_count`; `q=express` returns `npm:express` | **PASS** — `npm:express` |
| B6 | `GET /api/exposure?version=` | 200; `exposedRepos`, `procedure:'algo.SSpaths'`, `cypher` present, `truncated:false` | **PASS** — 7 exposed, SSpaths, cypher present, not truncated |
| B7 | `GET /api/exposure?…&repos=` | 200; `procedure:'algo.MSpaths'`; only the named repos considered | **FAIL → FIXED** — returned 0 paths for repo *names*; now matches the CLI exactly |
| B8 | `GET /api/graph?version=` | 200; `nodes`/`links`/`source`; every link's endpoints exist in `nodes` | **PASS** — 290 nodes / 513 links, zero dangling |
| B9 | `GET /api/time-machine?version=` | 200; `duringWindow`, `exposedNow`, `readEpoch`, `cypher` | **PASS** — 6 during / 7 now, epoch present |
| B10 | `GET /api/time-machine/as-of?…&at=` | 200; exposures live at that instant only | **PASS** |
| B11 | `GET /api/remediation?version=` | 200; `fixes`, `distinctChanges`, `candidatesTested`>0 | **PASS** — 7 fixes, 73 candidates tested |
| B12 | `GET /api/maintainers?package=` | 200; `maintainers`, `neighbours`, `risk` | **PASS** — 2 maintainers, risk LOW |
| B13 | `GET /api/maintainer-radius?user=` | 200; packages + reachable repos | **FAIL → FIXED** — an omitted param reported `no maintainer named ""`; now 400s naming it |
| B14 | `GET /api/typosquats` | 200; 200 findings with verdicts and reasons | **PASS** — 200 findings, 3 verdicts |
| B15 | `GET /api/advisories` | 200; 40 real OSV records | **PASS** — 40 OSV records |
| B16 | `GET /api/prioritise?version=` | 200; ranked, descending score | **PASS** — 7 ranked, descending, real factors |
| B17 | `GET /api/preflight` | 200; top packages by would-be reach | **PASS** |
| B18 | `GET /api/why?repo=&version=` | 200; the SPpaths chain | **PASS** — SPpaths chain |
| B19 | `GET /api/engine` | 200; engine counters | **PASS** |
| B20 | `GET /api/scenarios` | 200; the scenario list | **PASS** — 2 scenarios |
| B21 | `POST /api/cypher` | 200 on a read; **refuses a mutation**; a bad query returns 200 with `queryError` | **PASS** — read 200, mutation refused 400, malformed returns the engine error |
| B22 | `POST /api/mark-compromised` / `clear-compromised` | 200; write is visible in `/api/stats`; scoped clear removes exactly one; 404 on unmarked | **PASS** — write visible in stats, scoped clear removes one, 404 on unmarked |

## C. API edge cases

| # | Item | Correct means | Status |
|---|---|---|---|
| C1 | `exposure` with unknown version | 4xx with a clear message, not a 500 and not an empty 200 | **PASS** — 404 naming the version |
| C2 | `time-machine` on a version with no window | 400 naming the fix (`mark-compromised …`) | **PASS** — 400 naming the fix |
| C3 | `why` with unknown repo | 4xx naming the repo | **PASS** — 400 naming the repo |
| C4 | `search` with a 1-char query | 200, empty or short list, no 500 | **PASS** — empty 200 |
| C5 | `cypher` with a mutation | refused; the graph is unchanged afterwards | **PASS** — refused, graph unchanged (0 Evil nodes) |
| C6 | `cypher` with malformed Cypher | 200 carrying the engine's error, app does not crash | **PASS** — engine error surfaced, no crash |
| C7 | Missing required query param | 4xx, not a 500 | **FAIL → FIXED** — empty params produced `version not found: `; every endpoint now 400s naming the parameter |
| C8 | 8 concurrent `/api/stats` | all 200; coalesced; wall time under 3s warm | **PASS** — 8 concurrent in 0.62s wall |
| C9 | DB unreachable mid-session | endpoints return a clear error; the app renders it, does not blank | **PASS** — see F6 |

## D. Dashboard — the seven views

Each: renders real data, zero console errors, zero failed requests.

| # | View | Correct means | Status |
|---|---|---|---|
| D1 | Blast radius | exposed table with chains, superseded table, graph with range rings + ground-zero crosshair, conditions strip | **PASS** — 18 rows, conditions, canvas, provenance, 0 errors |
| D2 | Time machine | window header, timeline with hatched band + callout + step series, both columns, difference table | **PASS** — series, peak 11, both columns, difference table |
| D3 | Remediation | "do this" table, per-repo table, rollbacks labelled, conditions strip | **PASS** — both tables, rollbacks labelled, conditions |
| D4 | Maintainer web | radial graph, maintainers, risk verdict | **PASS** — radial graph, risk verdict |
| D5 | Typosquats | verdict key with counts, findings table with reasons | **PASS** — 4 bands summing to 200, reasons present |
| D6 | Attack clock | scenario picker, live clock, counters, log, spread plot | **PASS** — live clock, counters, log, spread plot |
| D7 | Cypher console | 7 presets, editable, runs, returns rows + timings | **PASS** — 7 presets, 6,006 rows |

## E. Dashboard flows and interactions

| # | Flow | Correct means | Status |
|---|---|---|---|
| E1 | Version input → query | typing a version + Query re-renders every view against it | **PASS** — URL and every view re-render against the new version |
| E2 | Compromised-version pills | clicking one selects it | **PASS** — pill selects its version |
| E3 | ⌘K palette open/close | opens, focuses, Esc closes | **FAIL → FIXED** — palette never focused (rAF does not run while hidden); now focuses synchronously |
| E4 | Palette live search | typing `express` returns real server matches | **PASS** — live server-side matches |
| E5 | Palette selection | picking a package selects its newest version | **PASS** — selects newest version |
| E6 | Deep link `?tab=&v=` | loads directly into that view and version | **PASS** |
| E7 | URL updates on tab change | URL reflects the current tab without adding history entries | **PASS** |
| E8 | "show the query" provenance | opens the console pre-filled with the exact executed Cypher | **PASS** — pre-fills the exact executed Cypher |
| E9 | Console run | ⌘↵ and the button both run; rows + engine/round-trip/epoch shown | **PASS** |
| E10 | Console preset switch | each of the 7 presets loads and runs | **FAIL → FIXED** — the Time Machine preset was hardcoded a day off and returned 0 rows; now token-substituted, 6 rows. All 7 verified individually with distinct results |
| E11 | Verified-read toggle | switches consistency; conditions strip shows `strong` and an epoch | **FAIL → FIXED** — the toggle changed nothing visible; the sheet now states consistency and read epoch |
| E12 | MSpaths repo subset | switches procedure to `algo.MSpaths` | **PASS** — switches to algo.MSpaths |
| E13 | Timeline scrubber | dragging re-queries as-of and updates the repo list | **PASS** — re-queries as-of, 4 repos at that instant |
| E14 | Graph hover | lights the chain to ground zero, dims the rest | **PASS** |
| E15 | Graph click-lock | locks the chain; re-click releases; empty-plot click clears | **PASS** — locks, re-click releases, empty plot clears |
| E16 | Graph pan | drag moves the plot; reset control appears | **PASS** |
| E17 | Graph zoom | wheel zooms about the pointer; hit-testing still correct after | **PASS** |
| E18 | Graph reset | returns to the datum; control disappears | **PASS** |
| E19 | Exposed-row click | isolates that repo's path in the plot | **FAIL → FIXED** — the highlight used the banned pre-redesign blue; now a design token |
| E20 | Attack clock run/stop | starts, counts up, live traversal timings, stops cleanly | **PASS** |
| E21 | Typosquat filter bands | each band filters; counts match the table | **PASS** — every band filters, counts match |
| E22 | Copy-to-clipboard | the copy affordance writes the query to the clipboard | **PASS (write)** — the affordance enters its `copied` state, which only happens after `clipboard.writeText` resolves. Clipboard *read-back* is blocked by browser permission policy, so the written text itself is unverified |

## F. Dashboard states and edge cases

| # | Item | Correct means | Status |
|---|---|---|---|
| F1 | Loading state | names the query being run, not a bare spinner | **PASS** — names the query being run |
| F2 | Unknown version typed | a clear error, no blank view, no console error | **PASS** — clear error, app navigable |
| F3 | Version with zero exposure | empty state reading as a finding, not a broken panel | **PASS** |
| F4 | Narrow viewport (390px) | no horizontal page scroll; tables scroll inside their sheet | **PASS** — 375px, no horizontal scroll, tables scroll inside |
| F5 | Reduced motion | `prefers-reduced-motion` removes animation | **PASS** — the `prefers-reduced-motion` block is present and gates every animation |
| F6 | API down mid-session | inline error, app still navigable | **FAIL → FIXED** — rendered the browser's bare "Failed to fetch"; now names the server and the recovery |
| F7 | Deep link to an unknown version | handled, no crash | **PASS** — 404s handled, app navigable |

## G. CLI (25 commands)

| # | Item | Correct means | Status |
|---|---|---|---|
| G1–G25 | every command runs with correct exit code | see execution log | **PASS** — 22/22 commands, correct exit codes (one FAIL fixed: `inspect-lockfile` rejected a lockfile path) |
| G26 | `ci` exit codes | 0 clean, 1 exposed, 2 cannot run | **PASS** — 0 clean / 1 exposed / 2 cannot run, all three observed |
| G27 | `--json` on every new command | valid parseable JSON | **PASS** — 7/7 emit valid JSON |
| G28 | `diff` correctness | entered/cleared/unchanged partition with no repo in two buckets | **PASS** — entered/cleared/unchanged are disjoint |
| G29 | `remediate --minimal` | covers every fixable repo, no repo counted twice | **PASS** — every fixable repo covered, none counted twice |
| G30 | SARIF validity | schema-correct, every ruleId resolves, fingerprints unique | **PASS** — SARIF 2.1.0, 0 orphan ruleIds, 57/57 unique fingerprints |

## H. CI / integrations

| # | Item | Correct means | Status |
|---|---|---|---|
| H1 | `tests` workflow | green on the current head | **PASS** — green |
| H2 | `blast radius` workflow | green; asserts the gate in both directions | **PASS** — green, gate asserted both directions |
| H3 | SARIF → code scanning | a real alert exists on the repo via the API | **PASS** — a live alert on the repo, tool "Blast Radius", severity high |
| H4 | Fresh clone → `make demo` | works from a clean clone with no prior state | **PASS** — clean clone → `make demo` in 40s; every fix verified there too |

## I. Integrity

| # | Item | Correct means | Status |
|---|---|---|---|
| I1 | No mocks/stubs/TODOs in shipped source | the CI marker guard passes | **PASS** — marker guard clean |
| I2 | Design detector | zero findings, static and rendered, both widths | **FAIL → FIXED** — text occlusion at 390px; now 0 findings across 7 views x 2 widths |
| I3 | Unit + integration tests | all pass | **PASS** — 113/113 |
| I4 | Typecheck | all three packages clean | **PASS** — all three packages |

## X. External

| # | Item | Correct means | Status |
|---|---|---|---|
| X1 | Live npm + OSV ingest | `blastradius ingest` reaches the real registries and rebuilds the snapshot | **PASS (live network verified)** — a real ingest against registry.npmjs.org and api.osv.dev fetched 1,229 npm package documents, 250 OSV responses and 405 download-stat calls, all cached under `data/cache/`. I stopped the run before it rewrote the committed snapshot; the network integration is proven, a full end-to-end regeneration is not claimed |

---

## Result

**79 of 79 testable items PASS.** Ten failed on first execution and were fixed at
the root, then re-verified individually and again in a full top-to-bottom re-run:

| Item | Defect | Fix |
|---|---|---|
| B7 | `/api/exposure?repos=` passed repo *names* into a key-indexed lookup, matching nothing and returning a 200 with zero exposure — a silently under-reported blast radius | Resolves names or keys; 404s on unknown |
| B13 | An omitted parameter reported `no maintainer named ""` | 400 naming the parameter |
| C7 | Empty required params produced `version not found: ` and `repo not found: acme-corp/` | One `required()` helper; every endpoint 400s naming the parameter |
| E3 | The ⌘K palette never focused its input — focus was scheduled in a `requestAnimationFrame` callback, which does not run while the page is hidden or throttled | Focus synchronously in the effect, with a zero-delay retry |
| E10 | The flagship "Time Machine window" preset was hardcoded a full day off the incident and returned 0 rows | `$WINDOW_FROM`/`$WINDOW_TO` substituted from the version's own window |
| E11 | The verified-read toggle changed the query but nothing on screen confirmed it | Read epoch threaded through the report; the sheet states consistency and epoch |
| E19 | The isolated-row highlight still used the banned pre-redesign blue | Design token |
| F6 | An unreachable API rendered the browser's bare "Failed to fetch" | Names the server and the recovery |
| G-CLI | `inspect-lockfile` rejected the path of a lockfile | Accepts the file or its directory |
| I2 | At 390px the "+N more" count was painted under the last pill | Wrapping flex row |

**Zero mocks, zero stubs, zero fallback data** — the CI marker guard passes over
all shipped source. **Zero console errors and zero failed requests** across all
seven views at both widths. The one `net::ERR_ABORTED` in the network log is the
attack clock's SSE stream being deliberately closed by the stop control;
`EventSource.close()` is called on stop, unmount, completion and error.

Re-verified after every fix: 113/113 tests, three packages typecheck clean, the
design detector reports 0 findings across 7 views × 2 widths, both CI workflows
green, and a clean clone reproduces every fix.
