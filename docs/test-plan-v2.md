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
| A1 | HydraDB container | `docker compose ps` shows hydradb `Up`; `/readyz` on :9090 returns 200 | |
| A2 | MinIO object store | minio `Up (healthy)`; the `blast-radius` bucket holds >1MB of SlateDB data | |
| A3 | Persistence across restart | `restart hydradb` → node/edge counts byte-identical before and after | |
| A4 | API server boot | `blastradius serve` logs the listen line; `/api/health` returns `{ready:true}` | |
| A5 | Dashboard assets | `/` returns 200 and the served JS hash matches `dist/` | |
| A6 | Self-hosted fonts | all 7 `/fonts/*.woff2` return 200; `document.fonts.check` true for both families | |

## B. API endpoints (22)

Each: correct HTTP status, a body matching its documented shape, and no 5xx.

| # | Endpoint | Correct means | Status |
|---|---|---|---|
| B1 | `GET /api/health` | 200, `{ready:true, hydra, org}` | |
| B2 | `GET /api/stats` | 200; `stats.versions` = 12,463; `compromised[0]` is the recorded incident | |
| B3 | `GET /api/repos` | 200; array of 20 repos, each with `key`, `name`, `lockfileSource` | |
| B4 | `GET /api/versions?package=` | 200; versions for the package, newest first | |
| B5 | `GET /api/search?q=` | 200; prefix matches with `dependent_count`; `q=express` returns `npm:express` | |
| B6 | `GET /api/exposure?version=` | 200; `exposedRepos`, `procedure:'algo.SSpaths'`, `cypher` present, `truncated:false` | |
| B7 | `GET /api/exposure?…&repos=` | 200; `procedure:'algo.MSpaths'`; only the named repos considered | |
| B8 | `GET /api/graph?version=` | 200; `nodes`/`links`/`source`; every link's endpoints exist in `nodes` | |
| B9 | `GET /api/time-machine?version=` | 200; `duringWindow`, `exposedNow`, `readEpoch`, `cypher` | |
| B10 | `GET /api/time-machine/as-of?…&at=` | 200; exposures live at that instant only | |
| B11 | `GET /api/remediation?version=` | 200; `fixes`, `distinctChanges`, `candidatesTested`>0 | |
| B12 | `GET /api/maintainers?package=` | 200; `maintainers`, `neighbours`, `risk` | |
| B13 | `GET /api/maintainer-radius?user=` | 200; packages + reachable repos | |
| B14 | `GET /api/typosquats` | 200; 200 findings with verdicts and reasons | |
| B15 | `GET /api/advisories` | 200; 40 real OSV records | |
| B16 | `GET /api/prioritise?version=` | 200; ranked, descending score | |
| B17 | `GET /api/preflight` | 200; top packages by would-be reach | |
| B18 | `GET /api/why?repo=&version=` | 200; the SPpaths chain | |
| B19 | `GET /api/engine` | 200; engine counters | |
| B20 | `GET /api/scenarios` | 200; the scenario list | |
| B21 | `POST /api/cypher` | 200 on a read; **refuses a mutation**; a bad query returns 200 with `queryError` | |
| B22 | `POST /api/mark-compromised` / `clear-compromised` | 200; write is visible in `/api/stats`; scoped clear removes exactly one; 404 on unmarked | |

## C. API edge cases

| # | Item | Correct means | Status |
|---|---|---|---|
| C1 | `exposure` with unknown version | 4xx with a clear message, not a 500 and not an empty 200 | |
| C2 | `time-machine` on a version with no window | 400 naming the fix (`mark-compromised …`) | |
| C3 | `why` with unknown repo | 4xx naming the repo | |
| C4 | `search` with a 1-char query | 200, empty or short list, no 500 | |
| C5 | `cypher` with a mutation | refused; the graph is unchanged afterwards | |
| C6 | `cypher` with malformed Cypher | 200 carrying the engine's error, app does not crash | |
| C7 | Missing required query param | 4xx, not a 500 | |
| C8 | 8 concurrent `/api/stats` | all 200; coalesced; wall time under 3s warm | |
| C9 | DB unreachable mid-session | endpoints return a clear error; the app renders it, does not blank | |

## D. Dashboard — the seven views

Each: renders real data, zero console errors, zero failed requests.

