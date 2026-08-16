# Demo video script — target 2:50

Shot list, timings, and the exact commands to run. Everything below is verified
working after `make demo`.

**Before recording**

```bash
make demo          # clean DB, loaded graph, incident armed
make serve         # dashboard on http://127.0.0.1:4000, leave running
export NO_COLOR=   # keep terminal colour ON for the recording
```

Have two windows ready: a terminal (wide, large font) and the browser.

---

## 0:00 – 0:20 — The question, and why nothing answers it

**On screen:** the track's own framing as a title card.

> "A package is compromised at 09:00. Which of your services are exposed by 09:06?"

**Say:**

> Every tool in this space — Socket, Snyk, JFrog, OSV-Scanner — answers this by
> statically scanning your current lockfiles. That tells you what you ship
> today. None of them can tell you what you shipped at 09:03, while the
> malicious version was live, because none of them keep a queryable history.
> Blast Radius does, because it keeps the whole thing in a graph.

Cut to the terminal showing the loaded graph:

```bash
blastradius stats
```

> 1,399 real npm packages, 12,351 versions, 9,846 resolved dependency edges, and
> eighteen repositories with a hundred and twenty-three lockfile captures between
> them.

---

## 0:20 – 0:50 — The attack clock

Browser, **Attack clock** tab. Press **run incident**.

**Say while it runs:**

> This is the TanStack worm pattern replayed against the real graph. It starts
> on `debug`, and it spreads along real maintainer edges — `ulisesgascon` and
> `dougwilson` genuinely co-maintain most of the Express ecosystem, so a stolen
> credential really does reach `send`, `body-parser`, `serve-static`.
>
> Every one of those exposure numbers is a live traversal against HydraDB. Watch
> the query time on the right — that's `algo.SSpaths` finishing in under a
> second while the count climbs from five repositories to ten.

Let it reach roughly T+04:30, then cut.

---

## 0:50 – 1:30 — The Lockfile Time Machine (the centrepiece)

Browser, **Time machine** tab.

**Say:**

> Now the question a scanner cannot ask. Not "who is exposed" — "who *was*
> exposed, during the six minutes the malicious build was actually live."

Point at the timeline: the shaded window, the red captures inside it.

> Six repositories captured a lockfile inside that window that resolved the bad
> version. Three of them have since upgraded.

Scroll to the comparison table. Pause on it.

> And there's the whole point. `notifications-worker`, `onboarding-frontend`,
> `search-indexer` — clean today. Every scanner on the market reports them safe.
> They ran the malicious build. Meanwhile `customer-portal` and `design-system`
> are exposed right now but were never exposed to the incident, because they
> picked the version up after the artifacts were pulled. Completely different
> remediation priorities, and a flat scanner conflates them.

Toggle **verified**.

> That's strong consistency — HydraDB refreshes from object storage before
> pinning the snapshot, so the answer is guaranteed to include every committed
> write. In an incident you want that switch.

---

## 1:30 – 1:50 — Scan this very repository

Terminal:

```bash
blastradius scan . --name blast-radius-itself
```

> That is not the demo dataset — that is this project's own package-lock.json.
> Two hundred and seventy-one real packages, and npm's own hoisting resolution
> read straight off the lockfile.

Wait for the last line.

> And it's exposed. `vitest` two-point-one-nine pulls in `debug` four-four-three.
> The tool just found a real path from a real lockfile to the package we
> compromised. Point it at your repo and it does the same thing.

```bash
blastradius remediate npm:debug@4.4.3
```

> And here's the fix — every published version of each offending dependency
> tested against the graph in one MSpaths call. Note it says "roll back" where
> it means roll back; five of these have no newer safe release.

---

## 1:50 – 2:10 — Quick hits

**Maintainer web** tab:

> Before anything is compromised: who else can publish to the packages you
> depend on. One `algo.SSpaths` call over `MAINTAINS` — package, maintainer,
> package — so the reason comes back with the risk.

**Typosquats** tab, filtered to SUSPICIOUS:

> Real packages on npm right now whose names sit one keystroke from ours.
> `@cjser/supports-color`, twenty-one days old, ten downloads a week. And
> `performancenow` — the hyphen removed from `performance-now`. Proximity alone
> decides nothing: `preact` is one edit from `react`. The verdict combines the
> kind of edit with the package's age and download volume.

---

## 2:10 – 2:35 — What HydraDB is doing

Terminal, side by side with the primitive names on screen:

```bash
blastradius exposure npm:debug@4.4.3
```

**On screen, as a list:**

```
algo.SSpaths        bounded reverse traversal, one call
algo.MSpaths        many sources × many targets, one round trip
pinned snapshots    every query is point-in-time
causal / strong     the "verified" toggle
batched UNWIND      43,651 rows in 95 round trips, 2.4s
Bolt                stock neo4j-driver, verified against HTTP
```

**Say:**

> One `algo.SSpaths` call, walking three relationship types backwards from the
> compromised version, returns the shortest chain to every reachable node — and
> the paths come back with node properties attached, so the report explains
> itself. `design-system` is exposed three hops deep through `serve-static` and
> `send`, and that chain arrives with the answer.
>
> Without a real graph engine this is a recursive SQL CTE materialising a
> transitive closure on every request, or an in-memory BFS that doesn't persist.
> And the Time Machine specifically isn't implementable without snapshot-
> consistent reads — a point-in-time answer over a graph that shifts mid-query
> isn't a point-in-time answer. A vector index can't express any of it: "which
> repos resolved this exact version between 09:00 and 09:06" has no similarity
> component at all.

---

## 2:35 – 3:00 — Close on the numbers

**On screen:**

```
blast radius traversal      7 ms     1,024 paths, 12k-version graph
time machine (strong)      38 ms
multi-repo MSpaths         77 ms
graph load             2.46 s      43,651 rows / 95 round trips
```

**Say:**

> Sub-ten-millisecond traversal on a real npm dependency graph. And one finding
> worth flagging: `MSpaths` in pairwise mode silently drops any pair whose
> source id is greater than its target's — we found it, wrote a regression test
> for it, and shipped the non-pairwise form so the tool can't under-report. That
> and everything else we learned about the engine is written up in
> `docs/hydradb-findings.md`.

End on the repo URL.

---

## If a shot fails

- Attack clock not moving → the previous run left markings; `blastradius arm`
  resets to a clean incident.
- Everything slow → `make db-reset && make load && blastradius arm`. Local
  filesystem storage degrades over long sessions (SlateDB GC can't run against
  it); a fresh volume restores millisecond queries.
- Graph canvas blank → resize the browser window once; the layout measures on
  resize.
