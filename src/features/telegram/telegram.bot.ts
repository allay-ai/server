import type { LicenseRecord } from "../../infrastructure/billing/licenses";
import { logger } from "../../shared/logging/logger";
import { type Billing, quotaFor, serverName, sha256 } from "../billing/billing";
import { type Plan, planOf, plans, windowsFor } from "../billing/plans";
import type { SuccessfulPayment, TelegramApi, TelegramUser, Update } from "./telegram.client";
import { PLAN_NAMES, dateIn, fill, languageOf, textsOf } from "./telegram.texts";

/** Telegram allows only this period for Stars subscriptions: 30 days. */
const SUBSCRIPTION_PERIOD = 2_592_000;

type Button = { text: string; callback_data?: string; url?: string };

const say = (api: TelegramApi, chat: number, text: string, buttons?: Button[][]) =>
  api.call("sendMessage", { chat_id: chat, text, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) });

const planButtons = (language: string, license: LicenseRecord): Button[][] =>
  plans().map((plan) => [
    {
      text: fill(textsOf(language).plan_button, { plan: PLAN_NAMES[languageOf(language)][plan.id], stars: plan.stars }),
      callback_data: `buy:${plan.id}:${license.id}`,
    },
  ]);

const planList = (language: string) => {
  const t = textsOf(language);
  return [t.plans, "", ...plans().map((plan) => `• ${t.plan[plan.id]} — ${plan.stars} ⭐`)].join("\n");
};

const showPlans = (api: TelegramApi, chat: number, language: string, license: LicenseRecord) =>
  say(api, chat, planList(language), planButtons(language, license));

/** /start <claim code>: ties the server to this Telegram account and offers the plans. */
const claim = async (billing: Billing, api: TelegramApi, chat: number, from: TelegramUser, code: string) => {
  const language = languageOf(from.language_code);
  const t = textsOf(language);
  const license = await billing.licenses.claim(sha256(code), billing.now());
  if (!license || license.revoked_at) return say(api, chat, t.claim_failed);
  // The code came from an operator's /allay link, so whoever opens it may take the server over.
  await billing.licenses.update(license.id, { telegram_user_id: from.id, telegram_chat_id: chat, language });
  logger.info(`License ${license.id} claimed in Telegram`);
  await say(api, chat, fill(t.claimed, { server: serverName(license) }));
  return showPlans(api, chat, language, license);
};

/** /status: every server of this account, its period and limit, with buttons to pay or stop renewal. */
const status = async (billing: Billing, api: TelegramApi, chat: number, from: TelegramUser) => {
  const language = languageOf(from.language_code);
  const t = textsOf(language);
  const licenses = (await billing.licenses.ofTelegram(from.id)).filter((l) => !l.revoked_at);
  if (!licenses.length) return say(api, chat, t.status_none);
  const lines = [t.status_title];
  const buttons: Button[][] = [];
  for (const license of licenses) {
    const server = serverName(license);
    const quota = await quotaFor(billing, license);
    if (!quota.active || !quota.paidUntil) {
      lines.push("", fill(t.status_inactive, { server }));
    } else {
      lines.push("", fill(t.status_active, { server, date: dateIn(language, quota.paidUntil) }));
      lines.push(
        quota.remaining > 0 && quota.resetsAt
          ? fill(t.status_quota, { percent: quota.usedPercent, date: dateIn(language, quota.resetsAt) })
          : t.status_quota_spent,
      );
      if (license.renews) lines.push(t.status_renews);
    }
    buttons.push([{ text: fill(t.renew_button, { server }), callback_data: `plans:${license.id}` }]);
    if (license.subscription_charge_id && quota.active) {
      buttons.push([
        license.renews
          ? { text: t.stop_button, callback_data: `stop:${license.id}` }
          : { text: t.resume_button, callback_data: `resume:${license.id}` },
      ]);
    }
  }
  return say(api, chat, lines.join("\n"), buttons);
};

const invoice = async (api: TelegramApi, language: string, license: LicenseRecord, plan: Plan) => {
  const t = textsOf(language);
  const title = t.invoice_title[plan.id];
  return api.call<string>("createInvoiceLink", {
    title,
    description: fill(t.invoice_description[plan.id], { server: serverName(license) }),
    payload: `${plan.id}:${license.id}`,
    currency: "XTR",
    prices: [{ label: title, amount: plan.stars }],
    ...(plan.subscription ? { subscription_period: SUBSCRIPTION_PERIOD } : {}),
  });
};

