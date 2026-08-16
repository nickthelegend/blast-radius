# Blast Radius — verification plan

Every component and flow, with the specific expected result each must produce.
"Correct" is defined here *before* execution; a result that merely looks
plausible is a FAIL.

**Rules for this run**
- Executed against the running product in a real browser, not by reading code.
- Console and network are checked on **every** UI item. Any console error, or
  any request with a non-2xx status that the UI does not deliberately handle,
  fails that item.
- No mocks, stubs, fallback data, or placeholder logic may remain in any tested
  path.

Environment under test: `make demo` on the working tree, HydraDB on MinIO,
dashboard served by `blastradius serve` at `http://127.0.0.1:4000`.

---

## A — Infrastructure

| id | item | expected result (exact) |
|---|---|---|
| A1 | MinIO object store | Container healthy; bucket `blast-radius` exists; HydraDB objects present under it |
| A2 | HydraDB readiness | `GET :9090/readyz` → 200; `/healthz` → 200; `/metrics` → 200 with Prometheus text |
| A3 | Bolt endpoint | Stock `neo4j-driver` connects, runs a parameterised read AND `algo.SSpaths`; version count identical to the HTTP transport |
| A4 | Durability | After `docker compose restart hydradb`, node counts and every compromise marking are byte-identical to before |
| A5 | Clean clone | `git clone` → `make demo` exits 0 with no manual steps, no network beyond `npm install` |
| A6 | No write errors | After a full load + simulate, zero `PutMode::Update` and zero `error collecting garbage` in HydraDB logs |

## B — HTTP API

Success cases must return 200 with the stated shape. Error cases must return the
stated status **and** a JSON `error` string — never a 500, never an empty body.

| id | endpoint | expected result (exact) |
|---|---|---|
| B1 | `GET /api/health` | `{ready:true, hydra, org}` |
| B2 | `GET /api/stats` | `stats.versions > 12000`; `incident.version_key` non-null; `compromised[0].key === incident.version_key` |
| B3 | `GET /api/scenarios` | 2 scenarios; each has `from < to`, `windowMinutes > 0` |
| B4 | `GET /api/repos` | ≥ 18 repos, each with `key`, `name`, `lockfileSource` |
| B5 | `GET /api/search?q=npm:deb` | ≥ 1 result, every `key` starts with `npm:deb` |
| B6 | `GET /api/versions?package=npm:debug` | ≥ 10 versions; `timeline` ordered ascending by `publishedAt`; exactly one entry flagged `introducesVulnerability` |
| B7 | `GET /api/exposure?version=<incident>` | `exposedRepos.length ≥ 5`; every entry has non-empty `chain` ending at the compromised key; `truncated === false`; `procedure === "algo.SSpaths"` |
| B8 | `GET /api/exposure?...&repos=a,b,c,d` | `procedure === "algo.MSpaths"`; result set ⊆ the 4 named repos |
| B9 | `GET /api/graph?version=<incident>` | `nodes.length > 100`; every link's source and target exist in `nodes`; source node id === `source.id` |
| B10 | `GET /api/time-machine?version=<incident>` | `duringWindow.length ≥ 1`; `duringWindow == stillCurrent + supersededSinceWindow`; no snapshot appears in both `duringWindow` and `outsideWindow` |
| B11 | `GET /api/time-machine/as-of?...&at=T` | Only snapshots with `capturedAt ≤ T` and (`supersededAt === 0` or `> T`) |
| B12 | `GET /api/maintainers?package=npm:debug` | ≥ 1 maintainer; no neighbour equals the queried package; `riskLevel ∈ {LOW,MEDIUM,HIGH}` |
| B13 | `GET /api/remediation?version=<incident>` | Every fix with a `targetVersion` has `direction ∈ {upgrade,rollback}`; `distinctChanges` non-empty; no target equals the compromised version |
| B14 | `GET /api/typosquats` | ≥ 50 findings; every verdict ∈ {SUSPICIOUS,WATCH,LIKELY_LEGITIMATE}; sorted SUSPICIOUS-first |
| B15 | `GET /api/simulate` (SSE) | Emits `start`, ≥1 `publish`, ≥1 `measure`, terminal `done`; every `measure.queryMs > 0` |
| B16 | `POST /api/mark-compromised` | 200, and a follow-up `stats` shows the version marked with the given window |
| B17 | `POST /api/clear-compromised` | 200 with `cleared` count; follow-up `stats` shows `compromised: []` |
| B18 | `GET /api/exposure?version=does-not-exist` | **404** with JSON `error` naming the version — not 500, not empty |
| B19 | `GET /api/maintainers?package=nope` | **404** with JSON `error` |
| B20 | `GET /api/time-machine?version=<uncompromised>` | **400** with JSON `error` explaining no window is set |
| B21 | `POST /api/mark-compromised` missing `from`/`to` | **400** with JSON `error` |
| B22 | `GET /api/search?q=a` (below min length) | 200 with `[]` — not an error |

## C — Dashboard (real browser)

Every item additionally requires: **zero console errors, zero failed network
requests**.

