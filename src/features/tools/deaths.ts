import type { Position } from "../../agent/agent.types";
import { localIso } from "../../agent/time";
import type { DeathPage } from "../../infrastructure/playerdata/deaths";
import { bearing } from "../../shared/lib/compass";

/** Deaths the model reads a page at a time, newest first. */
export const DEATHS_PER_PAGE = 10;

/** Where the history comes from since 6.9: the backend's own store, read for the asking player. */
export interface DeathHistory {
  page(page: number): Promise<DeathPage>;
  timezone?: string;
  position?: Position;
}

/**
 * One page of the player's deaths as get_locations returns it: when in their own time, how long ago, where with
 * distance and direction from them, and what killed them and dropped. A page past the end is an error naming the count.
 */
export const historyPage = async (history: DeathHistory, page: number, now = Date.now()) => {
  const found = await history.page(page);
  const pages = Math.max(1, Math.ceil(found.total / DEATHS_PER_PAGE));
  if (found.total > 0 && page > pages) return { error: `There are only ${found.total} deaths, ${pages} page${pages === 1 ? "" : "s"} of ${DEATHS_PER_PAGE}` };
  return {
    page,
    pages,
    total: found.total,
    deaths: found.deaths.map((d) => {
      const minutes = Math.max(0, Math.round((now - d.at) / 60_000));
      return {
        at: localIso(new Date(d.at), history.timezone),
        ...(minutes < 2 * 1440 ? { minutes_ago: minutes } : { days_ago: Math.floor(minutes / 1440) }),
        x: d.x,
        y: d.y,
        z: d.z,
        dimension: d.dimension,
        ...bearing(history.position, d),
        ...(d.cause ? { cause: d.cause } : {}),
        ...(d.killer ? { killer: d.killer } : {}),
        ...(d.killer_name ? { killer_name: d.killer_name } : {}),
        ...(d.message ? { message: d.message } : {}),
        level: d.level,
        ...(d.kept_inventory ? { kept_inventory: true } : {}),
        ...(d.drops && Object.keys(d.drops).length ? { dropped_items: d.drops } : {}),
        ...(d.experience ? { dropped_experience: d.experience } : {}),
      };
    }),
  };
};
