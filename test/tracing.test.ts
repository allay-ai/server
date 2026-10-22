import { expect, test } from "bun:test";
import mongoose from "mongoose";
import { Agent } from "@mastra/core/agent";
import { tracing } from "../src/infrastructure/observability/tracing";
import { mongoTraces } from "../src/infrastructure/observability/traces";
import { finish, scripted, text } from "./helpers";

/** Through Mastra's own exporter and MongoDB store, when ALLAY_TEST_MONGODB points at a throwaway database. */
const MONGODB = process.env.ALLAY_TEST_MONGODB;
test.if(!!MONGODB)("Mastra stores spans sealed, and reveal opens them", async () => {
  await mongoose.connect(MONGODB!);
  const mastra = tracing(MONGODB!.replace(/\/[^/]*$/, "/"), mongoose.connection.db!.databaseName)!;
  const { model } = scripted([[...text("behind the waterfall"), finish()]]);
  const agent = new Agent({ id: "allay", name: "Allay", instructions: "base at 120 64 -300", model });
  agent.__registerMastra(mastra);
  const runId = crypto.randomUUID();
  const stream = await agent.stream([{ role: "user", content: "where is my diamond stash" }], { runId });
  for await (const _ of stream.fullStream) {}
  // The exporter writes in batches; shutting down flushes them.
  await mastra.shutdown?.();
  await Bun.sleep(1500);
  const raw = JSON.stringify(await mongoose.connection.db!.collection("mastra_ai_spans").find({}).toArray());
  expect(raw.length).toBeGreaterThan(100);
  for (const word of ["diamond", "waterfall", "120 64 -300"]) expect(raw).not.toContain(word);
  const spans = await mongoTraces.reveal(runId);
  expect(JSON.stringify(spans)).toContain("diamond");
  expect(JSON.stringify(spans)).toContain("waterfall");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}, 20_000);
