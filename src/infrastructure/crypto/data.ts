import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * A player's data as MongoDB keeps it: AES-256-GCM with a random 96-bit IV and a 128-bit tag, base64. The key is
 * derived from the vault's (`vault.derive(DATA_KEY_LABEL)`), so a database dump or a backup alone reads nothing.
 */
export interface Sealed {
  v: 1;
  iv: string;
  data: string;
  tag: string;
}

/** The label the data key is derived under; a new one would mean a new key, so it never changes. */
export const DATA_KEY_LABEL = "player-data v1";

export interface DataCipher {
  seal(value: unknown): Sealed;
  /** Undefined when the value can't be opened: another key, or tampered with. */
  open<T>(sealed: Sealed): T | undefined;
}

export const cipherWith = (key: Buffer): DataCipher => {
  if (key.length !== 32) throw new Error("The data key must be 32 bytes");
  return {
    seal(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      return { v: 1, iv: iv.toString("base64"), data: data.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
    },
    open<T>(sealed: Sealed) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
        decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8")) as T;
      } catch {
        return undefined;
      }
    },
  };
};

export const isSealed = (value: unknown): value is Sealed => {
  const v = value as Partial<Sealed> | null;
  return !!v && typeof v === "object" && v.v === 1 && typeof v.iv === "string" && typeof v.data === "string" && typeof v.tag === "string";
};

// Tests and local runs without a vault seal with a fixed key; the entry point switches to the real one before anything is read.
let current = cipherWith(createHash("sha256").update("test").digest());

/** Switches every store to [key], derived from the vault at start. */
export const useDataKey = (key: Buffer) => {
  current = cipherWith(key);
};

export const sealJson = (value: unknown): Sealed => current.seal(value);

/** What [stored] holds: opened when sealed, as it is when written before 6.9 in the clear. */
export const openJson = <T>(stored: unknown): T | undefined => (isSealed(stored) ? current.open<T>(stored) : (stored as T | undefined));
