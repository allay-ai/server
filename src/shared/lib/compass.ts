import type { Position } from "../../agent/agent.types";

const DIRECTIONS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"] as const;

/**
 * Horizontal distance in blocks and the direction from [from] to a spot, as the plugin names them: north is -z.
 * Nothing when the spot lies in another dimension or the player's position isn't known.
 */
export const bearing = (from: Position | undefined, to: { x: number; z: number; dimension?: string }): { distance: number; direction: string } | undefined => {
  if (!from || (to.dimension && to.dimension !== from.dimension)) return undefined;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const distance = Math.round(Math.hypot(dx, dz));
  if (distance === 0) return { distance, direction: "here" };
  const angle = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return { distance, direction: DIRECTIONS[Math.round(((angle + 360) % 360) / 45) % 8] };
};
