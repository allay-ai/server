/**
 * Why a tool call failed, as one word from a fixed list, so the panel and the `runs` collection can count causes
 * without keeping a word of what a tool said. October's failures could only be read by opening players' traces.
 */
export const FAILURE_CODES = [
  "invalid_args",
  "wrong_agent",
  "no_plan",
  "changed",
  "too_far",
  "unknown_name",
  "no_station",
  "empty_slot",
  "wrong_item",
  "no_task",
  "not_allowed",
  "unavailable",
  "no_player",
  "timeout",
  "cancelled",
  "crashed",
  "other",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** The plugin's and the backend's own refusals, by what they say; first match wins. */
const PATTERNS: ReadonlyArray<[RegExp, FailureCode]> = [
  [/Tool input validation failed/i, "invalid_args"],
  [/needs its own, started with start_task|only reads chests/i, "wrong_agent"],
  [/no plan to apply/i, "no_plan"],
  [/changed since|changed meanwhile|meanwhile/i, "changed"],
  [/^no (item|potion|structure|biome|enchantment) called|unknown (item|potion)/i, "unknown_name"],
  [/no (crafting table|smithing table|stonecutter|anvil|grindstone|furnace|brewing stand|water)/i, "no_station"],
  [/farther than|out of reach|in plain sight|blocks of the player/i, "too_far"],
  [/slot \d+ of \w+ is empty|is empty$/i, "empty_slot"],
  [/can't go onto|hold the item|isn't an? /i, "wrong_item"],
  [/no running automation|no such task|task limit/i, "no_task"],
  [/permission|switched off|operators only|not allowed|someone's claim/i, "not_allowed"],
  [/isn't available on this server|not supported/i, "unavailable"],
  [/there is no player|from the console|went offline|is offline/i, "no_player"],
  [/timed out|timeout|didn't answer/i, "timeout"],
  [/^cancel+ed$|aborted/i, "cancelled"],
  [/Exception|failed: /, "crashed"],
];

/** The code for a failed call's result: `{ error: "…" }` from tools, `{ error: true, message }` from the schema. */
export const failureCode = (result: unknown): FailureCode => {
  const body = result && typeof result === "object" ? (result as { error?: unknown; message?: unknown }) : { error: result };
  const text = [body.error, body.message].filter((part) => typeof part === "string").join(" ");
  return PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ?? "other";
};
