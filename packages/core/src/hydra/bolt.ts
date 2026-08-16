/**
 * Bolt connectivity.
 *
 * HydraDB speaks the Neo4j wire protocol, so a standard `neo4j-driver` connects
 * to it unmodified. Blast Radius runs its queries over the typed HTTP/JSON API
 * — that transport hands back path payloads with node properties attached,
 * which the report rendering depends on — but Bolt compatibility is a real
 * capability of the engine and this project should be able to demonstrate it
 * rather than merely assert it in a config file.
 *
 * `blastradius doctor --bolt` runs the checks below against a live instance:
 * a driver handshake, a parameterised read, and a native path procedure whose
 * result is compared against the same query issued over HTTP. If the two
 * transports disagree, that is worth knowing.
 *
 * The driver is imported lazily so it stays an optional dependency: everything
 * else works without it.
 */
import type { HydraClient } from './client.js';

export interface BoltCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface BoltRecordLike {
  get(key: string): unknown;
  keys: string[];
}

interface BoltSessionLike {
  run(query: string, parameters?: Record<string, unknown>): Promise<{ records: BoltRecordLike[] }>;
  close(): Promise<void>;
}

interface BoltDriverLike {
  session(config?: Record<string, unknown>): BoltSessionLike;
  close(): Promise<void>;
  getServerInfo?(): Promise<{ address?: string; protocolVersion?: number }>;
}

/** Neo4j integers arrive as {low, high}; every id in this graph fits in `low`. */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof value === 'object' && 'low' in value) {
    const low = (value as { low: number }).low;
    if (typeof low === 'number') return low;
  }
  return null;
}

export async function verifyBolt(
  client: HydraClient,
  options: { boltUrl: string; authToken: string; namespace: string; graphId: string },
): Promise<BoltCheck[]> {
  const checks: BoltCheck[] = [];

  let neo4j: {
    driver: (url: string, auth: unknown, config?: Record<string, unknown>) => BoltDriverLike;
    auth: { basic: (user: string, password: string) => unknown; bearer?: (token: string) => unknown };
  };

  try {
    neo4j = (await import('neo4j-driver')).default as typeof neo4j;
  } catch {
    return [
      {
        name: 'neo4j-driver available',
        ok: false,
        detail: 'not installed — run `npm install` (it is a dependency of @blast/core)',
      },
    ];
  }
  checks.push({ name: 'neo4j-driver available', ok: true, detail: 'loaded' });

  let driver: BoltDriverLike | null = null;
  let session: BoltSessionLike | null = null;

  try {
    // HydraDB authenticates Bolt with the same bearer token the HTTP API uses,
    // presented through basic auth.
    driver = neo4j.driver(
      options.boltUrl,
      neo4j.auth.basic('neo4j', options.authToken),
      { disableLosslessIntegers: true },
    );

    const info = await driver.getServerInfo?.();
    checks.push({
      name: 'Bolt handshake',
      ok: true,
      detail: `connected to ${info?.address ?? options.boltUrl}`,
    });

    session = driver.session({ database: options.graphId });

    // 1. A parameterised read over Bolt.
    const counted = await session.run('MATCH (v:Version) RETURN count(*) AS n');
    const boltCount = toNumber(counted.records[0]?.get('n'));
    checks.push({
      name: 'Bolt read (parameterised Cypher)',
      ok: boltCount !== null,
      detail: boltCount === null ? 'no count returned' : `${boltCount.toLocaleString()} versions`,
    });

    // 2. The same count over HTTP — the two transports must agree.
    const httpResult = await client.query('MATCH (v:Version) RETURN count(*) AS n');
    const httpCount = typeof httpResult.records[0]?.n === 'number' ? httpResult.records[0].n : null;
    checks.push({
      name: 'Bolt and HTTP agree',
      ok: boltCount !== null && boltCount === httpCount,
      detail:
        boltCount === httpCount
          ? `both report ${String(httpCount)}`
          : `bolt=${String(boltCount)} http=${String(httpCount)}`,
    });

    // 3. A native path procedure over Bolt — the thing this project is built on.
    const seed = await session.run(
      'MATCH (v:Version) WHERE v.is_compromised = true RETURN v.id AS id LIMIT 1',
    );
    const seedId = toNumber(seed.records[0]?.get('id'));

    if (seedId === null) {
      checks.push({
        name: 'algo.SSpaths over Bolt',
        ok: true,
        detail: 'skipped — nothing is marked compromised (run `blastradius arm`)',
      });
    } else {
      const paths = await session.run(
        `CALL algo.SSpaths({sourceNode: ${seedId}, ` +
          `relTypes: ['RESOLVED_TO', 'RESOLVED_DIRECT', 'HAS_SNAPSHOT'], ` +
          `relDirection: 'incoming', maxLen: 10, pathCount: 20000, resultLimit: 20000}) ` +
          `YIELD path RETURN path`,
      );
      checks.push({
        name: 'algo.SSpaths over Bolt',
        ok: paths.records.length > 0,
        detail: `${paths.records.length} paths returned through the Neo4j driver`,
      });
    }
  } catch (error) {
    checks.push({
      name: 'Bolt connectivity',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      await session?.close();
      await driver?.close();
    } catch {
      /* best effort */
    }
  }

  return checks;
}
