import type { ClientHeader, ProxyTrust } from "../../shared/lib/address";
import type { Settings } from "./settings";

/** Which proxies may name a client's address, as the settings say right now. */
export const trustOf = (settings: Settings): ProxyTrust => ({
  proxies: settings.get("TRUSTED_PROXIES"),
  header: settings.get("CLIENT_IP_HEADER") as ClientHeader,
});
