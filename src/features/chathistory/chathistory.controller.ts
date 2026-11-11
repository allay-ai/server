import { z } from "zod";
import type { AllayDeps } from "../../agent/allay";
import { CHAT_CHANNELS } from "../../entities/chatline/chatline.model";
import { jsonError, readJson } from "../../shared/lib/http";
import { logger } from "../../shared/logging/logger";
import { API_ERRORS, ApiFailure, apierror } from "../../shared/types/errors";
import { USER_ID } from "../../shared/types/owner";
import { identify } from "../auth/caller";

/** A batch the plugin sends every few seconds; a busy chat sends more batches, never bigger ones. */
export const MAX_CHAT_BATCH = 200;
/** The game's chat takes 256 characters; colors and a chat plugin's formats add some. */
export const MAX_CHAT_TEXT = 1024;
/** A local line's readers: a chat plugin's radius on a crowded server, cut so a document stays small. */
export const MAX_AUDIENCE = 200;

const Person = z.object({ uuid: z.string().regex(USER_ID), name: z.string().trim().min(1).max(32) });

const SERVER_ID = /^[A-Za-z0-9_-]{1,64}$/;

const ChatHistoryBody = z.object({
  server_id: z.string().regex(SERVER_ID),
  lines: z
    .array(
      z.object({
        at: z.number().int().positive(),
        channel: z.enum(CHAT_CHANNELS),
        from: Person,
        to: Person.optional(),
        audience: z.array(z.string().regex(USER_ID)).max(MAX_AUDIENCE).optional(),
        text: z.string().min(1).max(MAX_CHAT_TEXT),
      }),
    )
    .min(1)
    .max(MAX_CHAT_BATCH),
});

/**
 * POST /api/v2/chat-history (since 6.34): the plugin hands over its server's chat when `chat_history` is on, so
 * chat_history can read it back. The chat is everyone's on the server, so a line needs nobody's agreement (the owner
 * settled it on 2026-11-11); it's sealed and gone after CHAT_HISTORY_HOURS, and an erasure takes what the player wrote.
 * DELETE /api/v2/chat-history?server_id=… forgets the server's whole chat at once.
 */
export const handleChatHistory = (deps: AllayDeps) => async (req: Request): Promise<Response> => {
  if (req.method !== "POST" && req.method !== "DELETE") return jsonError(apierror(API_ERRORS.METHOD_NOT_SUPPORTED));
  const caller = await identify(deps.billing, req);
  if (caller instanceof ApiFailure) return jsonError(caller.toApiError());
  // DELETE ?server_id=…: the server's admins reset what Allay keeps of its chat.
  if (req.method === "DELETE") {
    const serverId = new URL(req.url).searchParams.get("server_id") ?? "";
    if (!SERVER_ID.test(serverId)) return jsonError(apierror(API_ERRORS.BAD_REQUEST, "server_id is 1–64 letters, digits, - or _"));
    try {
      return Response.json({ deleted: (await deps.chats?.reset(caller.tenant, serverId)) ?? 0 });
    } catch (error) {
      logger.warn(`Couldn't reset the chat of ${caller.tenant}: ${String(error)}`);
      return jsonError({ code: "STORAGE_ERROR", message: "Couldn't reset the chat", statusCode: 503 });
    }
  }
  const json = await readJson(req);
  if (!json.ok) return jsonError(json.error);
  const body = ChatHistoryBody.safeParse(json.body);
  if (!body.success) return jsonError(apierror(API_ERRORS.BAD_REQUEST, `${body.error.issues[0]?.path.join(".") || "body"}: ${body.error.issues[0]?.message}`));
  // A private line goes to someone.
  if (body.data.lines.some((line) => line.channel === "private" && !line.to)) return jsonError(apierror(API_ERRORS.BAD_REQUEST, "lines: a private line needs to"));
  if (!deps.chats) return Response.json({ saved: 0 });
  try {
    return Response.json({ saved: await deps.chats.add(caller.tenant, body.data.server_id, body.data.lines) });
  } catch (error) {
    logger.warn(`Couldn't keep the chat of ${caller.tenant}: ${String(error)}`);
    return jsonError({ code: "STORAGE_ERROR", message: "Couldn't keep the chat", statusCode: 503 });
  }
};
