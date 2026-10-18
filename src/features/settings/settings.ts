import { logger } from "../../shared/logging/logger";
import type { SealedSecret, Vault } from "../../infrastructure/settings/secrets";
import { testVault } from "../../infrastructure/settings/secrets";
import { type SettingsStore, type StoredSettings, memorySettings } from "../../infrastructure/settings/store";
import { DEFINITIONS, KEYS, type SettingDefinition, type SettingKey, type Value, type ValueOf } from "./settings.definitions";

export type Source = "env" | "stored" | "default";

type Parsed = { ok: true; value: Value | undefined } | { ok: false; error: string };

const TRUE = ["1", "true", "yes", "on"];
const FALSE = ["0", "false", "no", "off"];

/** A value from the environment (always a string) or the panel (typed JSON) as its setting's type; empty means unset. */
export const parseValue = (definition: SettingDefinition, raw: unknown): Parsed => {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return { ok: true, value: undefined };
  switch (definition.type) {
    case "int":
    case "number": {
      const value = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(value)) return { ok: false, error: "not a number" };
      if (definition.type === "int" && !Number.isInteger(value)) return { ok: false, error: "not a whole number" };
      if (value < definition.min || value > definition.max) return { ok: false, error: `must be ${definition.min}–${definition.max}` };
      return { ok: true, value };
    }
    case "bool": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      const text = String(raw).trim().toLowerCase();
      if (TRUE.includes(text)) return { ok: true, value: true };
      if (FALSE.includes(text)) return { ok: true, value: false };
      return { ok: false, error: "not true or false" };
    }
    case "enum": {
      const text = String(raw).trim();
      return definition.options.includes(text) ? { ok: true, value: text } : { ok: false, error: `must be one of ${definition.options.join(", ")}` };
    }
    case "url": {
      const text = String(raw).trim();
      try {
        const url = new URL(text);
        if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "must be an http or https URL" };
      } catch {
        return { ok: false, error: "not a URL" };
      }
      return { ok: true, value: text.replace(/\/+$/, "") };
    }
    case "string":
    case "secret": {
      if (typeof raw !== "string") return { ok: false, error: "not text" };
      const text = raw.trim();
      if (definition.type === "string" && definition.max && text.length > definition.max) return { ok: false, error: `at most ${definition.max} characters` };
      if (definition.type === "string" && definition.pattern && !new RegExp(definition.pattern).test(text)) return { ok: false, error: "doesn't match the expected form" };
      return { ok: true, value: text };
    }
  }
};

/** Rules between settings, and the ones the code needs beyond a single field. */
export const crossCheck = (get: (key: SettingKey) => unknown): Record<string, string> => {
  const errors: Record<string, string> = {};
  const model = String(get("OPENROUTER_API_MODEL") ?? "");
  if (model.startsWith("perplexity/")) errors.OPENROUTER_API_MODEL = "Perplexity models can't call tools; put it into SEARCH_MODEL";
  const keep = Number(get("CHAT_KEEP_TOKENS"));
  const fold = Number(get("CHAT_FOLD_TOKENS"));
  const max = Number(get("CHAT_MAX_TOKENS"));
  if (keep >= fold) errors.CHAT_KEEP_TOKENS = "must be below CHAT_FOLD_TOKENS";
  if (fold > max) errors.CHAT_FOLD_TOKENS = "must not pass CHAT_MAX_TOKENS";
  return errors;
};

export interface Change {
  key: SettingKey;
  /** Secrets appear masked: “set …abcd” or “unset”. */
  old: string;
  new: string;
}

export type UpdateResult =
  | { ok: true; version: number; changes: Change[] }
  | { ok: false; code: "CONFLICT" | "INVALID" | "LOCKED" | "VAULT"; errors?: Record<string, string>; message: string };

const shown = (key: SettingKey, value: unknown, sealed?: SealedSecret): string => {
  if (DEFINITIONS[key].type === "secret") return value === undefined || value === "" ? "unset" : `set …${sealed?.last4 ?? ""}`;
  return value === undefined ? "unset" : String(value);
};

/**
 * Settings as the code reads them: the environment when a variable is set, the panel's stored value
 * otherwise, the default last. Reads are synchronous and live: a save applies to the next read.
 */
export class Settings {
  private stored: StoredSettings = { version: 0, values: {}, secrets: {} };
  /** Stored secrets, opened once at load. */
  private opened = new Map<SettingKey, string>();
  /** Stored secrets the current key can't open. */
  private broken = new Set<SettingKey>();
  private listeners: Array<(keys: SettingKey[]) => void> = [];

