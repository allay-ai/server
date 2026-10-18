import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../../shared/logging/logger";

/** A secret as MongoDB keeps it: AES-256-GCM, plus its last four characters for the panel. */
export interface SealedSecret {
  iv: string;
  data: string;
  tag: string;
  last4: string;
}

/** Turns secrets into what MongoDB may hold and back. */
export interface Vault {
  seal(plain: string): Promise<SealedSecret>;
  /** Undefined when the key changed since the secret was stored. */
  open(sealed: SealedSecret): Promise<string | undefined>;
}

export const SECRETS_KEY_FILE = "/data/secrets.key";

export const last4 = (secret: string) => (secret.length > 8 ? secret.slice(-4) : "");

const vaultWith = (key: () => Promise<Buffer>): Vault => ({
  async seal(plain) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", await key(), iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), data: data.toString("base64"), tag: cipher.getAuthTag().toString("base64"), last4: last4(plain) };
  },
  async open(sealed) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", await key(), Buffer.from(sealed.iv, "base64"));
      decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
    } catch {
      return undefined;
    }
  },
});

/** A key file of 32 random bytes, made on first use; it must sit on a volume, or stored secrets die with the container. */
const fileKey = (path: string) => {
  let key: Promise<Buffer> | undefined;
  const load = async () => {
    try {
      const raw = Buffer.from((await readFile(path, "utf8")).trim(), "base64");
      if (raw.length === 32) return raw;
      throw new Error(`${path} doesn't hold a 32-byte key`);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    const fresh = randomBytes(32);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, fresh.toString("base64"), { flag: "wx", mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
    logger.info(`Made a new key for stored secrets at ${path}`);
    return fresh;
  };
  return () => {
    key ??= load().catch((error) => {
      key = undefined;
      throw new Error(`Can't keep secrets: ${error instanceof Error ? error.message : String(error)}`);
    });
    return key;
  };
};

/** SECRETS_KEY, any string, when set; otherwise the key file. */
export const productionVault = (): Vault => {
  const fromEnv = process.env.SECRETS_KEY;
  if (fromEnv) {
    const key = createHash("sha256").update(fromEnv).digest();
    return vaultWith(async () => key);
  }
  return vaultWith(fileKey(process.env.SECRETS_KEY_FILE || SECRETS_KEY_FILE));
};

/** A fixed key, for tests. */
export const testVault = (secret = "test"): Vault => {
  const key = createHash("sha256").update(secret).digest();
  return vaultWith(async () => key);
};
