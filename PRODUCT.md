# Product

<!-- impeccable:product-schema 1 -->

> Written by inference from the repository, not from an interview. The user's
> brief for this run explicitly instructed "don't ask me for design direction,
> work it out yourself", so the init interview was substituted with evidence
> from README.md, docs/submission.md, the CLI copy, and the query layer. Facts
> below are drawn from that evidence; items marked *(inferred)* are hypotheses
> a future session should confirm.

## Platform

web

## Users

**Primary: the incident responder during an active supply-chain compromise.**
A security or platform engineer who has just learned that a package version was
malicious for a bounded window, and now has minutes — not days — to answer:
which of our repositories ran it, which merely resolve it today, and what is
the smallest change that clears each one.

They arrive mid-incident, usually with a Slack thread open beside them and
someone asking for a number. They are technical, they read dependency chains
fluently, and they distrust any tool that will not show its work.

**Secondary: the same engineer on a calm day**, using `preflight` and
`maintainer-radius` to ask what a compromise *would* cost before one happens,
and `ci` to keep the answer from regressing.

*(inferred)* A third audience exists for this build specifically: hackathon
judges evaluating it against Hack Hydra 2026 Track 2A. They are reading for
whether the graph engine does real work, and they will try the Cypher console.

## Product Purpose

Blast Radius keeps the real npm dependency graph and an organisation's lockfile
history in HydraDB so that supply-chain exposure is a graph traversal instead of
a static scan.

Success is a responder answering "who actually ran the malicious build" with a
list of repository names and the dependency chain that explains each one, in
under a minute, with the query visible.

## Positioning

Every scanner on the market answers **"who is exposed now."** Blast Radius also
answers **"who was exposed then"** — during the exact window the malicious
artifact was live — because it stores lockfile snapshots bitemporally
(`captured_at` / `superseded_at`) and queries them inside a pinned graph
snapshot.

These are different sets and both matter. In the shipped dataset, three
repositories were exposed during the incident window and are clean today: every
current-state scanner reports them safe, and all three ran the malicious build.
Two others are exposed right now but never touched the malicious artifact.

A neighbouring product cannot truthfully copy this claim without keeping
lockfile history as a queryable graph. That is the whole position.

## Operating Context

- Used during an incident, often on a laptop beside a Slack or PagerDuty thread,
  and in CI as a merge gate.
- The user's own vocabulary is lockfiles, resolution, transitive depth, pinning,
  advisories, purls, and semver ranges. The product speaks that language natively
  and does not translate it into softer words.
- Both a CLI (31 commands) and a browser dashboard exist, and the CLI is the
  senior surface: every dashboard view corresponds to a command.
- The graph is real: 1,480 packages, 12,463 versions, 10,015 resolved edges,
  40 real OSV advisories, 19 repositories, persisted in object storage.

## Capabilities and Constraints

- **Engine:** HydraDB — object-store-native distributed graph database, queried
  over an HTTP JSON API with cursor pagination, plus Neo4j-compatible Bolt.
- **Native procedures the product depends on:** `algo.SSpaths` (blast radius,
  maintainer web), `algo.MSpaths` (multi-repo checks, remediation candidate
  testing), `algo.SPpaths` (single-pair path explain).
- **Consistency is user-visible:** every query runs `causal` or `strong`, and
  the UI exposes the choice plus the read epoch. This is a product feature, not
  an implementation detail.
- **Latency is honest and variable:** traversals run 20ms–4s depending on the
  question. Timings are shown, never hidden behind an indeterminate spinner.
- **Result sets are large:** the flagship traversal returns ~6,000 paths; tables
  routinely run to hundreds of rows.
- The dashboard is read-only. The server refuses mutations from the browser.
- Nine views: blast radius, time machine, remediation, advisories, maintainer
  web, typosquats, attack clock, Cypher console, engine.

## Brand Commitments

- **Name:** Blast Radius. Set in two lines, "BLAST" over "RADIUS", in the
  existing header.
- **Voice:** technical, exact, unhedged, and willing to state its own limits.
  Real examples already in the product:
  - "A scanner that only reads current lockfiles reports these as safe. They ran
    the malicious build."
  - "Rolling back is a normal response to a live compromise, but it is labelled
    as such rather than dressed up as an upgrade."
  - "The traversal returned exactly its path budget; this report may be
    incomplete."
  - "a scanner that cannot run should never silently pass"
  The voice never uses exclamation marks, never congratulates the user, and
  never softens a finding. It explains *why* a number is what it is.
- **Licence:** MIT. Data attribution to npm, OSV.dev, and PyPI is required and
  already present in the README.

## Evidence on Hand

Real, in the repository, and never to be fabricated around:

- Live npm registry metadata and 40 real OSV advisory records (`data/snapshot/`).
- A real scan of this repository's own lockfile, which finds it genuinely
  exposed through `vitest@2.1.9 → debug@4.4.3`.
- Real measured timings and read epochs surfaced throughout the UI.
- Two GitHub Actions workflows that pass on a real runner.
- `docs/hydradb-findings.md` — twelve documented engine findings with evidence,
  including a case where `algo.MSpaths` with `pairwise: true` silently drops
  pairs.

There are **no** customers, testimonials, pricing, benchmarks against
competitors, or deployment claims. None may be invented.

## Product Principles

1. **Show the query.** Any number the interface states must be traceable to the
   Cypher that produced it. Trust is the product.
2. **Never round up a finding.** Under-reporting a blast radius is the worst
   failure this tool has; when a result may be truncated, say so in the result.
3. **"Now" and "then" are different questions.** Never conflate live exposure
   with incident exposure, in copy, colour, or layout.
4. **The responder is already expert.** Do not explain dependency resolution to
   them; give them density, exact values, and the chain.
5. **Latency is information.** Show real elapsed time and consistency mode
   rather than hiding variance behind a spinner.

## Accessibility & Inclusion

- Motion must honour `prefers-reduced-motion`; the attack clock and graph both
  animate, and both must degrade to static.
- The interface is used under time pressure and often on a laptop screen in a
  bright room: contrast and legibility at small sizes outrank atmosphere.
- Colour alone must never carry the exposed/clean distinction — it is the single
  most consequential state in the product.
