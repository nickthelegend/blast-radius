/**
 * HydraDB HTTP client.
 *
 * Every shape in this file was verified against a live `graph-node`
 * (ghcr.io/hydra-db/hydradb:latest) rather than inferred from documentation.
 * See `docs/hydradb-findings.md` for the probe results that pin each one down.
 *
 * Transport: POST /v1/graphs/{graph_id}/query
 *   headers: Authorization: Bearer <token>, X-Graph-Namespace: <ns>
 *   body:    { cell_id, query, parameters?, consistency?, page_size?, cursor? }
 *   reply:   { query_id, columns, rows: HttpQueryValue[][], read_epoch,
 *              next_cursor, bookmark }
 */

export type Consistency = 'causal' | 'strong';

/** Externally-tagged property value as it appears inside a returned path node. */
type RawProperty =
  | { Integer: number }
  | { SignedInteger: number }
  | { Bool: boolean }
  | { Float: number }
  | { String: string };

/** Internally-tagged column value: `{ type, value }`. */
type RawValue =
  | { type: 'null'; value?: null }
  | { type: 'vertex_id'; value: number }
  | { type: 'integer'; value: number }
  | { type: 'signed_integer'; value: number }
  | { type: 'float'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'string'; value: string }
  | { type: 'list'; value: RawValue[] }
  | { type: 'path'; value: RawPath };

interface RawPath {
  nodes: Array<{ id: number; labels: string[]; properties: Record<string, RawProperty> }>;
  relationships: Array<{
    id: number | null;
    edge_type: string;
    src: number;
    dst: number;
    properties: Record<string, RawProperty>;
  }>;
}

export type PropertyValue = number | string | boolean;

export interface PathNode {
  id: number;
  labels: string[];
  properties: Record<string, PropertyValue>;
}

export interface PathRelationship {
  id: number | null;
  type: string;
  src: number;
  dst: number;
  properties: Record<string, PropertyValue>;
}

/** A whole path as returned by algo.SPpaths / algo.SSpaths / algo.MSpaths. */
export interface GraphPath {
  nodes: PathNode[];
  relationships: PathRelationship[];
}

export type CellValue = PropertyValue | null | GraphPath | CellValue[];

export interface QueryResult {
  columns: string[];
  rows: CellValue[][];
  /** Column-name-keyed view of each row, for readability at call sites. */
  records: Array<Record<string, CellValue>>;
  readEpoch: number | null;
  bookmark: string | null;
  /** Wall-clock milliseconds for the round trip, used in every CLI report. */
  elapsedMs: number;
}

export interface HydraConfig {
  httpUrl: string;
  authToken: string;
  namespace: string;
  graphId: string;
  cellId: string;
  timeoutMs: number;
  defaultConsistency: Consistency;
}

export interface QueryOptions {
  parameters?: Record<string, unknown>;
  consistency?: Consistency;
  /** Retries on 5xx / network failure. Reads are safe to retry; so are the
   *  MERGE-based writes this project issues, which are all idempotent. */
  retries?: number;
  timeoutMs?: number;
}

export class HydraError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly query: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'HydraError';
  }
}

function decodeProperty(raw: RawProperty): PropertyValue {
  if ('String' in raw) return raw.String;
  if ('Integer' in raw) return raw.Integer;
  if ('SignedInteger' in raw) return raw.SignedInteger;
  if ('Float' in raw) return raw.Float;
  if ('Bool' in raw) return raw.Bool;
  throw new Error(`unrecognised HydraDB property encoding: ${JSON.stringify(raw)}`);
}

function decodeProperties(raw: Record<string, RawProperty>): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  for (const [key, value] of Object.entries(raw)) out[key] = decodeProperty(value);
  return out;
}

