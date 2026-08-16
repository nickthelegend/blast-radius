---
name: Blast Radius
description: Overpressure Survey — a blast-damage survey sheet on a backlit drafting table
colors:
  ground: "#12110f"
  sheet: "#1a1815"
  sheet-2: "#221f1a"
  well: "#0d0c0a"
  rule: "#35302a"
  rule-lit: "#4d463c"
  graphite: "#6f665a"
  ink: "#ece6da"
  ink-2: "#b5aa99"
  ink-3: "#968b7b"
  blast: "#ff6a45"
  blast-deep: "#7d2d1a"
  buff: "#e3ac57"
  buff-deep: "#6b4d22"
  clear: "#9dc46f"
  clear-deep: "#3f5b2c"
  survey: "#93b0c2"
  survey-deep: "#34505f"
typography:
  body:
    fontFamily: "'Plex Cond', ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontFamily: "'Plex Cond', ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.55
    letterSpacing: "0.11em"
  value:
    fontFamily: "'Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  instrument:
    fontFamily: "'Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "22px"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "normal"
  clock:
    fontFamily: "'Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "46px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.02em"
rounded:
  none: "0"
  sheet: "2px"
spacing:
  hairline: "4px"
  tight: "9px"
  sheet-pad: "18px"
  between: "16px"
  section: "22px"
components:
  sheet:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
    padding: "18px"
  sheet-title:
    textColor: "{colors.ink}"
    typography: "{typography.label}"
  button-action:
    backgroundColor: "transparent"
    textColor: "{colors.survey}"
    rounded: "{rounded.none}"
    padding: "7px 15px"
    typography: "{typography.label}"
  button-action-hover:
    backgroundColor: "{colors.survey}"
    textColor: "{colors.ground}"
  pill-exposed:
    backgroundColor: "transparent"
    textColor: "{colors.blast}"
    rounded: "{rounded.none}"
    padding: "1px 8px 1px 6px"
  pill-superseded:
    backgroundColor: "transparent"
    textColor: "{colors.buff}"
    rounded: "{rounded.none}"
    padding: "1px 8px 1px 6px"
  pill-clean:
    backgroundColor: "transparent"
    textColor: "{colors.clear}"
    rounded: "{rounded.none}"
    padding: "1px 8px 1px 6px"
  input-text:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "7px 10px"
    typography: "{typography.value}"
  key-band:
    backgroundColor: "transparent"
    textColor: "{colors.ink-3}"
    rounded: "{rounded.none}"
    padding: "11px 14px"
---

# Blast Radius — Overpressure Survey

## Overview

The world is a **blast-damage survey sheet on a backlit drafting table**.

This is not decoration chosen after the fact. The product already measures
outward from a single origin in discrete bands: a compromised package version
is ground zero, dependency depth is distance, and the set of repositories at
each depth is an annulus. The survey chart is the document that has recorded
exactly that relationship for a century, so the interface is drawn as one.

Everything in the system follows from that decision:

- **Sheets, not cards.** Square corners, a printed hairline border, a title
  block with a registration notch, and the sheet's own provenance in the
  bottom margin.
- **Rank by case, weight and rule — never by size.** There are three type
  sizes in the whole product and two of them are instrument readouts.
- **Every sheet states its survey conditions.** Elapsed time, procedure,
  consistency mode, read epoch. The product's first principle is *show the
  query*; a chart that hides its provenance is not a chart.
- **Colour is never the only carrier of state.** Every exposure state also has
  a name and a drawn mark, because exposed-versus-clean is the most
  consequential distinction in the product.

Mode: **Operate**. The reader is an incident responder under time pressure who
already reads dependency chains fluently. Density, exactness and scanability
outrank atmosphere. Brand lives in the rule work, not in ornament.

## Colors

The ground is **warm graphite** — a black with brown in it, the colour of film
base and drafting stock. It is deliberately not the blue-black that every
generated dark dashboard reaches for.

