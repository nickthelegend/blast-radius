/**
 * Incident scenarios.
 *
 * `tanstack-worm-2026` replays the shape of the May 2026 TanStack npm/PyPI
 * worm against the loaded graph: a maintainer account is compromised, malicious
 * artifacts are published, and the payload self-propagates to further packages
 * the same account can reach — 84 malicious artifacts across 42 packages inside
 * roughly six minutes, which is where the track's "compromised at 09:00,
 * exposed by 09:06" framing comes from.
 *
 * What is replayed is the *pattern* — timing, fan-out, propagation along
 * maintainer edges. The packages it propagates through are whatever the real
 * ingested graph actually contains, so the simulation runs against real
 * dependency structure rather than a scripted list.
 */

export interface Scenario {
  name: string;
  title: string;
  description: string;
  /** Real-world incident this is modelled on, cited in the report. */
  reference: string;
  /** UTC instant the compromise goes live, as an ISO string. */
  anchorIso: string;
  windowMinutes: number;
  /** Malicious artifacts published across the window, per the real incident. */
  artifactCount: number;
  /** Packages the worm reaches, per the real incident. */
  propagationTargets: number;
  /** Traversal depth over MAINTAINS. Each pair of hops is one more round of
   *  "publish to this account's packages, harvest the co-maintainers'
   *  credentials, repeat". Must be even to land on a Package. */
  propagationHops: number;
  /** How many repos get a lockfile capture planted inside the window. */
  plantRepoCount: number;
  /** Preferred packages to seed the compromise on, most wanted first. */
  preferredPackages: string[];
  from(now: number): number;
  to(now: number): number;
}

function windowFor(anchorIso: string, minutes: number) {
  const anchor = Date.parse(anchorIso);
  return {
    from(now: number): number {
      // If the simulated clock predates the anchor, slide the incident to sit a
      // few hours before "now" so the scenario is always in the past.
      return now >= anchor + minutes * 60_000 ? anchor : now - 3 * 3_600_000;
    },
    to(now: number): number {
      return this.from(now) + minutes * 60_000;
    },
  };
}

const TANSTACK_ANCHOR = '2026-08-14T09:00:00Z';
const tanstackWindow = windowFor(TANSTACK_ANCHOR, 6);

export const TANSTACK_WORM_2026: Scenario = {
  name: 'tanstack-worm-2026',
  title: 'TanStack-style self-propagating npm worm',
  description:
    'A maintainer account is compromised and publishes a malicious version. The payload ' +
    'harvests credentials from the build environment, persists into agent config directories ' +
    '(.claude/, .vscode/), and republishes itself through every other package the stolen ' +
    'credentials can reach — spreading across dozens of packages inside a six-minute window ' +
    'before the registry pulls the artifacts.',
  reference:
    'Modelled on the May 2026 TanStack npm/PyPI worm: 84 malicious artifacts across 42 ' +
    'packages within ~6 minutes, self-propagating via maintainer credentials, with 160+ ' +
    'packages and downstream organisations affected.',
  anchorIso: TANSTACK_ANCHOR,
  windowMinutes: 6,
  artifactCount: 84,
  propagationTargets: 42,
  propagationHops: 6,
  plantRepoCount: 9,
  // Real, widely-depended-on packages, ordered so the first choice is one that
  // sits *inside* other packages' dependency trees rather than at the top of
  // them. A package the org depends on directly would make every exposure
  // depth 1; `debug` and friends are reached transitively, which is both the
  // realistic case and the one worth showing.
  preferredPackages: [
    'npm:debug',
    'npm:ms',
    'npm:graceful-fs',
    'npm:semver',
    'npm:ansi-styles',
    'npm:supports-color',
    'npm:color-name',
    'npm:left-pad',
    'npm:chalk',
  ],
  from: tanstackWindow.from,
  to: tanstackWindow.to,
};

const EVENT_STREAM_ANCHOR = '2026-08-14T09:00:00Z';
const eventStreamWindow = windowFor(EVENT_STREAM_ANCHOR, 45);

/** A slower, quieter compromise — the opposite profile to the worm, useful for
 *  showing that the window length is what changes the answer, not the tool. */
export const SLOW_BURN: Scenario = {
  name: 'slow-burn',
  title: 'Single-package compromise with a long live window',
  description:
    'One package version is backdoored and stays live for 45 minutes before removal. No ' +
    'self-propagation. Far more lockfiles resolve it, because the window is long enough for ' +
    'ordinary CI traffic to pick it up.',
  reference:
    'Modelled on the event-stream/flatmap-stream pattern: a single dependency quietly ' +
    'backdoored via a handed-over maintainer account.',
  anchorIso: EVENT_STREAM_ANCHOR,
  windowMinutes: 45,
  artifactCount: 1,
  propagationTargets: 0,
  propagationHops: 2,
  plantRepoCount: 12,
  preferredPackages: ['npm:ms', 'npm:debug', 'npm:left-pad', 'npm:chalk'],
  from: eventStreamWindow.from,
  to: eventStreamWindow.to,
};

export const SCENARIOS: Scenario[] = [TANSTACK_WORM_2026, SLOW_BURN];
export const DEFAULT_SCENARIO = TANSTACK_WORM_2026;

export function findScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.name === name);
}
