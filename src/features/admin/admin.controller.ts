import { adminRouter } from "./admin.http";
import { accessRoutes, accountRoutes, auditRoutes, settingsRoutes } from "./admin.routes";
import { billingRoutes } from "./billing.routes";
import { insightRoutes } from "./insight.routes";

/** /api/admin/*: the admin panel's API. */
export const handleAdmin = adminRouter([...accessRoutes, ...accountRoutes, ...settingsRoutes, ...auditRoutes, ...insightRoutes, ...billingRoutes]);
