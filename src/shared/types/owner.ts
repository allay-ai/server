/**
 * Whose data it is: a player of one tenant. Every piece of player data is addressed by both, so the same Minecraft
 * account on two servers is two owners who never meet, and a caller reaches only its own tenant's players.
 */
export interface Owner {
  tenant: string;
  userId: string;
}

/** Player UUIDs, `console`, and Telegram ids: nothing that could reach into another Redis key or a query. */
export const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