const callback = async (billing: Billing, api: TelegramApi, query: NonNullable<Update["callback_query"]>) => {
  const language = languageOf(query.from.language_code);
  const t = textsOf(language);
  const chat = query.message?.chat.id ?? query.from.id;
  const [action, a, b] = (query.data ?? "").split(":");
  const licenseId = action === "buy" ? b : a;
  const license = licenseId ? await billing.licenses.get(licenseId) : null;
  if (!license || license.revoked_at || license.telegram_user_id !== query.from.id) {
    return api.call("answerCallbackQuery", { callback_query_id: query.id, text: t.not_yours, show_alert: true });
  }
  await api.call("answerCallbackQuery", { callback_query_id: query.id });

  if (action === "plans") return showPlans(api, chat, language, license);
  if (action === "buy") {
    const plan = planOf(a);
    if (!plan) return say(api, chat, t.unavailable);
    const link = await invoice(api, language, license, plan);
    return say(api, chat, t.invoice_ready, [[{ text: fill(t.pay_button, { stars: plan.stars }), url: link }]]);
  }
  if (action === "stop" || action === "resume") {
    const payment = license.subscription_charge_id ? await billing.licenses.payment(license.subscription_charge_id) : null;
    if (!payment) return say(api, chat, t.unavailable);
    await api.call("editUserStarSubscription", {
      user_id: payment.telegram_user_id,
      telegram_payment_charge_id: payment.charge_id,
      is_canceled: action === "stop",
    });
    await billing.licenses.update(license.id, action === "resume" ? { renews: true, stopped_at: undefined } : { renews: false, stopped_at: billing.now() });
    if (action === "resume") return say(api, chat, t.resumed);
    const quota = await quotaFor(billing, license);
    return say(api, chat, fill(t.stopped, { date: quota.paidUntil ? dateIn(language, quota.paidUntil) : "—" }));
  }
};

const parsePayload = (payload: string) => {
  const [plan, license] = payload.split(":");
  return { plan: planOf(plan), license };
};

/** Telegram waits up to 10 seconds for this answer before it charges the Stars. */
const preCheckout = async (billing: Billing, api: TelegramApi, query: NonNullable<Update["pre_checkout_query"]>) => {
  const { plan, license } = parsePayload(query.invoice_payload);
  const known = license ? await billing.licenses.get(license) : null;
  const ok = !!plan && !!known && !known.blocked_at && !known.revoked_at && query.currency === "XTR" && query.total_amount === plan.stars;
  await api.call("answerPreCheckoutQuery", {
    pre_checkout_query_id: query.id,
    ok,
    ...(ok ? {} : { error_message: textsOf(languageOf(query.from.language_code)).unavailable }),
  });
};

/** Credits a period once per charge id; Telegram may deliver the same payment twice. */
const paid = async (billing: Billing, api: TelegramApi, chat: number, from: TelegramUser, payment: SuccessfulPayment) => {
  const { plan, license: licenseId } = parsePayload(payment.invoice_payload);
  const license = licenseId ? await billing.licenses.get(licenseId) : null;
  if (!plan || !license) {
    logger.error(`Payment ${payment.telegram_payment_charge_id} for an unknown plan or license: ${payment.invoice_payload}`);
    return;
  }
  const now = billing.now();
  const before = await quotaFor(billing, license);
  const recurring = !!payment.is_recurring;
  const fresh = await billing.licenses.pay(
    {
      charge_id: payment.telegram_payment_charge_id,
      license: license.id,
      plan: plan.id,
      stars: payment.total_amount,
      telegram_user_id: from.id,
      at: now,
      recurring,
    },
    windowsFor(plan, now, before.active ? before.paidUntil : null),
  );
  if (!fresh) return;
  await billing.licenses.update(license.id, {
    plan: plan.id,
    last_payment_at: now,
    ...(plan.subscription ? { renews: true } : {}),
    ...(payment.is_first_recurring ? { subscription_charge_id: payment.telegram_payment_charge_id } : {}),
  });
  logger.info(`License ${license.id} paid ${payment.total_amount} Stars for ${plan.id}${recurring ? " (subscription)" : ""}`);
  const after = await quotaFor(billing, license);
  const language = license.language ?? languageOf(from.language_code);
  const t = textsOf(language);
  const renewal = recurring && !payment.is_first_recurring;
  await say(api, chat, fill(renewal ? t.renewed : t.paid, { server: serverName(license), date: dateIn(language, after.paidUntil ?? now) }));
};

/** Takes a payment back from the books: a refund we made, or one Telegram reports. */
const unbook = async (billing: Billing, chargeId: string) => {
  const payment = await billing.licenses.refund(chargeId, billing.now());
  if (!payment) return null;
  const license = await billing.licenses.get(payment.license);
  if (license?.subscription_charge_id && payment.recurring) await billing.licenses.update(license.id, { renews: false });
  logger.info(`Payment ${chargeId} of license ${payment.license} refunded`);
  return { payment, license };
};

/**
 * Returns a payment's Stars and closes what they paid for, stopping the subscription it belonged to:
 * the bot's /refund and the admin panel's button. Null when there's no such payment or it's refunded already.
 */
