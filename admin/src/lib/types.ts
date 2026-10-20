export type Role = "owner" | "admin" | "viewer";

export interface Me {
  username: string;
  role: Role;
  env: boolean;
}

export interface State {
  version: string;
  selfhosted: boolean;
  billing: boolean;
  setup: "init" | "log" | null;
  me: Me | null;
}

export type FieldType = "string" | "url" | "secret" | "int" | "number" | "enum" | "bool";

export interface SettingField {
  key: string;
  group: string;
  type: FieldType;
  description: string;
  restart: boolean;
  source: "env" | "stored" | "default";
  options?: string[];
  min?: number;
  max?: number;
  pattern?: string;
  max_length?: number;
  value?: string | number | boolean | null;
  stored?: string | number | boolean | null;
  default?: string | number | boolean | null;
  secret?: { set: boolean; last4: string; broken: boolean };
}

export interface SettingsView {
  version: number;
  updated_at: string | null;
  updated_by: string | null;
  fields: SettingField[];
  environment: { selfhosted: boolean; port: number; mongodb_database: string | null; redis: boolean; secrets_key: "env" | "file"; env_admin: boolean; version: string };
}

export interface Point {
  t: string;
  questions: number;
  errors: number;
  cost: number;
  players: number;
}

export interface Stats {
  range: string;
  step: "hour" | "day";
  series: Point[];
  totals: {
    questions: number;
    errors: number;
    cancelled: number;
    error_rate: number;
    cost: number;
    cost_per_question: number;
    players: number;
    servers: number;
    searches: number;
    input_tokens: number;
    output_tokens: number;
    p50_ms: number | null;
    p95_ms: number | null;
  };
  approximate: boolean;
  kinds: Record<string, number>;
  models: Array<{ name: string; runs: number; cost: number }>;
  tools: Array<{ name: string; calls: number; failed: number }>;
}

export interface Run {
  id: string;
  at: string;
  kind: string;
  payer: "license" | "byok" | "self";
  server: string;
  server_id?: string;
  /** A pseudonym (`p_…`), or `erased`. */
  user_id: string;
  language?: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost: number;
  steps: number;
  tools: Array<{ name: string; ok: boolean }>;
  searches: number;
  duration_ms: number;
  result: "ok" | "cancelled" | "error";
  error_code?: string;
}

export interface PlayerSummary {
  /** A pseudonym (`p_…`), or `erased`. */
  user_id: string;
  language?: string;
  questions: number;
  cost: number;
  first_seen: string;
  last_seen: string;
}

export interface PlayerDetail {
  user_id: string;
  language: string | null;
  questions: number;
  cost: number;
  first_seen: string;
  last_seen: string;
  runs: Run[];
}

export interface ServerSummary {
  server: string;
  server_id?: string;
  payer: string;
  questions: number;
  players: number;
  cost: number;
  last_seen: string;
}

export interface TraceSummary {
  trace_id: string;
  run_id: string | null;
  started_at: string;
  ended_at: string | null;
  ok: boolean;
}

export interface Span {
  span_id: string;
  parent_id: string | null;
  type: string;
  label: string;
  started_at: string;
  ended_at: string | null;
  model?: string;
  provider?: string;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  finish_reason?: string;
  ok: boolean;
}

export interface License {
  id: string;
  name: string;
  created_at: string | null;
  plan: string | null;
  status: "active" | "expired" | "unpaid" | "blocked";
  paid_until: string | null;
  renews: boolean;
  budget: number;
  spent: number;
  used_percent: number;
  resets_at: string | null;
  telegram_user_id: number | null;
  language: string | null;
  last_payment_at: string | null;
  stopped_at: string | null;
  blocked_at: string | null;
}

export interface Payment {
  charge_id: string;
  license: string;
  plan: string;
  stars: number;
  telegram_user_id: number;
  at: string;
  recurring: boolean;
  refunded_at: string | null;
}

export interface Revenue {
  range: string;
  by: "week" | "month";
  star_usd: number;
  series: Array<{ period: string; stars: number; refunded: number; payments: number; renewals: number; refunds: number; usd: number }>;
  totals: { payments: number; stars: number; refunded: number; net_stars: number; usd: number; renewals: number; refunds: number; cancellations: number; license_cost: number };
}

export interface Account {
  username: string;
  role: Role;
  env: boolean;
  created_at: string | null;
  created_by: string | null;
  last_login_at: string | null;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  target?: string;
  changes?: Array<{ field: string; old: string; new: string }>;
  ip?: string;
}
