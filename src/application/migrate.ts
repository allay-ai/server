import { connect, disconnect } from "../infrastructure/database/mongodb.client";
import { purgeUntagged, retag, tenantCounts } from "../infrastructure/database/migrations";
import { PSEUDONYM_LABEL, pseudonymsWith } from "../infrastructure/privacy/pseudonyms";
import { productionVault } from "../infrastructure/settings/secrets";
import { TENANT } from "../features/auth/caller";

const USAGE = `Moves data between tenants, inside the backend's container:

  bun run dist/application/migrate.js status
  bun run dist/application/migrate.js retag --from self --to license:<id> [--dry-run]
  bun run dist/application/migrate.js purge-untagged

retag moves memories, consents, and runs (and the days' server lists) from one tenant to another and replaces players' ids in
the statistics with pseudonyms under this backend's SECRETS_KEY. purge-untagged deletes memories without a tenant.`;

const option = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const main = async (args: string[]) => {
  const [command] = args;
  if (!command || !["status", "retag", "purge-untagged"].includes(command)) {
    console.log(USAGE);
    return command ? 2 : 0;
  }
  const from = option(args, "--from");
  const to = option(args, "--to");
  if (command === "retag" && (!from || !to || !TENANT.test(from) || !TENANT.test(to) || from === to)) {
    console.log("retag needs --from and --to, each `self` or `license:<id>`, and different");
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
    return 0;
  } finally {
    await disconnect();
  }
};

process.exitCode = await main(process.argv.slice(2));
