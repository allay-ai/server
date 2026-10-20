import { adminRouter } from "./admin.http";
import { accessRoutes, accountRoutes, auditRoutes, settingsRoutes } from "./admin.routes";
import { billingRoutes } from "./billing.routes";
import { insightRoutes } from "./insight.routes";

/** Every route of the panel's API; `test/access.test.ts` checks that only the sign-in ones are public. */
export const ADMIN_ROUTES = [...accessRoutes, ...accountRoutes, ...settingsRoutes, ...auditRoutes, ...insightRoutes, ...billingRoutes];

/** /api/admin/*: the admin panel's API. */
export const handleAdmin = adminRouter(ADMIN_ROUTES);
