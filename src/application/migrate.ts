import { connect, disconnect } from "../infrastructure/database/mongodb.client";
import { purgeUntagged, retag, tenantCounts } from "../infrastructure/database/migrations";
import { PSEUDONYM_LABEL, pseudonymsWith } from "../infrastructure/privacy/pseudonyms";
import { dashedUuid, mongoPlayers, restorePlayers } from "../infrastructure/privacy/players";
import { mongoRuns } from "../infrastructure/runs/runs";
import { productionVault } from "../infrastructure/settings/secrets";
import { TENANT } from "../features/auth/caller";

const USAGE = `Moves data between tenants, inside the backend's container:

  bun run dist/application/migrate.js status
  bun run dist/application/migrate.js retag --from self --to license:<id> [--dry-run]
  bun run dist/application/migrate.js purge-untagged
  bun run dist/application/migrate.js players <name>=<uuid> [<name>=<uuid> …]

retag moves memories, deaths, players' state, consents, and runs (and the days' server lists) from one tenant to another and replaces players' ids in
the statistics with pseudonyms under this backend's SECRETS_KEY. Sealed data (since 6.9) opens only under the SECRETS_KEY it was sealed
with: give both backends the same one. purge-untagged deletes memories without a tenant. players
names players who asked before 6.4 in the panel: each UUID's runs give the servers and dates; a UUID without runs changes
nothing.`;

const option = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const main = async (args: string[]) => {
  const [command] = args;
  if (!command || !["status", "retag", "purge-untagged", "players"].includes(command)) {
    console.log(USAGE);
    return command ? 2 : 0;
  }
  const from = option(args, "--from");
  const to = option(args, "--to");
  if (command === "retag" && (!from || !to || !TENANT.test(from) || !TENANT.test(to) || from === to)) {
    console.log("retag needs --from and --to, each `self` or `license:<id>`, and different");
    return 2;
  }
  const named = args.slice(1).map((arg) => {
    const [name, uuid] = arg.split("=");
    return { name: name?.trim() ?? "", userId: dashedUuid(uuid ?? "") };
  });
  if (command === "players" && (!named.length || named.some((p) => !/^\w{1,16}$/.test(p.name) || !p.userId))) {
    console.log("players needs <name>=<uuid> pairs: a Minecraft name and its UUID, with or without dashes");
    return 2;
  }
  await connect();
  try {
    if (command === "status") console.log(JSON.stringify(await tenantCounts(), null, 2));
    if (command === "purge-untagged") console.log(`Deleted ${await purgeUntagged()} memories without a tenant`);
    if (command === "retag") {
      const pseudonyms = pseudonymsWith(await productionVault().derive(PSEUDONYM_LABEL));
      const dryRun = args.includes("--dry-run");
      const result = await retag({ from: from!, to: to!, pseudonyms, dryRun });
      console.log(`${dryRun ? "Would move" : "Moved"} from ${from} to ${to}: ${JSON.stringify(result)}`);
    }
    if (command === "players") {
      const pseudonyms = pseudonymsWith(await productionVault().derive(PSEUDONYM_LABEL));
      const entries = named.map((p) => ({ name: p.name, userId: p.userId! }));
      for (const result of await restorePlayers(entries, { pseudonyms, runs: mongoRuns, players: mongoPlayers })) {
        const where = result.tenants.map((t) => `${t.tenant} ${t.pseudonym}${t.added ? "" : " (known)"}`).join(", ") || "no runs";
        console.log(`${result.name}: ${where}`);
      }
    }
    return 0;
  } finally {
    await disconnect();
  }
};

process.exitCode = await main(process.argv.slice(2));