function decodeValue(raw: RawValue): CellValue {
  switch (raw.type) {
    case 'null':
      return null;
    case 'vertex_id':
    case 'integer':
    case 'signed_integer':
    case 'float':
      return raw.value;
    case 'boolean':
      return raw.value;
    case 'string':
      return raw.value;
    case 'list':
      return raw.value.map(decodeValue);
    case 'path':
      return {
        nodes: raw.value.nodes.map((n) => ({
          id: n.id,
          labels: n.labels,
          properties: decodeProperties(n.properties),
        })),
        relationships: raw.value.relationships.map((r) => ({
          id: r.id,
          type: r.edge_type,
          src: r.src,
          dst: r.dst,
          properties: decodeProperties(r.properties),
        })),
      };
    default: {
      const exhaustive: never = raw;
      throw new Error(`unrecognised HydraDB value: ${JSON.stringify(exhaustive)}`);
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class HydraClient {
  /** Rolling count of queries issued, surfaced by `blastradius doctor`. */
  queryCount = 0;
  totalQueryMs = 0;

  constructor(private readonly config: HydraConfig) {}

  get endpoint(): string {
    return `${this.config.httpUrl.replace(/\/$/, '')}/v1/graphs/${this.config.graphId}/query`;
  }

  async query(cypher: string, options: QueryOptions = {}): Promise<QueryResult> {
    const retries = options.retries ?? 2;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.execute(cypher, options);
      } catch (error) {
        lastError = error;
        // A rejected query (bad Cypher, unsupported feature) is deterministic —
        // retrying it just burns time and hides the real message.
        if (error instanceof HydraError && error.status !== null && error.status < 500) throw error;
        if (attempt < retries) await sleep(250 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  private async execute(cypher: string, options: QueryOptions): Promise<QueryResult> {
    const body: Record<string, unknown> = {
      cell_id: this.config.cellId,
      query: cypher,
      consistency: options.consistency ?? this.config.defaultConsistency,
    };
    if (options.parameters && Object.keys(options.parameters).length > 0) {
      body.parameters = options.parameters;
    }

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = performance.now();

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.authToken}`,
          'X-Graph-Namespace': this.config.namespace,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const reason = error instanceof Error ? error.message : String(error);
      throw new HydraError(
        `HydraDB unreachable at ${this.endpoint}: ${reason}. Is it running? Try \`make db-up\`.`,
        null,
        cypher,
        error,
      );
    } finally {
      clearTimeout(timer);
    }

    const elapsedMs = performance.now() - startedAt;
    const text = await response.text();

    if (!response.ok) {
      let detail: unknown = text;
      let message = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
        detail = parsed;
        if (parsed.error?.message) message = `${parsed.error.code ?? 'error'}: ${parsed.error.message}`;
      } catch {
        /* keep raw text */
      }
      throw new HydraError(`HydraDB rejected query (${response.status}) — ${message}`, response.status, cypher, detail);
    }

    const parsed = JSON.parse(text) as {
      columns: string[];
      rows: RawValue[][];
      read_epoch: number | null;
      bookmark: string | null;
    };

    const rows = parsed.rows.map((row) => row.map(decodeValue));
    const records = rows.map((row) => {
      const record: Record<string, CellValue> = {};
      parsed.columns.forEach((column, index) => {
        record[column] = row[index] ?? null;
      });
      return record;
    });

    this.queryCount += 1;
    this.totalQueryMs += elapsedMs;

    return {
      columns: parsed.columns,
      rows,
      records,
      readEpoch: parsed.read_epoch,
      bookmark: parsed.bookmark,
      elapsedMs,
    };
  }

  /**
   * Batched write via `UNWIND $rows AS row ...`.
   *
   * This is the only sanctioned way to bulk-load HydraDB: one node or edge per
   * statement collapses under an ecosystem-scale dependency graph. The batch
   * form is narrow — the list must arrive as a *parameter* (an inline literal
   * list is rejected), and every row must carry every field the statement
   * reads.
   */
  async batch<T extends Record<string, unknown>>(
    cypher: string,
    rows: readonly T[],
    options: { chunkSize?: number; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<{ written: number; elapsedMs: number; requests: number }> {
    const chunkSize = options.chunkSize ?? 500;
    const startedAt = performance.now();
    let written = 0;
    let requests = 0;

    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const chunk = rows.slice(offset, offset + chunkSize);
      await this.query(cypher, { parameters: { rows: chunk } });
      written += chunk.length;
      requests += 1;
      options.onProgress?.(written, rows.length);
    }

    return { written, elapsedMs: performance.now() - startedAt, requests };
  }

  /** True when graph-node answers /readyz with 200. */
  async ready(adminUrl: string): Promise<boolean> {
    try {
      const response = await fetch(`${adminUrl.replace(/\/$/, '')}/readyz`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async waitUntilReady(adminUrl: string, timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.ready(adminUrl)) return;
      await sleep(1000);
    }
    throw new HydraError(`HydraDB did not become ready within ${timeoutMs}ms`, null, 'readyz');
  }
}
