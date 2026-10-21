import type { ByokProvider } from "../infrastructure/providers/openrouter/openrouter.client";

/** ask answers a question, askx turns a request into commands, task is one wake of an automation agent (since 5.5). */
export type Mode = "ask" | "askx" | "task";
export type Platform = "minecraft" | "telegram";
/** Who sees the answer: only the asker, or every player online (`/askall`). */
export type Visibility = "private" | "public";

export const DIMENSIONS = ["overworld", "the_nether", "the_end"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface PlayerInfo {
  name: string;
  uuid?: string;
  op?: boolean;
  /** Where the player stands when they ask; the model needs it to place “here” and coordinates without a dimension. */
  dimension?: Dimension;
  /** Full privacy: the admin panel knows the player by pseudonym only, without their name, UUID, or face. */
  private?: boolean;
}

export interface ServerInfo {
  /** A random id the plugin keeps for its server; it names the server's shared thread of public questions. */
  id?: string;
  software?: string;
  version?: string;
  plugin_version?: string;
  /** Since 6.6: the address players join with, when the server's owner set one in the plugin, and the game port. */
  address?: string;
  port?: number;
}

export const TASK_KINDS = ["chests", "furnaces", "brewing", "crafting"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** The automation agent a task-mode run wakes; depth 1 is started from the chat, 2 by another agent. */
export interface TaskInfo {
  id: string;
  name: string;
  depth: 1 | 2;
  kind: TaskKind;
}

export const TASK_STATES = ["working", "waiting", "asking"] as const;

/** One of the asker's running automations, as the plugin sees it when they ask. */
export interface RunningTask {
  id: string;
  name: string;
  state: (typeof TASK_STATES)[number];
  /** What the task asked the player, while it waits for an answer. */
  question?: string;
}

/** Everything a run needs to know about who asks and from where. */
export interface RunContext {
  mode: Mode;
  platform: Platform;
  /** Whose server asked: `self` or `license:<id>`. Every piece of player data a run touches belongs to it. */
  tenant: string;
  userId: string;
  message: string;
  locale?: string;
  visibility?: Visibility;
  /** The asker's IANA time zone from the plugin; their real time goes in front of each question. */
  timezone?: string;
  player?: PlayerInfo;
  server?: ServerInfo;
  /** Client tools the plugin offers for this run; empty for v1 requests. */
  tools: string[];
  /** The server's own key and models (BYOK); without it the run uses the backend's. */
  provider?: ByokProvider;
  /** A model for the backend's own key, from the plugin; only a backend with billing off honors it. */
  model?: string;
  /** Task mode: the automation agent this run wakes. */
  task?: TaskInfo;
  /** Ask mode: the asker's running automations, so answers to them can be passed on. */
  tasks?: RunningTask[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost: number;
}

export interface CommandsResult {
  is_sequence: boolean;
  commands: string[];
}

export interface RunResult {
  answer: string;
  commands?: CommandsResult;
  usage: Usage;
  durationMs: number;
}
