import { isSealed, openJson, type Sealed, sealJson } from "../crypto/data";

/** What the panel reads in the clear: numbers and names, never a word of a prompt, an answer, or a tool's data. */
const CLEAR_ATTRIBUTES = ["model", "provider", "usage", "finishReason", "stepIndex", "success"] as const;
const CLEAR_METADATA = ["runId", "environment", "serviceName"] as const;
const CLEAR_ERROR = ["id", "domain", "category"] as const;

type Loose = Record<string, unknown>;

const pick = (from: Loose | null | undefined, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(from ?? {}).filter(([key]) => keys.includes(key)));
const omit = (from: Loose | null | undefined, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(from ?? {}).filter(([key]) => !keys.includes(key)));

/**
 * A span as MongoDB gets it: its input, output, the rest of its attributes and metadata, the error's text, and the
 * request context sealed with the players' data key. Previews of them don't leave at all. What stays in the clear is
 * what the panel's trace view reads: ids, types, names, models, tokens, and whether it worked.
 */
export const sealSpan = <T extends Loose>(span: T): T => {
  const attributes = span.attributes as Loose | undefined;
  const metadata = span.metadata as Loose | undefined;
  const error = span.errorInfo as Loose | undefined;
  const hidden = {
    attributes: omit(attributes, CLEAR_ATTRIBUTES),
    metadata: omit(metadata, CLEAR_METADATA),
    ...(error ? { error: omit(error, CLEAR_ERROR) } : {}),
    ...(span.requestContext ? { requestContext: span.requestContext } : {}),
  };
  return {
    ...span,
    ...(span.input !== undefined ? { input: sealJson(span.input) } : {}),
    ...(span.output !== undefined ? { output: sealJson(span.output) } : {}),
    attributes: { ...pick(attributes, CLEAR_ATTRIBUTES), sealed: sealJson(hidden) },
    ...(metadata ? { metadata: pick(metadata, CLEAR_METADATA) } : {}),
    ...(error ? { errorInfo: pick(error, CLEAR_ERROR) } : {}),
    requestContext: undefined,
    inputPreview: undefined,
    outputPreview: undefined,
    errorPreview: undefined,
  };
};

/** A stored span opened again, for an owner looking into one run; spans from before 6.9 read as they were. */
export const openSpan = (span: Loose) => {
  const attributes = (span.attributes ?? {}) as Loose & { sealed?: Sealed };
  const hidden = attributes.sealed ? (openJson<{ attributes?: Loose; metadata?: Loose; error?: Loose; requestContext?: unknown }>(attributes.sealed) ?? {}) : {};
  const open = (value: unknown) => (isSealed(value) ? (openJson(value) ?? "(can't be opened with this key)") : value);
  return {
    input: open(span.input),
    output: open(span.output),
    attributes: { ...omit(attributes, ["sealed"]), ...hidden.attributes },
    metadata: { ...((span.metadata as Loose | null) ?? {}), ...hidden.metadata },
    error: span.error ? { ...(span.error as Loose), ...hidden.error } : null,
    ...(hidden.requestContext ? { requestContext: hidden.requestContext } : {}),
  };
};
