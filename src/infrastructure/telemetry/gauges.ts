import type { Attributes, ObservableResult } from "@opentelemetry/api";
import type mongoose from "mongoose";
import { kindOf, quotaOf } from "../../features/billing/plans";
import { logger } from "../../shared/logging/logger";
import type { LicenseStore } from "../billing/licenses";
import type { ServerDirectory } from "../servers/servers";
import { onMeter, signals } from "./signals";

/** Gauges read MongoDB at most this often; Prometheus asks every 15 seconds and the numbers move by the hour. */
const REFRESH_MS = 5 * 60 * 1000;
/** A server counts while it asked within this; the panel's Servers page keeps them longer. */
const ACTIVE_DAYS = 30;

interface Readings {
  servers: Array<{ value: number; attributes: Attributes }>;
  licenses: Array<{ value: number; attributes: Attributes }>;
  budgets: Array<{ value: number; attributes: Attributes }>;
}

const empty = (): Readings => ({ servers: [], licenses: [], budgets: [] });

export interface GaugeSources {
  servers?: ServerDirectory;
  licenses?: LicenseStore;
  now?: () => Date;
}

/** Everything a gauge shows, read in one go: the servers with their names, and each license's plan and spending. */
export const readGauges = async (sources: GaugeSources): Promise<Readings> => {
  const now = sources.now?.() ?? new Date();
  const readings = empty();
  const since = now.getTime() - ACTIVE_DAYS * 86_400_000;
  for (const server of (await sources.servers?.list()) ?? []) {
    if (server.last_seen.getTime() < since) continue;
    // `allay_server_info` names the series of other metrics in Grafana: group_left by tenant and server_id.
    readings.servers.push({
      value: 1,
      attributes: {
        tenant: server.tenant,
        server_id: server.server_id,
        name: server.name ?? "",
        software: server.software ?? "",
        version: server.version ?? "",
        plugin_version: server.plugin_version ?? "",
        loader: server.loader ?? "",
        side: server.side ?? "",
      },
    });
  }
  if (sources.licenses) {
    const counts = new Map<string, { value: number; attributes: Attributes }>();
    for (let skip = 0; ; skip += 200) {
      const { licenses } = await sources.licenses.list({ limit: 200, skip });
      for (const license of licenses) {
        const quota = quotaOf(await sources.licenses.grants(license.id), now);
        const state = license.revoked_at ? "revoked" : license.blocked_at ? "blocked" : quota.active ? "active" : "inactive";
        const attributes = { plan: license.plan ?? "", kind: kindOf(license), state };
        const key = JSON.stringify(attributes);
        counts.set(key, { value: (counts.get(key)?.value ?? 0) + 1, attributes });
        if (quota.active) {
          readings.budgets.push({ value: quota.usedPercent / 100, attributes: { tenant: `license:${license.id}`, plan: license.plan ?? "", kind: kindOf(license), name: license.name ?? "" } });
        }
      }
      if (licenses.length < 200) break;
    }
    readings.licenses = [...counts.values()];
  }
  return readings;
};

const observe = (result: ObservableResult, rows: Readings[keyof Readings]) => {
  for (const row of rows) result.observe(row.value, row.attributes);
};

/**
 * Gauges from MongoDB, refreshed in the background, so a scrape never waits on the database: the servers seen
 * this month, licenses by plan and state, and how much of its budget each paying license has used.
 */
export const watchGauges = (sources: GaugeSources) => {
  let readings = empty();
  const refresh = () =>
    readGauges(sources)
      .then((fresh) => (readings = fresh))
      .catch((error) => logger.warn(`Couldn't read the telemetry gauges: ${String(error)}`));
  void refresh();
  setInterval(refresh, REFRESH_MS).unref();
  onMeter((meter) => {
    meter.createObservableGauge("allay.server.info", { description: "1 for each server seen in the last 30 days, with its name and what it runs" }).addCallback((r) => observe(r, readings.servers));
    meter.createObservableGauge("allay.licenses", { unit: "{license}", description: "Licenses by plan, kind, and state" }).addCallback((r) => observe(r, readings.licenses));
    meter.createObservableGauge("allay.license.budget_used", { unit: "1", description: "The share of its open budget each paying license has spent" }).addCallback((r) => observe(r, readings.budgets));
  });
};

/** The process's memory and how late the event loop runs: a late loop delays every stream at once. */
export const watchProcess = () => {
  let lag = 0;
  let expected = performance.now() + 500;
  setInterval(() => {
    const now = performance.now();
    lag = Math.max(lag, now - expected);
    expected = now + 500;
  }, 500).unref();
  onMeter((meter) => {
    meter.createObservableGauge("process.memory.usage", { unit: "By", description: "Resident memory, and the JavaScript heap used" }).addCallback((result) => {
      const memory = process.memoryUsage();
      result.observe(memory.rss, { "process.memory.type": "rss" });
      result.observe(memory.heapUsed, { "process.memory.type": "heap_used" });
    });
    meter.createObservableGauge("allay.event_loop.lag", { unit: "s", description: "The event loop's worst delay since the last export" }).addCallback((result) => {
      result.observe(lag / 1000);
      lag = 0;
    });
  });
};

/**
 * MongoDB commands' durations, by command and collection, from the driver's command monitoring. Never the
 * command's contents: a filter holds a player's id.
 */
export const watchMongo = (connection: mongoose.Connection) => {
  const client = connection.getClient();
  const started = new Map<number, string>();
  client.on("commandStarted", (event) => {
    const collection = event.command?.[event.commandName];
    started.set(event.requestId, typeof collection === "string" ? collection : "");
  });
  const done = (failed: boolean) => (event: { requestId: number; commandName: string; duration: number }) => {
    const collection = started.get(event.requestId) ?? "";
    started.delete(event.requestId);
    signals().instruments.db.record(event.duration / 1000, {
      "db.system.name": "mongodb",
      "db.operation.name": event.commandName,
      "db.collection.name": collection,
      ...(failed ? { "error.type": "failed" } : {}),
    });
  };
  client.on("commandSucceeded", done(false));
  client.on("commandFailed", done(true));
};
