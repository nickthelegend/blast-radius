/**
 * Integer id allocation.
 *
 * HydraDB node ids are non-negative integers, so every domain key
 * ("npm:left-pad@3.4.1", "acme-corp/payments-service") needs a stable integer.
 *
 * A hash would be tempting and stateless, but a 53-bit-safe hash over ~100k
 * keys carries a real collision probability, and a collision here silently
 * merges two packages into one node — which would corrupt a blast radius in a
 * way no test would obviously catch. So allocation is a persisted sequential
 * counter instead: collision-free by construction, and stable across re-runs
 * because the map is written next to the snapshot it describes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface IdMapFile {
  version: 1;
  next: number;
  entries: Record<string, number>;
}

export class IdRegistry {
  private entries = new Map<string, number>();
  private reverse = new Map<number, string>();
  private next = 1; // 0 is reserved so "unset" is never a valid node id

  static load(path: string): IdRegistry {
    const registry = new IdRegistry();
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as IdMapFile;
      registry.next = parsed.next;
      for (const [key, id] of Object.entries(parsed.entries)) {
        registry.entries.set(key, id);
        registry.reverse.set(id, key);
      }
    }
    return registry;
  }

  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const payload: IdMapFile = {
      version: 1,
      next: this.next,
      entries: Object.fromEntries([...this.entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    };
    writeFileSync(path, `${JSON.stringify(payload, null, 0)}\n`);
  }

  /** Allocate (or return) the integer id for a namespaced key. */
  id(namespace: string, key: string): number {
    const composite = `${namespace}:${key}`;
    const existing = this.entries.get(composite);
    if (existing !== undefined) return existing;
    const assigned = this.next++;
    this.entries.set(composite, assigned);
    this.reverse.set(assigned, composite);
    return assigned;
  }

  /** Look up without allocating. */
  peek(namespace: string, key: string): number | undefined {
    return this.entries.get(`${namespace}:${key}`);
  }

  keyOf(id: number): string | undefined {
    return this.reverse.get(id);
  }

  get size(): number {
    return this.entries.size;
  }

  packageId = (key: string) => this.id('pkg', key);
  versionId = (key: string) => this.id('ver', key);
  maintainerId = (key: string) => this.id('maint', key);
  orgId = (key: string) => this.id('org', key);
  repoId = (key: string) => this.id('repo', key);
  snapshotId = (key: string) => this.id('snap', key);
}
