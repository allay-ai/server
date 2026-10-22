const valid = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/**
 * The player's real date and time, put in front of each Minecraft question: "[Mon, 12 Oct 2026, 18:42 Europe/Moscow]".
 * It goes into the message, not the system prompt, so the prompt stays the same and the provider's cache keeps working.
 * Kept in the history too, so the model can tell how long ago an earlier question was.
 */
export const localStamp = (timezone: string | undefined, now: Date = new Date()): string => {
  const zone = timezone && valid(timezone) ? timezone : "UTC";
  // Built from parts: the joined format differs between ICU versions ("12 Oct 2026, 18:42" or "12 Oct 2026 at 18:42").
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return `[${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${zone}]`;
};

/** [at] as ISO 8601 in the player's zone, with its offset: "2026-10-22T18:42:05+03:00". UTC for an unknown zone. */
export const localIso = (at: Date, timezone: string | undefined): string => {
  const zone = timezone && valid(timezone) ? timezone : "UTC";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offset = Math.round((wall - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
  const sign = offset < 0 ? "-" : "+";
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const mm = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${hh}:${mm}`;
};