  constructor(
    private store: SettingsStore = memorySettings(),
    private vault: Vault = testVault(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Switches to the real store and vault and reads what's saved. */
  async attach(store: SettingsStore, vault: Vault) {
    this.store = store;
    this.vault = vault;
    await this.reload();
  }

  async reload() {
    const stored = await this.store.load();
    const opened = new Map<SettingKey, string>();
    const broken = new Set<SettingKey>();
    for (const [key, sealed] of Object.entries(stored.secrets)) {
      if (!(key in DEFINITIONS)) continue;
      try {
        const plain = await this.vault.open(sealed);
        if (plain === undefined) broken.add(key as SettingKey);
        else opened.set(key as SettingKey, plain);
      } catch (error) {
        broken.add(key as SettingKey);
        logger.warn(`Couldn't open the stored ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const key of broken) logger.warn(`The stored ${key} can't be opened with the current key; set it again in the panel`);
    this.stored = stored;
    this.opened = opened;
    this.broken = broken;
  }

  onChange(listener: (keys: SettingKey[]) => void) {
    this.listeners.push(listener);
  }

  /** The variable's raw text, when it's set and not empty. */
  envText(key: SettingKey): string | undefined {
    const definition = DEFINITIONS[key] as SettingDefinition;
    const raw = definition.env ? definition.env(this.env) : this.env[key];
    return raw && raw.trim() ? raw : undefined;
  }

  private fromEnv(key: SettingKey): Value | undefined {
    const raw = this.envText(key);
    if (raw === undefined) return undefined;
    const parsed = parseValue(DEFINITIONS[key], raw);
    if (parsed.ok) return parsed.value;
    logger.warn(`Ignoring ${key} from the environment: ${parsed.error}`);
    return undefined;
  }

  private fromStore(key: SettingKey): Value | undefined {
    if (DEFINITIONS[key].type === "secret") return this.opened.get(key);
    return this.stored.values[key];
  }

  private fallback(key: SettingKey): Value | undefined {
    const definition = DEFINITIONS[key] as SettingDefinition;
    const value = "default" in definition ? definition.default : undefined;
    return typeof value === "function" ? (value as (get: (key: string) => unknown) => Value | undefined)((other) => this.get(other as SettingKey)) : value;
  }

  get<K extends SettingKey>(key: K): ValueOf<K> {
    return (this.fromEnv(key) ?? this.fromStore(key) ?? this.fallback(key)) as ValueOf<K>;
  }

  source(key: SettingKey): Source {
    if (this.fromEnv(key) !== undefined) return "env";
    if (this.fromStore(key) !== undefined) return "stored";
    return "default";
  }

  get version() {
    return this.stored.version;
  }

  /** Everything the panel shows: each field's value (never a secret's), where it comes from, and how to edit it. */
  view() {
    return {
      version: this.stored.version,
      updated_at: this.stored.updated_at?.toISOString() ?? null,
      updated_by: this.stored.updated_by ?? null,
      fields: KEYS.map((key) => {
        const definition = DEFINITIONS[key] as SettingDefinition;
        const source = this.source(key);
        const fallback = this.fallback(key);
        const common = {
          key,
          group: definition.group,
          type: definition.type,
          description: definition.description,
          restart: !!definition.restart,
          source,
          ...("options" in definition ? { options: definition.options } : {}),
          ...("min" in definition ? { min: definition.min, max: definition.max } : {}),
          ...("pattern" in definition && definition.pattern ? { pattern: definition.pattern } : {}),
          ...(definition.type === "string" && definition.max ? { max_length: definition.max } : {}),
        };
        if (definition.type === "secret") {
          const value = this.get(key) as string | undefined;
          return {
            ...common,
            secret: {
              set: !!value,
              last4: source === "env" ? (value && value.length > 8 ? value.slice(-4) : "") : (this.stored.secrets[key]?.last4 ?? ""),
              broken: this.broken.has(key),
            },
          };
        }
        return { ...common, value: this.get(key) ?? null, stored: this.stored.values[key] ?? null, default: fallback ?? null };
      }),
    };
  }

  /**
   * Saves the panel's changes: a value sets the field, null clears it back to the default. Secrets come as
   * plain text once and are sealed before they reach MongoDB. Fields the environment sets can't change here.
   */
  async update(changes: Record<string, unknown>, expected: number, actor: string): Promise<UpdateResult> {
    if (expected !== this.stored.version) return { ok: false, code: "CONFLICT", message: "Someone saved the settings in the meantime; reload them" };
    const errors: Record<string, string> = {};
    const values = { ...this.stored.values };
    const secrets = { ...this.stored.secrets };
    const plainSecrets = new Map(this.opened);
    const touched: SettingKey[] = [];
    for (const [name, raw] of Object.entries(changes)) {
      if (!(name in DEFINITIONS)) {
        errors[name] = "unknown setting";
        continue;
      }
      const key = name as SettingKey;
      if (this.source(key) === "env") {
        errors[key] = "set by the environment";
        continue;
      }
      const parsed = parseValue(DEFINITIONS[key], raw);
      if (!parsed.ok) {
        errors[key] = parsed.error;
        continue;
      }
      touched.push(key);
      if (DEFINITIONS[key].type === "secret") {
        if (parsed.value === undefined) {
          delete secrets[key];
          plainSecrets.delete(key);
        } else {
          try {
            secrets[key] = await this.vault.seal(String(parsed.value));
          } catch (error) {
            return { ok: false, code: "VAULT", message: error instanceof Error ? error.message : String(error) };
          }
          plainSecrets.set(key, String(parsed.value));
        }
      } else if (parsed.value === undefined) {
        delete values[key];
      } else {
        values[key] = parsed.value;
      }
    }
    if (Object.keys(errors).length) {
      const locked = Object.values(errors).every((e) => e === "set by the environment");
      return { ok: false, code: locked ? "LOCKED" : "INVALID", errors, message: "Some settings aren't valid" };
    }
    const next = (key: SettingKey) => this.fromEnv(key) ?? (DEFINITIONS[key].type === "secret" ? plainSecrets.get(key) : values[key]) ?? this.fallback(key);
    // Only what this save touches: a rule the environment already breaks shouldn't block an unrelated field.
    const sessions = touched.some((key) => key.startsWith("CHAT_"));
    const relevant = Object.entries(crossCheck(next)).filter(([key]) => touched.includes(key as SettingKey) || (sessions && key.startsWith("CHAT_")));
    if (relevant.length) return { ok: false, code: "INVALID", errors: Object.fromEntries(relevant), message: "Some settings aren't valid" };
    const diff: Change[] = touched
      .map((key) => ({
        key,
        old: shown(key, this.fromStore(key), this.stored.secrets[key]),
        new: shown(key, DEFINITIONS[key].type === "secret" ? plainSecrets.get(key) : values[key], secrets[key]),
        same: DEFINITIONS[key].type === "secret" ? plainSecrets.get(key) === this.opened.get(key) : values[key] === this.stored.values[key],
      }))
      .filter((change) => !change.same)
      .map(({ same: _, ...change }) => change);
    if (!diff.length) return { ok: true, version: this.stored.version, changes: [] };
    const saved: StoredSettings = { version: this.stored.version + 1, values, secrets, updated_at: new Date(), updated_by: actor };
    if (!(await this.store.save(saved, expected))) return { ok: false, code: "CONFLICT", message: "Someone saved the settings in the meantime; reload them" };
    this.stored = saved;
    this.opened = plainSecrets;
    for (const change of diff) this.broken.delete(change.key);
    this.notify(diff.map((change) => change.key));
    return { ok: true, version: saved.version, changes: diff };
  }

  /** Copies every variable the environment sets into the stored settings, so the variables can go. */
  async importEnv(actor: string): Promise<UpdateResult> {
    const changes: Record<string, unknown> = {};
    for (const key of KEYS) {
      const value = this.fromEnv(key);
      if (value !== undefined) changes[key] = value;
    }
    // The environment still wins until its variables are removed, so these are written past the lock.
    const values = { ...this.stored.values };
    const secrets = { ...this.stored.secrets };
    const plainSecrets = new Map(this.opened);
    const diff: Change[] = [];
    for (const [name, value] of Object.entries(changes)) {
      const key = name as SettingKey;
      if (DEFINITIONS[key].type === "secret") {
        if (plainSecrets.get(key) === value) continue;
        try {
          secrets[key] = await this.vault.seal(String(value));
        } catch (error) {
          return { ok: false, code: "VAULT", message: error instanceof Error ? error.message : String(error) };
        }
        diff.push({ key, old: shown(key, plainSecrets.get(key), this.stored.secrets[key]), new: shown(key, value, secrets[key]) });
        plainSecrets.set(key, String(value));
      } else {
        if (values[key] === value) continue;
        diff.push({ key, old: shown(key, values[key]), new: shown(key, value) });
        values[key] = value as Value;
      }
    }
    if (!diff.length) return { ok: true, version: this.stored.version, changes: [] };
    const saved: StoredSettings = { version: this.stored.version + 1, values, secrets, updated_at: new Date(), updated_by: actor };
    if (!(await this.store.save(saved, this.stored.version))) return { ok: false, code: "CONFLICT", message: "Someone saved the settings in the meantime; reload them" };
    this.stored = saved;
    this.opened = plainSecrets;
    for (const change of diff) this.broken.delete(change.key);
    return { ok: true, version: saved.version, changes: diff };
  }

  private notify(keys: SettingKey[]) {
    for (const listener of this.listeners) {
      try {
        listener(keys);
      } catch (error) {
        logger.warn(`A settings listener failed: ${String(error)}`);
      }
    }
  }
}

/** The one instance the code reads. It starts empty, as in tests; the entrypoint attaches MongoDB. */
export const settings = new Settings();
