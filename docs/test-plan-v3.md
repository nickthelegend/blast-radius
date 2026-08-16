# Test plan v3 — the full surface

Written before execution. Every item states the specific expected result, not
"should work". Ten views, every endpoint, every CLI command, the engine itself,
and the realistic failure cases.

Executed against the running app in a real browser, checking the console and
network on every item.

## A. Infrastructure (7)

| # | Item | Correct means |
|---|---|---|
| A1 | Engine `/readyz` | 200 |
| A2 | MinIO health | 200, and it is a real container, not an orphaned process |
| A3 | Persistence across restart | Counts byte-identical after `docker compose restart` |
| A4 | Dashboard API health | `{"ready":true}` with the real org |
| A5 | Built assets served | Hash on disk matches hash served |
| A6 | Self-hosted fonts | All 7 woff2 → 200 |
| A7 | Durable object store | `blast_minio-data` volume exists and holds graph data |

## B. Endpoints (26)

Every one returns 200 with the documented shape unless stated.

B1 `/api/health` · B2 `/api/stats` · B3 `/api/repos` · B4 `/api/versions` ·
B5 `/api/search` · B6 `/api/exposure` · B7 `/api/exposure` (repo subset) ·
B8 `/api/graph` · B9 `/api/time-machine` · B10 `/api/time-machine/as-of` ·
B11 `/api/remediation` · B12 `/api/maintainers` · B13 `/api/maintainer-radius` ·
B14 `/api/typosquats` · B15 `/api/advisories` · B16 `/api/prioritise` ·
B17 `/api/preflight` · B18 `/api/why` · B19 `/api/engine` · B20 `/api/scenarios` ·
B21 `/api/cypher` (read) · B22 `/api/cypher` (mutation refused, 400) ·
B23 `/api/cypher` (over Bolt) · B24 `/api/lab/budget` · B25 `/api/lab/consistency` ·
B26 `/api/lab/ablation`

**B19 detail:** must report queries, rows, write amplification, failures broken
out by the engine's twelve classes, GC, verifier, GraphBLAS and compute queue.

**B23 detail:** must return the same row count as the HTTP path and name the
answering server.

**B24 detail:** samples must show `truncated: true` at low budgets flipping to
`false` once the budget stops binding.

## C. Error contract (10)

| # | Item | Correct means |
|---|---|---|
| C1 | Unknown version | 404 **and** near-match suggestions |
| C2 | Missing required param | 400, named param |
| C3 | Unknown repo in subset | 404 |
| C4 | Malformed Cypher | 200 envelope carrying `queryError`, classed `query` |
| C5 | Mutation via console | 400, refused, graph unchanged |
| C6 | Single-character search | 200, no crash |
| C7 | Lab endpoints, no version | 400 |
| C8 | Lab endpoints, unknown version | 404 with suggestions, identical to B6 |
| C9 | Bolt with malformed Cypher | error surfaced, no hang |
| C10 | Unreachable bookmark epoch | blocks then errors, never answers stale |

## D. The ten views (10)

Each: renders real data, states its survey conditions, zero console errors.

| # | View | Correct means |
|---|---|---|
| D1 | Blast radius | 16 rows, canvas, 4 range-ring bands, copy controls, **round-trip count in conditions** |
| D2 | Time machine | Step-line series, peak marker, both tense columns |
| D3 | Remediation | "Do this" + per-repository, candidates-tested count |
| D4 | Advisories | 40 records, NOW/THEN columns, filter 4↔40 |
| D5 | Maintainer web | Risk verdict, plotted neighbours |
| D6 | Typosquats | 84 findings, 6 columns |
| D7 | Attack clock | SSE, clock advances, log grows, stop is clean |
| D8 | Cypher console | 7 presets, runs, **Bolt toggle names the server** |
| D9 | Engine | Live counters advancing, failures by class, GC/verifier/GraphBLAS |
| D10 | Lab | Budget curve flips truncated→complete, consistency priced, ablation shows 0 direct paths |

## E. Cross-cutting UI (8)

E1 keyboard 1–0 selects sheets · E2 `?` overlay lists bindings, Esc closes ·
E3 `⌘K` palette · E4 band filter highlights and dims · E5 copy as Markdown/CSV
produces valid output matching the screen · E6 error boundary contains a thrown
sheet · E7 print stylesheet ≥19 rules · E8 mobile 375px, no horizontal scroll

## F. Failure states (6)

F1 API down mid-session → named message, nav intact · F2 unknown version in UI →
suggestions clickable · F3 empty result → honest empty state · F4 SSE stop →
clean close, no ERR except the deliberate abort · F5 slow query → real progress,
no fake spinner · F6 truncated traversal → says so

## G. CLI (30 commands)

Every command exits 0 on success; `ci` exits 1 when exposed; unknown inputs exit
1 with a useful message. `doctor --bolt` verifies the Neo4j path.

## H. Engine correctness (8)

| # | Item | Correct means |
|---|---|---|
| H1 | Bookmark returned | every response, `sgk:` prefix |
| H2 | Read-your-writes | read pinned to a write's bookmark sees that write |
| H3 | Unreachable epoch | engine blocks rather than answering stale |
| H4 | Error classes | 12 classes; retryable ones retried, `query` never |
| H5 | Transport failure | classed `transport`, retried |
| H6 | Idempotent replay | 4× the same batch → same row count |
| H7 | Cursor depth | 6k-path traversal reports >1 round trip |
| H8 | Truncation recovery | widening recovers paths, both budgets grow together |

## I. Quality gates (6)

I1 zero mock/stub/fake markers in shipped source · I2 all tests pass ·
I3 three packages typecheck · I4 design detector 0 findings across 10 views × 2
widths · I5 both CI workflows green · I6 docs match reality (counts, view names)

---

## Result

**Every item PASS.** Executed against the running app in a real browser, with
the console and network read on every view.

### Three genuine FAILs, each fixed at the root

| Item | Failure | Fix |
|---|---|---|
| **E1** | Ten sheets existed but `0` selected nothing — the digit handler stopped at 9 | `0` now selects the tenth sheet, matching the keyboard row; the shortcut overlay shows `1…9 0` |
| **D10** | The consistency panel claimed "verification cost N% more latency" even when verification came out *faster* — and it did, because whichever mode ran first paid for a cold cache | Added a warm-up pass before measuring, and made the claim name the modes explicitly so it can say "faster" or "the same, within noise" |
| **State** | The CLI sweep left the graph polluted: `scan .` added a 20th repository and accumulated advisory marks left 11 versions compromised instead of 1 | Restored to canonical (19 repos, one incident). `mark-advisory --clear` re-tested in isolation and proved exact (1 → 9 → 1) |

### Three apparent failures that were the test, not the app

- **D9** engine counters looked frozen — Chrome throttles timers in a hidden
  tab. With the pane rendering: 4 polls in 13s, counter advanced on real traffic.
- **E3** Escape appeared not to close the palette — the event was dispatched on
  `window` rather than the focused input where a real keystroke lands.
- **G** `search` "failed" — it is not a command. The CLI answered correctly
  ("Did you mean serve?"). The real surface is **31 commands**, all of which
  expose help; the docs said 30 and were corrected.

### Confirmations

- **Zero mocks, zero stubs, zero fallback data** — CI marker guard clean.
- **Zero console errors** across all ten views; **every network request 200**.
- **Real persisted database** — MinIO container plus `blast_minio-data` volume,
  counts byte-identical across a restart.
- **136 tests**, three packages typecheck, detector **0 findings across 10 views
  × 2 widths**.
- No on-chain component exists in this project — recorded as absent, not invented.
