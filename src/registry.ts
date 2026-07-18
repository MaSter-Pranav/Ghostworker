import { createHash, randomUUID } from "node:crypto";

export type JsonRecord = Record<string, unknown>;
export type AdapterFunction = (payload: JsonRecord) => JsonRecord;

export interface IntegrationAdapter {
  integrationId: string;
  code: string;
  execute: AdapterFunction;
  revision: number;
  updatedAt: string;
}

export interface HealingLog {
  id: string;
  integrationId: string;
  timestamp: string;
  outcome: "healed" | "rejected" | "failed";
  diagnostic: string;
  errorLog: string;
  model: string;
}

export interface DiffRecord {
  id: string;
  integrationId: string;
  revision: number;
  createdAt: string;
  previousHash: string;
  nextHash: string;
}

const hashCode = (code: string): string =>
  createHash("sha256").update(code, "utf8").digest("hex");

export class IntegrationRegistry {
  private readonly adapters = new Map<string, IntegrationAdapter>();
  private readonly healingLogs: HealingLog[] = [];
  private readonly diffs: DiffRecord[] = [];

  register(integrationId: string, code: string, execute: AdapterFunction): IntegrationAdapter {
    if (!integrationId.trim()) throw new Error("integrationId must not be blank");
    if (this.adapters.has(integrationId)) throw new Error(`Integration already exists: ${integrationId}`);

    const adapter: IntegrationAdapter = {
      integrationId,
      code,
      execute,
      revision: 1,
      updatedAt: new Date().toISOString(),
    };
    this.adapters.set(integrationId, adapter);
    return adapter;
  }

  get(integrationId: string): IntegrationAdapter | undefined {
    return this.adapters.get(integrationId);
  }

  hotSwap(integrationId: string, code: string, execute: AdapterFunction): IntegrationAdapter {
    const current = this.adapters.get(integrationId);
    if (!current) throw new Error(`Unknown integration: ${integrationId}`);

    const next: IntegrationAdapter = {
      integrationId,
      code,
      execute,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.adapters.set(integrationId, next);
    this.diffs.unshift({
      id: randomUUID(),
      integrationId,
      revision: next.revision,
      createdAt: next.updatedAt,
      previousHash: hashCode(current.code),
      nextHash: hashCode(code),
    });
    return next;
  }

  recordHealing(log: Omit<HealingLog, "id" | "timestamp">): HealingLog {
    const entry: HealingLog = { id: randomUUID(), timestamp: new Date().toISOString(), ...log };
    this.healingLogs.unshift(entry);
    this.healingLogs.splice(100);
    return entry;
  }

  status(): { activeRoutes: Omit<IntegrationAdapter, "execute">[]; healingLogs: HealingLog[]; diffs: DiffRecord[] } {
    return {
      activeRoutes: [...this.adapters.values()].map(({ execute: _execute, ...adapter }) => adapter),
      healingLogs: [...this.healingLogs],
      diffs: [...this.diffs],
    };
  }
}
