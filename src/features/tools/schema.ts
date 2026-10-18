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

/**
 * A tool's parameters as OpenAI models fill them best: every field required, the optional ones nullable.
 * Left optional, they fill every field with a placeholder (a note at 0 0 0). Mastra's own layer does the
 * same but repeats each description and spells out constraints, a third more tokens; tools that use this
 * pass strict: false so that layer stays out. Zod still checks what comes back, once the nulls are gone.
 */
export const forModel = <T extends z.ZodType>(schema: T): T => {
  const json = requireAll(z.toJSONSchema(schema, { io: "input", target: "draft-07" }) as Json);
  delete json.$schema;
  const standard = {
    "~standard": {
      version: 1,
      vendor: "allay",
      validate: (value: unknown) => schema["~standard"].validate(withoutNulls(value)),
      jsonSchema: { input: () => json, output: () => json },
    },
  };
  // Typed as the Zod schema so tools keep their inferred input; at run time only "~standard" is used.
  return standard as unknown as T;
};
