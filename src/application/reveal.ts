import { connect, disconnect } from "../infrastructure/database/mongodb.client";
import { DATA_KEY_LABEL, useDataKey } from "../infrastructure/crypto/data";
import { mongoAudit } from "../infrastructure/admin/audit";
import { mongoTraces } from "../infrastructure/observability/traces";
import { mongoRuns } from "../infrastructure/runs/runs";
import { productionVault } from "../infrastructure/settings/secrets";

const USAGE = `Opens one run's trace, to look into a problem a player or a server reported, inside the backend's container:

  bun run dist/application/reveal.js <run id>

It prints the prompt, the answer, and every tool call with its arguments and result as JSON, and writes run.reveal with
the actor cli to the audit log, as the panel's “Show text” does. Nothing else reads players' words.`;

const main = async (args: string[]) => {
  const [runId] = args;
  if (!runId || !/^[0-9a-f-]{36}$/.test(runId)) {
    console.log(USAGE);
    return runId ? 2 : 0;
  }
  await connect();
  try {
    useDataKey(await productionVault().derive(DATA_KEY_LABEL));
    const run = await mongoRuns.get(runId);
    if (!run) {
      console.log("No such run");
      return 1;
    }
    const spans = await mongoTraces.reveal(runId);
    if (!spans) {
      console.log("This run has no trace: traces live TRACE_DAYS days");
      return 1;
    }
    await mongoAudit.add({ at: new Date(), actor: "cli", action: "run.reveal", target: `${run.server} ${run.user_id} ${run.id}` });
    console.log(JSON.stringify({ run_id: run.id, spans }, null, 2));
    return 0;
  } finally {
    await disconnect();
  }
};

process.exitCode = await main(process.argv.slice(2));