| Token | Role |
|---|---|
| `ground` `sheet` `sheet-2` `well` | The stock, in four depths. `well` is the recess behind plotted work: graph, log, console, timeline. |
| `rule` `rule-lit` | Hairlines. `rule-lit` is a rule under emphasis (table head, active border). |
| `ink` `ink-2` `ink-3` | Bone line work at three weights. All three clear WCAG AA on every stock (14.3:1, 7.7:1, 5.3:1). |
| `graphite` | **Non-text only** — 3.1:1. Plotted marks, separators, scrollbar thumbs. Never carries a word. |

The survey key is four load-bearing states, and only four:

| Token | State | Mark |
|---|---|---|
| `blast` | exposed now | ▲ triangle |
| `buff` | exposed then / superseded | ◆ diamond |
| `clear` | clean | ● circle |
| `survey` | the reference layer: interactive, links, focus | — |

`survey` is a pale printed slate, the ink a chart uses for its grid and water.
It is deliberately low-chroma: saturated cyan-on-dark is the single most
recognisable tell of a generated interface, and this world does not need it.

## Typography

**IBM Plex, self-hosted**, latin subsets only, ~100KB total across seven
weights. Plex Sans Condensed is the drafting office's annotation voice; Plex
Mono carries every measured value, because these genuinely are measurements
rather than a costume for "technical".

The type scale is the strictest rule in the system:

- **One size for everything that is read: 13px.** Sheet titles, table headers,
  field labels, body annotation, and values are all 13px. Hierarchy comes from
  case (uppercase + `0.11em` tracking for labels), weight (600 for labels, 400
  for values), colour, and the rule beneath a title.
- **Two departures, both instruments:** `22px` for a counted quantity and
  `46px` for the incident clock. These are readouts, not headings.
- `font-variant-numeric: tabular-nums` globally. A count that changes must
  never reflow the row it sits in.
- `button, input, select, textarea { font: inherit }` — otherwise a button
  lands on the UA's 13.333px Arial, a second invisible type scale running
  underneath the designed one.
- Prose measure is capped at `58ch`, not the more usual 65–75. `ch` is the width
  of a zero, and this face is condensed — so a cap that *reads* generous renders
  far wider than the character count implies. The number was measured against
  the rendered line, not assumed from the unit.
- A `max-width` on a `<td>` does nothing unless the table is `table-layout:
  fixed`; cap the measure on a wrapper inside the cell instead.

## Layout

- `main` is a single scrolling column of sheets at 20px padding; `grid-2` for
  paired questions (now vs. then), collapsing at 1100px.
- The masthead is a **title block** (identity, imprint, survey extent, search)
  over a **sheet index** (the eight view tabs, underlined not filled, two of
  them carrying a live count). The
  index scrolls horizontally rather than wrapping.
- Rhythm: 9px inside a group, 16px between sheets, 22px before a table.
  Headings take more space above than below.
- `main, .panel, .grid-2 > *, .row > * { min-width: 0 }` — a grid or flex child
  defaults to `min-width:auto` and refuses to shrink below its content, which
  is how one long monospace key widens the whole page and pushes every
  paragraph past the viewport edge.
- Below 760px every measured table scrolls inside its own sheet.

## Elevation & Depth

There are **two shadows in the product**, both on overlays that genuinely
float: the command palette and the shortcut sheet, `0 18px 48px
rgba(0,0,0,0.62)` — a real offset with real blur, because the palette genuinely
floats above the sheet.

Everything else expresses depth by **recession, not elevation**: content sits
*into* the stock (`well` behind plotted work) rather than floating above it.
There are no glass effects, no coloured halos, and no zero-offset glows.

## Shapes

- Sheets: `2px` radius — effectively square, enough to avoid a hard pixel
  corner. Everything else is `0`.
- No pill buttons, no rounded cards, no capsule inputs.
- Registration marks (13px corner ticks) on plotted wells only.
- Range rings are dashed `2 5`; the compromise window is **hatched**, not
  tinted, so it survives greyscale.
- Icons are authored SVG applied as CSS masks (`--icon-copy`, `--icon-check`,
  `--icon-rise`, `--icon-fall`) at a consistent 1.6–1.9 stroke. No emoji, no
  glyph-font arrows.

## Components

