# Recording plan — everything to capture, end to end

Every number and timing below was measured against the running app while writing
this, not estimated. Where a step is slow enough to be awkward on camera, the
real duration is stated so you can narrate over it instead of discovering it
mid-take.

---

## Part 0 — Pre-flight (do this every single time)

The stack has failed on me three separate times in this project's history, and
each failure looked different. Ten minutes here prevents a ruined take.

```bash
colima start --cpu 4 --memory 8      # 2 CPU / 2 GB silently never becomes ready
docker compose up -d --wait
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9090/readyz   # want 200
```

Then load and confirm **the exact numbers you are about to say on camera**:

```bash
blastradius load && blastradius scan . && blastradius arm
blastradius doctor          # want: 1,480 packages, 12,463 versions, 10,015 edges
blastradius doctor --bolt   # want: 12 ok, 0 fail
```

If `doctor --bolt` reports an empty routing table, recreate rather than restart:
`docker compose up -d --force-recreate hydradb`.

**Warm the caches before the first take.** Cold, the Lab sheet takes ~9s; warm,
~4s. Open all ten sheets once, then start recording.

**Known risk:** a `--force-recreate` has twice come back with an *empty graph*.
Always re-run `blastradius doctor` after any container operation. Reloading is
only ~10 seconds, so this is cheap to fix and expensive to miss.

---

## Part 1 — The main demo video (target 3:00)

The one asset that decides the round. Structure it so the differentiator lands
by 1:45, because that is where a judge decides whether to keep watching.

### 0:00 – 0:25 · The question

**On screen:** title card, then the dashboard on the Blast Radius sheet.

> "A package version is malicious for six minutes. Which of your services
> actually ran it?
>
> Every scanner — Snyk, Socket, OSV-Scanner — reads your *current* lockfiles.
> That answers what you ship today. None of them can tell you what you shipped
> at 09:03, while the bad version was live, because none of them keep the
> history. This does, and it keeps it in a graph you can query."

Point at the masthead: **1,480 packages, 12,463 versions, 10,015 edges, 19
repos** — real npm data, and say plainly that the *organisation* on top is
synthetic. The masthead says "real packages · synthetic org"; call it out
before a judge wonders.

### 0:25 – 1:00 · The blast radius

Already on screen. Point at the survey conditions strip:

> "`algo.SSpaths`, 5,998 paths, max depth 8, causal consistency, read epoch,
> six round trips. That's a real traversal in a real graph database — every
> number on this page is traceable to the query that produced it."

Click a row to isolate its path in the plot. Click a **range ring** to filter to
one hop band. (~1.2s per query, warm.)

### 1:00 – 1:45 · The differentiator — this is the shot that wins

Press `2` for Time Machine. **Slow down here.**

> "Same package, different question. Left column: repositories exposed *during*
> the six-minute window. Right column: exposed *right now*."

Then the fact that carries the whole project — **verified, and stronger than it
sounds**: the two sets do not merely differ, they are **disjoint**. Ten
repositories ran the malicious build and are clean today. Six are exposed today
and never touched it during the window. **The overlap is zero.**

> "Ten of these shipped the malicious build. Every current-state scanner on the
> market reports all ten as safe, because today their lockfiles are clean. And
> the six that *are* flagged today — none of them ever ran it."

Read the product's own line off the screen:

> "A scanner that only reads current lockfiles reports these as safe — it has no
> record of what they resolved to at 09:00."

Point at the timeline: **peak 11 repositories exposed at once**. Drag the
scrubber to query exposure as of any instant.

> "This is bitemporal storage doing the work: every lockfile capture is a node
> with `captured_at` and `superseded_at`, and the query is a range predicate
> inside a pinned snapshot."

### 1:45 – 2:10 · What to actually do

Press `3` for Remediation. **This takes ~5 seconds warm — narrate through it.**

> "Not 'upgrade everything'. The smallest set of version bumps that clears every
> affected repository, found by throwing 73 candidate versions at the graph in a
> single `algo.MSpaths` call. And where the only fix is a rollback, it says
> rollback rather than dressing it up as an upgrade."

### 2:10 – 2:35 · Prove it is real

