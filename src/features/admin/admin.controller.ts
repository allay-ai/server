import { adminRouter } from "./admin.http";
import { accessRoutes, accountRoutes, auditRoutes, settingsRoutes } from "./admin.routes";

/** /api/admin/*: the admin panel's API. */
export const handleAdmin = adminRouter([...accessRoutes, ...accountRoutes, ...settingsRoutes, ...auditRoutes]);