| id | flow | expected result (exact) |
|---|---|---|
| C1 | Initial load | Header shows package/version/edge/repo counts; a version is preselected and it equals the recorded incident |
| C2 | Blast radius view | "Currently exposed" table ≥ 5 rows; each row shows a depth and a chain ending in the compromised package; graph canvas width > 0 and non-blank |
| C3 | Blast radius — row select | Clicking a row highlights that repo's path in the graph; clicking again deselects |
| C4 | Blast radius — verified toggle | Toggling re-queries; header line reports `strong` consistency; row set unchanged (quiescent graph) |
| C5 | Blast radius — MSpaths dropdown | Selecting the subset option re-queries; meta line shows `algo.MSpaths`; rows ⊆ 4 repos |
| C6 | Time machine view | "Exposed during the window" and "Exposed right now" both populated; timeline renders ticks; compromise window band visible |
| C7 | Time machine — scrubber | Dragging re-queries `as-of` and the reported repo list changes with the instant |
| C8 | Time machine — comparison | Table lists every repo from either set; at least one repo differs between the two columns; explainer text appears for it |
| C9 | Time machine — verified toggle | Reports `strong` + a read epoch |
| C10 | Remediation view | "Do this" table non-empty; every row labelled `upgrade` or `roll back`; per-repo table shows the chain; rollback note present if any rollbacks |
| C11 | Maintainer web view | Radial SVG renders with the package at centre; maintainer nodes labelled; neighbours table populated |
| C12 | Typosquat view | Verdict filter buttons show counts; clicking each filters the table; SUSPICIOUS default non-empty |
| C13 | Attack clock | "run incident" streams events; clock advances from T+00:00; exposed-repo count is > 0 and non-decreasing; graph populates; run terminates |
| C14 | Version picker | Typing a valid key + query re-renders all views for it |
| C15 | Error state | Typing a nonsense version shows a readable error in the UI — no blank screen, no unhandled console exception |
| C16 | Tab navigation | All six tabs reachable and each renders its own content without leaking the previous tab's state |

## D — CLI

| id | command | expected result (exact) |
|---|---|---|
| D1 | `blastradius` on PATH after `make install-cli` | `which blastradius` resolves; `--version` prints |
| D2 | `./bin/blastradius` with no install | Same output as D1 |
| D3 | `doctor --bolt` | Every engine capability check `ok`; every Bolt check `ok`; exit 0 |
| D4 | `stats` | Node/edge counts and the compromised list |
| D5 | `incident` / `incident --key` | Prints the recorded incident; `--key` prints only the version key |
| D6 | `exposure <v>` | Report with chains; query time; `truncated` warning absent |
| D7 | `exposure <v> --repos …` | Uses `algo.MSpaths`; only named repos |
| D8 | `exposure <v> --which-version` | Version timeline with exactly one "introduced here" marker |
| D9 | `time-machine <v> --verified` | During-window list + comparison; reports strong consistency |
| D10 | `remediate <v>` | Per-repo fixes; rollbacks labelled as rollbacks |
| D11 | `maintainers <pkg>` | Maintainers + neighbours + risk score |
| D12 | `typosquats` | Findings with verdicts and a summary line |
| D13 | `simulate --speed 3 --ticks 3` | Publishes and measures; ends with a report |
| D14 | `scan .` | Parses this repo's lockfile; reports counts; detects its own exposure |
| D15 | `inspect-lockfile .` | Parses without writing; reports duplicate-version packages |
| D16 | `scenarios` | Lists both scenarios |
| D17 | `mark-compromised` / `--clear` | Sets and clears a window |
| D18 | `load` / `arm` / `reset` | Load reports rows+round trips; arm marks the incident |
| D19 | Unknown version | Clean one-line error, non-zero exit — no stack trace |
| D20 | HydraDB down | Actionable error naming `make db-up` — no raw fetch exception |

## E — Data correctness invariants

| id | invariant | expected result (exact) |
|---|---|---|
| E1 | Exposure is lockfile-authoritative | Every repo in `exposedRepos` has a current `LockfileSnapshot` with a `RESOLVED` edge to the compromised version |
| E2 | Window inclusivity | Snapshots at exactly `from` and exactly `to` are inside; `from-1ms` and `to+1ms` are outside |
| E3 | Remediation soundness | For every proposed `targetVersion`, no `RESOLVED_TO` path of length ≤ maxDepth reaches the compromised version |
| E4 | Scan fidelity | A chain reported for a scanned repo is reproducible from the raw lockfile JSON |
| E5 | No local packages | No `Package` node exists for a workspace-only name (e.g. `npm:@blast/core`) |
| E6 | pathCount honesty | With `pathCount: 1` the report is flagged `truncated` |

## F — Repository / submission

| id | item | expected result |
|---|---|---|
| F1 | Public repo | Reachable, PUBLIC, MIT licensed |
| F2 | Clean clone install | Clone from GitHub → `make demo` exits 0 |
| F3 | No forbidden markers | Zero mock/stub/TODO/fake/dummy/placeholder in tested source |
| F4 | Test suite | 100/100, zero skipped |

---

## Results

Filled in during execution. Legend: PASS / FAIL / UNTESTED (with reason).
