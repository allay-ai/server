/**
 * Every setting the backend reads besides where MongoDB and Redis live. Each one keeps the name of the
 * environment variable it came from: a variable that is set wins and locks the field in the admin panel.
 * Descriptions match the wiki's “Admin panel and settings” table; the panel shows them next to each field.
 */

export type SettingGroup = "model" | "search" | "limits" | "sessions" | "tracing" | "billing" | "telegram" | "address" | "access";

export const GROUPS: SettingGroup[] = ["model", "search", "limits", "sessions", "tracing", "billing", "telegram", "address", "access"];

/** Groups that only mean something with billing on; a self-hosted backend hides them. */
export const HOSTED_GROUPS: SettingGroup[] = ["billing", "telegram"];

/** Reads another setting, for a default that follows it. */
export type Getter = (key: string) => unknown;

interface Base {
  group: SettingGroup;
  description: string;
  /** The code reads it once at start. */
  restart?: boolean;
  /** Read from the environment instead of the variable of the same name, for an older form of it. */
  env?: (env: Record<string, string | undefined>) => string | undefined;
}

export interface StringSetting extends Base {
  type: "string" | "url";
  default?: string | ((get: Getter) => string | undefined);
  /** Checked by the panel and the backend alike. */
  pattern?: string;
  max?: number;
}

export interface SecretSetting extends Base {
  type: "secret";
}

export interface NumberSetting extends Base {
  type: "int" | "number";
  default: number | ((get: Getter) => number);
  min: number;
  max: number;
}

export interface EnumSetting extends Base {
  type: "enum";
  options: string[];
  default?: string;
}

export interface BoolSetting extends Base {
  type: "bool";
  default: boolean;
}

export type SettingDefinition = StringSetting | SecretSetting | NumberSetting | EnumSetting | BoolSetting;

const selfHostedEnv = () => ["1", "true", "yes"].includes((process.env.SELFHOSTED || "").toLowerCase());

/** PLAN_STARS=week=1,month=1,year=1 from before 5.7 sets the three prices at once. */
const planStars = (plan: string) => (env: Record<string, string | undefined>) => {
  if (env[`PLAN_${plan.toUpperCase()}_STARS`]) return env[`PLAN_${plan.toUpperCase()}_STARS`];
  const pair = (env.PLAN_STARS || "")
    .split(",")
    .map((p) => p.split("=").map((s) => s.trim()))
    .find(([id]) => id === plan);
  return pair?.[1] || undefined;
};

