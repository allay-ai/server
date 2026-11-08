import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { z } from "zod";
import { estimateTokens, type HistoryMessage } from "../infrastructure/history/history";

type Described = { description?: string; inputSchema?: unknown };

/** A tool's parameters as the provider gets them: our own schemas carry them ready, plain Zod ones are converted. */
const parametersOf = (schema: unknown): unknown => {
  try {
    const ready = (schema as { "~standard"?: { jsonSchema?: { input?: (options?: unknown) => unknown } } })?.["~standard"]?.jsonSchema?.input;
    if (ready) return ready({ target: "draft-07" });
    return schema instanceof z.ZodType ? z.toJSONSchema(schema, { io: "input" }) : {};
  } catch {
    return {};
  }
};

/**
 * What a run's first model step reads, counted with o200k: the instructions, every tool's name, description, and
 * parameters, and the messages. The provider's count of the same step over this is the session's token ratio.
 */
export const promptTokens = (instructions: string, toolsets: Record<string, Record<string, unknown>>, messages: HistoryMessage[]) => {
  const tools = Object.values(toolsets).flatMap((set) =>
    Object.entries(set).map(([name, tool]) => ({ name, description: (tool as Described).description, parameters: parametersOf((tool as Described).inputSchema) })),
  );
  return countTokens(instructions) + countTokens(JSON.stringify(tools)) + estimateTokens(messages);
};
