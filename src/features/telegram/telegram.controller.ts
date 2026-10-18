import { timingSafeEqual } from "node:crypto";
import type { AllayDeps } from "../../agent/allay";
import { logger } from "../../shared/logging/logger";
import { type Billing, sha256 } from "../billing/billing";
import { settings } from "../settings/settings";
import { handleUpdate } from "./telegram.bot";
import { type TelegramApi, type Update, telegramApi } from "./telegram.client";
import { LANGUAGE_CODES, textsOf } from "./telegram.texts";

export const WEBHOOK_PATH = "/api/telegram/webhook";

const ALLOWED_UPDATES = ["message", "callback_query", "pre_checkout_query"];

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** POST /api/telegram/webhook: Telegram's updates, accepted only with the secret token set in setWebhook. */
export const handleTelegram = (deps: AllayDeps) => async (req: Request): Promise<Response> => {
  const { bot } = deps.billing;
  if (req.method !== "POST" || !bot.api || !bot.secret) return new Response(null, { status: 404 });
  if (!same(req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", bot.secret)) return new Response(null, { status: 401 });
  const update = (await req.json().catch(() => undefined)) as Update | undefined;
  if (update) {
    try {
      await handleUpdate(deps.billing, bot.api, update);
    } catch (error) {
      // Telegram retries anything but 200; one bad update must not jam the queue.
      logger.error(`Telegram update ${update.update_id} failed: ${String(error)}`);
    }
  }
  return Response.json({ ok: true });
};

/** The bot's profile and commands in every language it speaks; English is also the default for the rest. */
const describe = async (api: TelegramApi) => {
  for (const code of [undefined, ...LANGUAGE_CODES]) {
    const t = textsOf(code ?? "en");
    const language = code ? { language_code: code } : {};
    await api.call("setMyDescription", { description: t.about, ...language });
    await api.call("setMyShortDescription", { short_description: t.short_about, ...language });
    await api.call("setMyCommands", {
      commands: [
        { command: "status", description: t.command_status },
        { command: "start", description: t.command_start },
      ],
      ...language,
    });
  }
};

/** Each start of the bot; an older polling loop stops once a newer start begins. */
let generation = 0;

/** Long polling for local runs, where Telegram can't reach a webhook. */
const poll = async (billing: Billing, api: TelegramApi, run: number) => {
  let offset = 0;
  while (run === generation) {
    try {
      const updates = await api.call<Update[]>("getUpdates", { offset, timeout: 30, allowed_updates: ALLOWED_UPDATES });
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(billing, api, update).catch((error) => logger.error(`Telegram update ${update.update_id} failed: ${String(error)}`));
      }
    } catch {
      await Bun.sleep(5_000);
    }
  }
};

/**
 * Starts the payment bot when billing is on and TELEGRAM_BOT_TOKEN is set: learns its username for
 * payment links, then takes updates through the webhook at API_URL, or by polling with TELEGRAM_POLLING.
 * Starting again replaces the running bot, as a settings change does.
 */
export const startTelegram = async (billing: Billing) => {
  const run = ++generation;
  if (!billing.enabled) return;
  const token = settings.get("TELEGRAM_BOT_TOKEN");
  if (!token) {
    Object.assign(billing.bot, { api: undefined, secret: undefined, username: undefined });
    logger.warn("Billing is on, but TELEGRAM_BOT_TOKEN is not set: servers can't get payment links");
    return;
  }
  const api = telegramApi(token, { base: settings.get("TELEGRAM_API_URL"), test: settings.get("TELEGRAM_TEST_ENV") });
  // Derived from the token unless set, so there's no second secret to keep.
  const secret = settings.get("TELEGRAM_WEBHOOK_SECRET") || sha256(`allay-webhook:${token}`);
  const me = await api.call<{ username: string }>("getMe");
  if (run !== generation) return;
  Object.assign(billing.bot, { api, secret, username: me.username });
  await describe(api);
  if (settings.get("TELEGRAM_POLLING")) {
    await api.call("deleteWebhook");
    logger.info(`Telegram bot @${me.username} polls for updates`);
    void poll(billing, api, run);
    return;
  }
  const url = `${settings.get("API_URL")}${WEBHOOK_PATH}`;
  await api.call("setWebhook", { url, secret_token: secret, allowed_updates: ALLOWED_UPDATES });
  logger.info(`Telegram bot @${me.username} takes updates at ${url}`);
};

const RESTARTS_BOT = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_POLLING", "TELEGRAM_API_URL", "TELEGRAM_TEST_ENV", "API_URL"];

/** Restarts the bot when a setting it started with changes in the panel. */
export const watchTelegram = (billing: Billing) =>
  settings.onChange((keys) => {
    if (!billing.enabled || !keys.some((key) => RESTARTS_BOT.includes(key))) return;
    logger.info("The bot's settings changed; restarting it");
    void startTelegram(billing).catch((error) => logger.error(`The Telegram bot didn't start: ${String(error)}`));
  });