export const refundPayment = async (billing: Billing, api: TelegramApi, chargeId: string) => {
  const payment = await billing.licenses.payment(chargeId);
  if (!payment || payment.refunded_at) return null;
  await api.call("refundStarPayment", { user_id: payment.telegram_user_id, telegram_payment_charge_id: chargeId });
  if (payment.recurring) {
    const license = await billing.licenses.get(payment.license);
    if (license?.subscription_charge_id) {
      await api
        .call("editUserStarSubscription", {
          user_id: payment.telegram_user_id,
          telegram_payment_charge_id: license.subscription_charge_id,
          is_canceled: true,
        })
        .catch(() => undefined);
    }
  }
  const done = await unbook(billing, chargeId);
  return { payment, license: done?.license ?? null };
};

export class LicenseRefundFailure extends Error {
  constructor(
    readonly refunded: number,
    readonly left: number,
    cause: Error,
  ) {
    super(cause.message);
  }
}

/**
 * Returns every payment of a license that isn't refunded yet, stops its subscription, and revokes it, so its key stops
 * working and the server takes a new license. When Telegram refuses one payment, the license stays as it is and
 * `LicenseRefundFailure` says how many went back; trying again returns the rest.
 */
export const refundLicense = async (billing: Billing, api: TelegramApi, license: LicenseRecord) => {
  const payments = (await billing.licenses.payments({ license: license.id, limit: 100_000 })).filter((p) => !p.refunded_at);
  let stars = 0;
  let refunded = 0;
  for (const payment of payments) {
    const done = await refundPayment(billing, api, payment.charge_id).catch((failure: Error) => {
      throw new LicenseRefundFailure(refunded, payments.length - refunded, failure);
    });
    if (!done) continue;
    stars += payment.stars;
    refunded++;
  }
  const now = await billing.licenses.get(license.id);
  // A subscription whose own payment went back earlier still renews until someone cancels it.
  if (now?.renews && now.subscription_charge_id && now.telegram_user_id !== undefined) {
    await api
      .call("editUserStarSubscription", { user_id: now.telegram_user_id, telegram_payment_charge_id: now.subscription_charge_id, is_canceled: true })
      .catch(() => undefined);
  }
  await billing.licenses.update(license.id, { revoked_at: billing.now(), renews: false, claim_hash: undefined, claim_expires: undefined });
  logger.info(`License ${license.id} revoked after refunding ${refunded} payments`);
  if (stars > 0 && license.telegram_chat_id !== undefined) {
    const language = license.language ?? "en";
    await say(api, license.telegram_chat_id, fill(textsOf(language).revoked, { stars, server: serverName(license) })).catch(() => undefined);
  }
  return { stars, payments: refunded };
};

/** /refund <charge id>, for the bot's admins only. */
const refund = async (billing: Billing, api: TelegramApi, chat: number, from: TelegramUser, chargeId: string) => {
  if (!billing.bot.admins.includes(from.id)) return;
  const done = await refundPayment(billing, api, chargeId);
  if (!done) return say(api, chat, `No such payment, or it's refunded already: ${chargeId}`);
  const server = done.license ? serverName(done.license) : done.payment.license;
  return say(api, chat, fill(textsOf(languageOf(from.language_code)).refunded, { stars: done.payment.stars, server }));
};

/** One update from the webhook or from polling. */
export const handleUpdate = async (billing: Billing, api: TelegramApi, update: Update): Promise<void> => {
  if (update.pre_checkout_query) return preCheckout(billing, api, update.pre_checkout_query);
  if (update.callback_query) return void (await callback(billing, api, update.callback_query));
  const message = update.message;
  if (!message?.from) return;
  const chat = message.chat.id;
  if (message.successful_payment) return paid(billing, api, chat, message.from, message.successful_payment);
  if (message.refunded_payment) return void (await unbook(billing, message.refunded_payment.telegram_payment_charge_id));
  // Payments and claims belong to one person, so the bot works in private chats only.
  if (message.chat.type !== "private" || !message.text) return;
  const command = message.text.match(/^\/(\w+)(?:@\w+)?(?:\s+(\S+))?/);
  const t = textsOf(languageOf(message.from.language_code));
  switch (command?.[1]) {
    case "start":
      if (command[2]) return void (await claim(billing, api, chat, message.from, command[2]));
      await say(api, chat, t.welcome);
      if (!(await billing.licenses.ofTelegram(message.from.id)).length) return;
      return void (await status(billing, api, chat, message.from));
    case "status":
      return void (await status(billing, api, chat, message.from));
    case "refund":
      if (command[2]) return void (await refund(billing, api, chat, message.from, command[2]));
      return;
    default:
      return void (await say(api, chat, t.help));
  }
};