Press `8` for the Cypher console.

> "Every number you've seen is one of these queries. Run it yourself."

Run a preset (5,998 rows). Then **tick "over Bolt"** and run the same query.

> "Same query, same answer, through a stock Neo4j driver instead of the HTTP
> API. Neo4j wire compatibility, demonstrated rather than claimed."

Press `9` for Engine.

> "And this is the database reporting on itself — queries completed, rows
> returned, write amplification, and failures broken out by HydraDB's own
> twelve-way classification. These counters move while you watch."

### 2:35 – 3:00 · It ships

Cut to terminal:

```bash
blastradius ci        # exits 1, with the exposed repos listed
```

> "Same graph, as a merge gate. It emits SARIF, so the finding lands in GitHub's
> Security tab and annotates the pull request — and it fails closed: a scanner
> that cannot reach the database must never silently pass."

Show the live code-scanning alert on GitHub. Close on:

```bash
npx @xorv/blast doctor
```

> "One npm install, point it at any HydraDB, and it's yours."

**Only record this beat once the package is actually published.** It is built,
verified against a clean-directory install, and blocked solely on an npm token
with publish scope. Until then, the honest substitute is the same command from
a local install — or cut the beat. A judge who runs `npx @xorv/blast` and gets a
404 has just been shown the one thing that was not real.

---

## Part 2 — Screenshots for the submission gallery

Six, in this order. Each is a different claim.

1. **Blast Radius sheet, full width** — the plot with range rings and the
   conditions strip visible. This is the identity shot.
2. **Time Machine, both columns in frame** — the differentiator, legible.
3. **Lab · path budget calibration** — the truncated→complete curve. This one
   says "we measured our own limits" louder than any sentence can.
4. **Engine sheet** — failures by class, write amplification. Says "we went
   deeper into the sponsor's engine than a checkbox".
5. **Cypher console with the Bolt toggle on** — protocol compatibility, visible.
6. **GitHub Security tab** showing the live Blast Radius code-scanning alert —
   proves it leaves the demo and touches real infrastructure.

Capture at 1280×800 or wider, light-on-dark as-is, no annotations — the sheets
already label themselves.

---

## Part 3 — Optional deeper cut (5–8 min, for judges who ask)

Only if the hackathon allows a second video. Cover what the 3-minute cut cannot:

- `blastradius doctor --bolt` — all twelve capability checks, live.
- The **Lab** sheet in full: budget calibration, the consistency comparison, and
  the ablation showing **zero direct paths** — every exposure is inherited,
  which is exactly the case a manifest-level scanner misses.

  **Do not script a number for the consistency panel.** Measured across four
  runs it lands anywhere from 0.82× to 1.26× — on a quiet single-node graph with
  a warm cache, run-to-run variance is larger than the difference between the
  two modes. The sheet says so itself, in whichever direction the run came out,
  including "the same here, within noise". Present that as the point: the panel
  prices the trade-off live and refuses to manufacture a difference that is not
  there. A rehearsed "verification costs 2×" would be contradicted by the screen
  roughly half the time.
- `docs/hydradb-findings.md` — thirteen documented engine findings, including
  the silent path-budget truncation and the empty Bolt routing table.
- The self-scan: this repository finds *itself* exposed through
  `vitest → debug@4.4.3`.

---

## Part 4 — What not to record

Say these plainly if asked; do not stage around them.

- **The organisation is synthetic.** The packages, versions and 40 advisories
  are real; the 18 repositories and their lockfile history are generated. The
  masthead says so. Volunteering it costs nothing and being caught hiding it
  costs the round.
- **Do not demo a cold start.** `make demo` on an under-resourced Docker looks
  like a hang. Record against a warm stack and mention the requirement.
- **Do not claim multi-node.** It is one cell, one node. The engine telemetry
  makes that visible to anyone who looks.

---

## Part 5 — Order of work

1. Pre-flight, then rehearse the 3-minute run **twice** without recording.
2. Record the screenshots first — they are cheap and they force you through
   every sheet, which surfaces any staleness before you are live.
3. Record the demo video in one take if you can; the beats are short enough.
4. Record the deeper cut only after the main one is safely in hand.
