import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { Layout } from "@/components/layout";
import { NotFound } from "@/components/not-found";
import { ROUTER_BASE } from "@/lib/api";
import { stateQuery } from "@/lib/session";
import { AccountsPage } from "@/pages/accounts";
import { AuditPage } from "@/pages/audit";
import { DashboardPage } from "@/pages/dashboard";
import { LicensePage, LicensesPage } from "@/pages/licenses";
import { LoginPage } from "@/pages/login";
import { PaymentsPage } from "@/pages/payments";
import { PlayerPage, PlayersPage } from "@/pages/players";
import { ProfilePage } from "@/pages/profile";
import { RecoverPage } from "@/pages/recover";
import { RevenuePage } from "@/pages/revenue";
import { RunPage, RunsPage } from "@/pages/runs";
import { ServerPage, ServersPage } from "@/pages/servers";
import { SettingsPage } from "@/pages/settings";
import { SetupPage } from "@/pages/setup";
import { TracePage, TracesPage } from "@/pages/traces";

interface Context {
  queryClient: QueryClient;
}

const root = createRootRouteWithContext<Context>()({ component: Outlet, notFoundComponent: NotFound });

const setup = createRoute({
  getParentRoute: () => root,
  path: "/setup",
  validateSearch: z.object({ code: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    const state = await context.queryClient.ensureQueryData(stateQuery);
    if (!state.setup) throw redirect({ to: state.me ? "/" : "/login" });
  },
  component: SetupPage,
});

/** A forgotten password, with a code from /allay init; it opens even for someone signed in, who may be fixing another account. */
const recover = createRoute({
  getParentRoute: () => root,
  path: "/recover",
  validateSearch: z.object({ code: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    const state = await context.queryClient.ensureQueryData(stateQuery);
    if (state.setup) throw redirect({ to: "/setup" });
    // Only /allay init on a self-hosted backend hands out recovery codes.
    if (!state.selfhosted) throw redirect({ to: state.me ? "/" : "/login" });
  },
  component: RecoverPage,
});

const login = createRoute({
  getParentRoute: () => root,
  path: "/login",
  validateSearch: z.object({ next: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    const state = await context.queryClient.ensureQueryData(stateQuery);
    if (state.setup) throw redirect({ to: "/setup" });
    if (state.me) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

/** Every page behind sign-in: setup first if nobody exists, the sign-in form if nobody's signed in. */
const app = createRoute({
  getParentRoute: () => root,
  id: "app",
  beforeLoad: async ({ context, location }) => {
    const state = await context.queryClient.ensureQueryData(stateQuery);
    if (state.setup) throw redirect({ to: "/setup" });
    if (!state.me) throw redirect({ to: "/login", search: { next: location.href } });
  },
  component: Layout,
});

const page = <P extends string>(path: P, component: () => React.ReactNode) => createRoute({ getParentRoute: () => app, path, component });

const rangeSearch = z.object({ range: z.enum(["24h", "7d", "30d", "1y"]).optional().catch(undefined) });

const dashboard = createRoute({ getParentRoute: () => app, path: "/", validateSearch: rangeSearch, component: DashboardPage });
const players = createRoute({
  getParentRoute: () => app,
  path: "/players",
  validateSearch: z.object({ search: z.string().optional(), page: z.number().int().min(0).catch(0).optional() }),
  component: PlayersPage,
});
const player = page("/players/$id", PlayerPage);
const runs = createRoute({
  getParentRoute: () => app,
  path: "/runs",
  validateSearch: z.object({
    player: z.string().optional(),
    server: z.string().optional(),
    kind: z.string().optional(),
    result: z.enum(["ok", "error", "cancelled"]).optional().catch(undefined),
  }),
  component: RunsPage,
});
const run = page("/runs/$id", RunPage);
const servers = page("/servers", ServersPage);
const server = page("/servers/$tenant/$id", ServerPage);
const traces = page("/traces", TracesPage);
const trace = page("/traces/$id", TracePage);
const revenue = createRoute({
  getParentRoute: () => app,
  path: "/billing",
  validateSearch: z.object({ range: z.enum(["30d", "90d", "1y"]).optional().catch(undefined), by: z.enum(["week", "month"]).optional().catch(undefined) }),
  component: RevenuePage,
});
const licenses = createRoute({
  getParentRoute: () => app,
  path: "/licenses",
  validateSearch: z.object({ search: z.string().optional(), page: z.number().int().min(0).catch(0).optional() }),
  component: LicensesPage,
});
const license = page("/licenses/$id", LicensePage);
const payments = page("/payments", PaymentsPage);
const settings = page("/settings", SettingsPage);
const accounts = page("/accounts", AccountsPage);
const audit = page("/audit", AuditPage);
const profile = page("/profile", ProfilePage);

const tree = root.addChildren([
  setup,
  recover,
  login,
  app.addChildren([dashboard, players, player, runs, run, servers, server, traces, trace, revenue, licenses, license, payments, settings, accounts, audit, profile]),
]);

export const router = createRouter({
  routeTree: tree,
  basepath: ROUTER_BASE,
  context: { queryClient: undefined! },
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
