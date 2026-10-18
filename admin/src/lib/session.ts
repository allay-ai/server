import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { Role, State } from "./types";

export const stateQuery = queryOptions({ queryKey: ["state"], queryFn: () => api<State>("/state"), staleTime: 60_000 });

export const useAppState = () => useQuery(stateQuery).data;

const RANK: Record<Role, number> = { viewer: 0, admin: 1, owner: 2 };

/** Whether the signed-in role may do what `needed` may; the backend checks again. */
export const useCan = () => {
  const state = useAppState();
  return (needed: Role) => !!state?.me && RANK[state.me.role] >= RANK[needed];
};

/** After signing in or out: everything cached belonged to the previous session. */
export const resetSession = async (client: QueryClient) => {
  client.removeQueries({ predicate: (query) => query.queryKey[0] !== "state" });
  await client.invalidateQueries({ queryKey: ["state"] });
};
