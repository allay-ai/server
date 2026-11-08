import { z } from "zod";

type Json = Record<string, unknown>;

/** A field the model may leave out: null joins its type, and enum, so it stays one small schema. */
const orNull = (node: Json): Json => {
  if (typeof node.type === "string") return { ...node, type: [node.type, "null"], ...(Array.isArray(node.enum) ? { enum: [...node.enum, null] } : {}) };
  if (Array.isArray(node.anyOf)) return { ...node, anyOf: [...node.anyOf, { type: "null" }] };
  return { anyOf: [node, { type: "null" }] };
};

/** Every field required, the optional ones nullable, all the way down. */
const requireAll = (node: Json): Json => {
  const out: Json = { ...node };
  // Zod bounds every int by the safe range; to the model that's only noise.
  if (out.minimum === Number.MIN_SAFE_INTEGER) delete out.minimum;
  if (out.maximum === Number.MAX_SAFE_INTEGER) delete out.maximum;
  if (out.properties && typeof out.properties === "object") {
    const required = new Set((out.required as string[] | undefined) ?? []);
    out.properties = Object.fromEntries(
      Object.entries(out.properties as Record<string, Json>).map(([key, value]) => [key, required.has(key) ? requireAll(value) : orNull(requireAll(value))]),
    );
    out.required = Object.keys(out.properties as Json);
  }
  if (out.items && typeof out.items === "object") out.items = requireAll(out.items as Json);
  if (Array.isArray(out.anyOf)) out.anyOf = (out.anyOf as Json[]).map(requireAll);
  if (out.additionalProperties && typeof out.additionalProperties === "object") out.additionalProperties = requireAll(out.additionalProperties as Json);
  return out;
};

/** The model's nulls are the fields it left out. */
export const withoutNulls = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, withoutNulls(v)]));
  }
  return value;
};

/** A string the model quoted twice, like "\"inventory\"": the value inside. Anything else as it was. */
const unquoted = (value: unknown): unknown => {
  if (typeof value === "string" && value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const inner = JSON.parse(value);
      if (typeof inner === "string") return inner;
    } catch {}
  }
  if (Array.isArray(value)) return value.map(unquoted);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unquoted(v)]));
  return value;
};

/** A spot at 0 0 0 is the model's placeholder for “none”, never a place it read: none, or the default. */
const isOrigin = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value) && ["x", "y", "z"].every((k) => (value as Record<string, unknown>)[k] === 0);

const withoutOrigins = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const kept = value.filter((item) => !isOrigin(item)).map(withoutOrigins);
    return kept.length || !value.length ? kept : undefined;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => !isOrigin(v));
    // x, y, and z all 0 beside other fields (memories add) are the same placeholder for “no place”.
    const flat = isOrigin(value) && Object.keys(value).length > 3 ? entries.filter(([k]) => !["x", "y", "z"].includes(k)) : entries;
    return Object.fromEntries(flat.map(([k, v]) => [k, withoutOrigins(v)]).filter(([, v]) => v !== undefined));
  }
  return value;
};

/** What a tool sets right in the model's arguments before they're checked: a mode written as the action, a summary too long. */
export type Repair = (args: Record<string, unknown>) => Record<string, unknown>;

/**
 * A tool's parameters as OpenAI models fill them best: every field required, the optional ones nullable.
 * Left optional, they fill every field with a placeholder (a note at 0 0 0). Mastra's own layer does the
 * same but repeats each description and spells out constraints, a third more tokens; tools that use this
 * pass strict: false so that layer stays out. Zod still checks what comes back, once the nulls are gone.
 */
export const forModel = <T extends z.ZodType>(schema: T, repair?: Repair): T => {
  const json = requireAll(z.toJSONSchema(schema, { io: "input", target: "draft-07" }) as Json);
  delete json.$schema;
  // A third of the tools' failures in October were arguments one step from right; set those right instead of refusing.
  const ready = (value: unknown) => {
    const args = withoutOrigins(unquoted(withoutNulls(value)));
    return repair && args && typeof args === "object" && !Array.isArray(args) ? repair(args as Record<string, unknown>) : args;
  };
  const standard = {
    "~standard": {
      version: 1,
      vendor: "allay",
      validate: (value: unknown) => schema["~standard"].validate(ready(value)),
      jsonSchema: { input: () => json, output: () => json },
    },
  };
  // Typed as the Zod schema so tools keep their inferred input; at run time only "~standard" is used.
  return standard as unknown as T;
};