| # | View | Correct means | Status |
|---|---|---|---|
| D1 | Blast radius | exposed table with chains, superseded table, graph with range rings + ground-zero crosshair, conditions strip | |
| D2 | Time machine | window header, timeline with hatched band + callout + step series, both columns, difference table | |
| D3 | Remediation | "do this" table, per-repo table, rollbacks labelled, conditions strip | |
| D4 | Maintainer web | radial graph, maintainers, risk verdict | |
| D5 | Typosquats | verdict key with counts, findings table with reasons | |
| D6 | Attack clock | scenario picker, live clock, counters, log, spread plot | |
| D7 | Cypher console | 7 presets, editable, runs, returns rows + timings | |

## E. Dashboard flows and interactions

| # | Flow | Correct means | Status |
|---|---|---|---|
| E1 | Version input → query | typing a version + Query re-renders every view against it | |
| E2 | Compromised-version pills | clicking one selects it | |
| E3 | ⌘K palette open/close | opens, focuses, Esc closes | |
| E4 | Palette live search | typing `express` returns real server matches | |
| E5 | Palette selection | picking a package selects its newest version | |
| E6 | Deep link `?tab=&v=` | loads directly into that view and version | |
| E7 | URL updates on tab change | URL reflects the current tab without adding history entries | |
| E8 | "show the query" provenance | opens the console pre-filled with the exact executed Cypher | |
| E9 | Console run | ⌘↵ and the button both run; rows + engine/round-trip/epoch shown | |
| E10 | Console preset switch | each of the 7 presets loads and runs | |
| E11 | Verified-read toggle | switches consistency; conditions strip shows `strong` and an epoch | |
| E12 | MSpaths repo subset | switches procedure to `algo.MSpaths` | |
| E13 | Timeline scrubber | dragging re-queries as-of and updates the repo list | |
| E14 | Graph hover | lights the chain to ground zero, dims the rest | |
| E15 | Graph click-lock | locks the chain; re-click releases; empty-plot click clears | |
| E16 | Graph pan | drag moves the plot; reset control appears | |
| E17 | Graph zoom | wheel zooms about the pointer; hit-testing still correct after | |
| E18 | Graph reset | returns to the datum; control disappears | |
| E19 | Exposed-row click | isolates that repo's path in the plot | |
| E20 | Attack clock run/stop | starts, counts up, live traversal timings, stops cleanly | |
| E21 | Typosquat filter bands | each band filters; counts match the table | |
| E22 | Copy-to-clipboard | the copy affordance writes the query to the clipboard | |

## F. Dashboard states and edge cases

| # | Item | Correct means | Status |
|---|---|---|---|
| F1 | Loading state | names the query being run, not a bare spinner | |
| F2 | Unknown version typed | a clear error, no blank view, no console error | |
| F3 | Version with zero exposure | empty state reading as a finding, not a broken panel | |
| F4 | Narrow viewport (390px) | no horizontal page scroll; tables scroll inside their sheet | |
| F5 | Reduced motion | `prefers-reduced-motion` removes animation | |
| F6 | API down mid-session | inline error, app still navigable | |
| F7 | Deep link to an unknown version | handled, no crash | |

## G. CLI (25 commands)

| # | Item | Correct means | Status |
|---|---|---|---|
| G1–G25 | every command runs with correct exit code | see execution log | |
| G26 | `ci` exit codes | 0 clean, 1 exposed, 2 cannot run | |
| G27 | `--json` on every new command | valid parseable JSON | |
| G28 | `diff` correctness | entered/cleared/unchanged partition with no repo in two buckets | |
| G29 | `remediate --minimal` | covers every fixable repo, no repo counted twice | |
| G30 | SARIF validity | schema-correct, every ruleId resolves, fingerprints unique | |

## H. CI / integrations

| # | Item | Correct means | Status |
|---|---|---|---|
| H1 | `tests` workflow | green on the current head | |
| H2 | `blast radius` workflow | green; asserts the gate in both directions | |
| H3 | SARIF → code scanning | a real alert exists on the repo via the API | |
| H4 | Fresh clone → `make demo` | works from a clean clone with no prior state | |

## I. Integrity

| # | Item | Correct means | Status |
|---|---|---|---|
| I1 | No mocks/stubs/TODOs in shipped source | the CI marker guard passes | |
| I2 | Design detector | zero findings, static and rendered, both widths | |
| I3 | Unit + integration tests | all pass | |
| I4 | Typecheck | all three packages clean | |

## X. External

| # | Item | Correct means | Status |
|---|---|---|---|
| X1 | Live npm + OSV ingest | `blastradius ingest` reaches the real registries and rebuilds the snapshot | |