export const DEFINITIONS = {
  OPENROUTER_API_KEY: { type: "secret", group: "model", description: "OpenRouter key for runs on this backend's own key" },
  OPENROUTER_API_URL: { type: "url", group: "model", default: "https://openrouter.ai/api/v1", description: "OpenRouter API address" },
  OPENROUTER_API_MODEL: {
    type: "string",
    group: "model",
    default: "openai/gpt-6-luna",
    max: 200,
    description: "The agent's model. It must support tool calling: perplexity/sonar* won't do",
  },
  OPENROUTER_REASONING_EFFORT: { type: "enum", group: "model", options: ["low", "medium", "high"], description: "Reasoning effort for models that reason; empty leaves it to the model" },
  API_NAME: { type: "string", group: "model", default: "allay", max: 64, description: "The name OpenRouter shows for this backend's requests" },

  PERPLEXITY_API_KEY: { type: "secret", group: "search", description: "Perplexity's Search API for web search on the backend's own key; without it SEARCH_MODEL searches" },
  SEARCH_MODEL: { type: "string", group: "search", default: "perplexity/sonar", max: 200, description: "Online model for web search without a Perplexity key, and for servers with their own key" },
  OPENROUTER_API_CTX: { type: "enum", group: "search", options: ["low", "medium", "high"], default: "medium", description: "Search context size of the online model" },

  TOOL_TIMEOUT_MS: { type: "int", group: "limits", default: 15_000, min: 1_000, max: 120_000, description: "How long to wait for the plugin's tool result, in milliseconds" },
  MAX_AGENT_STEPS: { type: "int", group: "limits", default: 8, min: 1, max: 50, description: "Model calls per question" },
  MAX_TASK_STEPS: { type: "int", group: "limits", default: 16, min: 1, max: 100, description: "Model calls per wake of an automation agent" },
  MAX_ACTIVE_RUNS: { type: "int", group: "limits", default: 200, min: 1, max: 10_000, description: "Streaming questions at once" },
  SSE_PING_MS: { type: "int", group: "limits", default: 15_000, min: 1_000, max: 120_000, description: "Ping interval that keeps proxies from closing the stream, in milliseconds" },
  CALC_TIMEOUT_MS: { type: "int", group: "limits", default: 1_000, min: 100, max: 10_000, description: "How long exact_calculations gives one expression, in milliseconds" },

  CHAT_TTL_SECONDS: { type: "int", group: "sessions", default: 86_400, min: 60, max: 30 * 86_400, description: "How long a chat session lives after the last question, in seconds" },
  PUBLIC_CHAT_TTL_SECONDS: { type: "int", group: "sessions", default: 7_200, min: 60, max: 30 * 86_400, description: "How long a server's thread of public questions lives after the last one, in seconds" },
  TASK_CHAT_TTL_SECONDS: { type: "int", group: "sessions", default: 7_200, min: 60, max: 30 * 86_400, description: "How long an automation agent's thread lives after its last wake, in seconds" },
  CHAT_FOLD_TOKENS: { type: "int", group: "sessions", default: 32_000, min: 2_000, max: 1_000_000, description: "A session folds into its summary past this many tokens" },
  CHAT_KEEP_TOKENS: { type: "int", group: "sessions", default: 12_000, min: 1_000, max: 1_000_000, description: "About how many tokens of the newest exchanges stay verbatim after a fold" },
  CHAT_MAX_TOKENS: { type: "int", group: "sessions", default: 42_000, min: 2_000, max: 1_000_000, description: "Past this many tokens, a session folds before the answer" },

  TRACE_SAMPLE: {
    type: "number",
    group: "tracing",
    default: () => (selfHostedEnv() ? 1 : 0.1),
    min: 0,
    max: 1,
    restart: true,
    description: "The share of runs traced, 0 turns tracing off; 1 self-hosted, 0.1 hosted by default",
  },
  TRACE_DAYS: { type: "int", group: "tracing", default: 7, min: 1, max: 365, restart: true, description: "How long traces stay, in days" },

  PLAN_WEEK_STARS: { type: "int", group: "billing", default: 150, min: 1, max: 10_000, env: planStars("week"), description: "Price of a week in Stars" },
  PLAN_WEEK_BUDGET: { type: "number", group: "billing", default: 0.75, min: 0, max: 1_000, description: "What a week's runs may cost, in US dollars" },
  PLAN_MONTH_STARS: { type: "int", group: "billing", default: 500, min: 1, max: 10_000, env: planStars("month"), description: "Price of a month in Stars, a subscription that renews every 30 days" },
  PLAN_MONTH_BUDGET: { type: "number", group: "billing", default: 3, min: 0, max: 1_000, description: "What a month's runs may cost, in US dollars" },
  PLAN_YEAR_STARS: { type: "int", group: "billing", default: 10_000, min: 1, max: 10_000, env: planStars("year"), description: "Price of a year in Stars; 10 000 is Telegram's cap" },
  PLAN_YEAR_BUDGET: { type: "number", group: "billing", default: 6, min: 0, max: 1_000, description: "What a year's runs may cost per 30 days, in US dollars" },
  BYOK_PER_MINUTE: { type: "int", group: "billing", default: 20, min: 1, max: 10_000, description: "Questions a minute from a server with its own key" },
  BYOK_PER_DAY: { type: "int", group: "billing", default: 2_000, min: 1, max: 1_000_000, description: "Questions a day from a server with its own key" },
  BYOK_CONCURRENT: { type: "int", group: "billing", default: 4, min: 1, max: 100, description: "Questions at once from a server with its own key" },
  BYOK_ACTIVE_RUNS: {
    type: "int",
    group: "billing",
    default: 100,
    min: 1,
    max: 10_000,
    description: "Questions at once from all servers with their own key together, so free servers can't take every slot from paying ones",
  },
  STAR_USD: { type: "number", group: "billing", default: 0.013, min: 0, max: 1, description: "What a Star brings in US dollars, for the revenue estimates" },

  TELEGRAM_BOT_TOKEN: { type: "secret", group: "telegram", description: "The payment bot's token; without it there are no payment links" },
  TELEGRAM_ADMIN_IDS: {
    type: "string",
    group: "telegram",
    pattern: "^\\s*(\\d+\\s*(,\\s*\\d+\\s*)*)?$",
    max: 500,
    description: "Telegram user ids, comma-separated, that may /refund <charge id> in the bot",
  },
  TELEGRAM_WEBHOOK_SECRET: { type: "secret", group: "telegram", description: "The webhook's secret token; derived from the bot token when empty" },
  TELEGRAM_POLLING: { type: "bool", group: "telegram", default: false, description: "Take updates by long polling instead of the webhook, for local runs" },
  TELEGRAM_API_URL: { type: "url", group: "telegram", default: "https://api.telegram.org", description: "A Bot API server of your own" },
  TELEGRAM_TEST_ENV: { type: "bool", group: "telegram", default: false, description: "Talk to Telegram's test environment" },

  API_URL: { type: "url", group: "address", default: "https://allay.chat", description: "The backend's public address; the Telegram webhook goes to API_URL/api/telegram/webhook" },
  PUBLIC_URL: {
    type: "url",
    group: "address",
    default: (get: Getter) => String(get("API_URL")),
    description: "Where people reach this backend in a browser, with any path prefix; the setup link starts with it. API_URL when empty",
  },

  PLUGIN_TOKEN: {
    type: "secret",
    group: "access",
    description: "Self-hosted: the token every plugin sends as Authorization: Bearer (server.token in its config.yml), at least 24 characters. Without it the backend answers no plugin",
  },
  TRUSTED_PROXIES: {
    type: "string",
    group: "access",
    pattern: "^[0-9A-Fa-f:.,/\\s]*$",
    max: 1000,
    description: "Addresses and CIDR ranges of the reverse proxies in front of the backend, comma-separated; only their forwarding headers count. Empty trusts nobody",
  },
  CLIENT_IP_HEADER: {
    type: "enum",
    group: "access",
    options: ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"],
    default: "x-forwarded-for",
    description: "The header a trusted proxy puts the client's address in",
  },
} satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof DEFINITIONS;

export const KEYS = Object.keys(DEFINITIONS) as SettingKey[];

export const definitionOf = (key: SettingKey): SettingDefinition => DEFINITIONS[key];

/** What `get` returns for a setting of each kind. */
export type ValueOf<K extends SettingKey> = (typeof DEFINITIONS)[K] extends { type: "int" | "number" }
  ? number
  : (typeof DEFINITIONS)[K] extends { type: "bool" }
    ? boolean
    : (typeof DEFINITIONS)[K] extends { default: string | ((get: Getter) => string) }
      ? string
      : (typeof DEFINITIONS)[K] extends { type: "enum"; default: string }
        ? string
        : string | undefined;

export type Value = string | number | boolean;
