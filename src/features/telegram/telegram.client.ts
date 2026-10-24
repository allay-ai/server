import { logger } from "../../shared/logging/logger";

/** The Bot API calls the bot makes; tests pass a fake that records them. */
export interface TelegramApi {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/**
 * The Bot API over HTTPS: Telegram's own, or a local Bot API server at `base`. `test` talks to Telegram's
 * test environment, for a bot made with the test @BotFather.
 */
export const telegramApi = (token: string, options: { base?: string; test?: boolean } = {}): TelegramApi => ({
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const base = (options.base || "https://api.telegram.org").replace(/\/$/, "");
    const response = await fetch(`${base}/bot${token}${options.test ? "/test" : ""}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!body.ok) {
      // The token is in the URL, never in what Telegram answers; the description is safe to log.
      logger.warn(`Telegram ${method} failed: ${response.status} ${body.description ?? ""}`);
      throw new Error(`Telegram ${method}: ${body.description ?? response.status}`);
    }
    return body.result as T;
  },
});

export interface TelegramUser {
  id: number;
  language_code?: string;
  username?: string;
}

export interface SuccessfulPayment {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  telegram_payment_charge_id: string;
  subscription_expiration_date?: number;
  is_recurring?: boolean;
  is_first_recurring?: boolean;
}

export interface Update {
  update_id: number;
  message?: {
    message_id: number;
    from?: TelegramUser;
    chat: { id: number; type: string };
    text?: string;
    successful_payment?: SuccessfulPayment;
    refunded_payment?: { currency: string; total_amount: number; invoice_payload: string; telegram_payment_charge_id: string };
  };
  callback_query?: {
    id: string;
    from: TelegramUser;
    message?: { message_id?: number; chat: { id: number } };
    data?: string;
  };
  pre_checkout_query?: {
    id: string;
    from: TelegramUser;
    currency: string;
    total_amount: number;
    invoice_payload: string;
  };
}