**Sheet** — the only container primitive. Title block with a 3×11px blast-red
registration notch, a rule beneath, optional annotation, content, then a
`Conditions` strip in the bottom margin.

**Conditions** (`<dl class="conditions">`) — the provenance strip. Label in
condensed caps, value in mono. Carries elapsed, procedure, consistency, read
epoch, path counts. Every sheet that runs a query has one.

**Plotting** — the loading state. Names the actual query being run
("testing every candidate version against the graph — algo.MSpaths") over bars
that print across. Never an indeterminate spinner: on this product latency runs
20ms–4s and *which* query you are waiting on is information.

**Key band** (`.verdict-key`) — a segmented survey legend. Bands sit tight
against each other as one instrument; the active band is underlined in its own
state colour and its count is set in the instrument size.


**Copy control** (`CopyTable`) — sits in a sheet's title block at the far end of
the rule, as two quiet bordered buttons. It reads the *rendered* table rather
than the source data, so what is copied is exactly what is on screen, filters
and truncation included. It reports failure (`copy blocked`) rather than
claiming a copy that did not happen — a control that lies about succeeding is
worse than one that is absent.

**Band strip** (`.band-strip`) — the distance scale as a control, top-right of
the plot. One button per hop band, labelled with its real population from the
same BFS the layout runs. The selected band draws its ring in `buff` and
everything outside it drops to a trace. Hidden below 640px, where the plot is
too small to filter usefully.

**Tab badge** (`.tab-badge`) — a count on the sheet index, in the state colour
of what it counts. Only two sheets carry one, and both are numbers a responder
is already scanning for; a badge on every tab would be noise rather than signal.

**Shortcut sheet** (`.shortcuts`) — a centred overlay on the palette backdrop,
listing every binding. Opened with `?`, closed with `?` or Escape.

**Sheet boundary** (`SheetBoundary`) — the error fallback, drawn as an ordinary
sheet whose designation names which one failed. React unmounts the whole tree
when a render throws, so without this one bad panel blanks the navigation and
the other seven sheets with it. Offers "draw it again", which re-mounts only
that sheet.

**Suggestions** (`.suggestions`) — near-matches offered beside a not-found
error, as clickable pills in the reference ink. A dead end on a mistyped key is
the most likely way a first-time reader concludes the tool is broken.

**Print** — the sheet prints as a sheet: ink inverted to paper, screen-only
chrome (navigation, controls, band strip, copy buttons) dropped, table headers
repeating across page breaks, sheets refusing to split mid-table, the plotted
canvas kept because it is the evidence, and the deep link printed beside the
wordmark so a paper copy says where it came from.

**Force graph** — the signature surface. `forceRadial` pins every node to the
ring for its own hop count from ground zero, so **distance on the plot is
dependency depth**. Ground zero is pinned dead centre with a crosshair. Rings
are labelled on the sheet's vertical (`3 HOPS — 62`). Node shape carries type
(diamond = origin/lockfile, square = repo, circle = version) so the plot reads
in greyscale. Labels are collected during the node pass and laid last in
priority order (ground zero, exposed repos, then the rest), each knocking out
the line work behind it; a label that would collide with one already set is
dropped rather than stacked.

## Do's and Don'ts

**Do**

- Put a `Conditions` strip on any sheet that ran a query.
- Give every new state a name and a drawn mark before giving it a colour.
- Reach for case, weight, and a rule when something needs to rank higher.
- Let a number be an instrument when the number *is* the answer.
- Name the query in a wait state.

**Don't**

- Add a fourth type size. If something needs emphasis, it needs weight or case.
- Use `graphite` for text — it is 3.1:1 and fails AA.
- Introduce a saturated cyan, a violet, or any gradient.
- Round a corner beyond 2px, nest a card inside a card, or add a kicker above
  a heading.
- Use a unicode glyph or emoji as an icon; author the SVG and mask it.
- Add a pulsing dot. A live measurement is a travelling rule (`.live-pulse`),
  not a throb.
- Put a `border-left` above 1px on anything.
- Let an inline `style` set a width — it beats the media query and is how the
  narrow-width layout silently breaks.
