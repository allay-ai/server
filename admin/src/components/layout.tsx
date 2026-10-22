import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  BarChart3,
  Bug,
  CreditCard,
  ExternalLink,
  FileClock,
  GitBranch,
  KeyRound,
  LogOut,
  Menu,
  MessagesSquare,
  Monitor,
  Moon,
  Receipt,
  ScrollText,
  Server,
  Settings,
  Sparkles,
  Sun,
  UserCog,
  Users,
  Waypoints,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { post } from "@/lib/api";
import { resetSession, useAppState, useCan } from "@/lib/session";
import { type Theme, useTheme } from "@/lib/theme";
import type { Role } from "@/lib/types";
import { Logo } from "./logo";

interface Item {
  to: string;
  label: string;
  icon: typeof Activity;
  role?: Role;
  hosted?: boolean;
}

const SECTIONS: Array<{ title: string; items: Item[] }> = [
  {
    title: "nav.insight",
    items: [
      { to: "/", label: "nav.dashboard", icon: BarChart3 },
      { to: "/players", label: "nav.players", icon: Users },
      { to: "/servers", label: "nav.servers", icon: Server },
      { to: "/runs", label: "nav.runs", icon: Activity },
      { to: "/traces", label: "nav.traces", icon: Waypoints },
    ],
  },
  {
    title: "nav.billing",
    items: [
      { to: "/billing", label: "nav.revenue", icon: CreditCard, hosted: true },
      { to: "/licenses", label: "nav.licenses", icon: KeyRound, hosted: true },
      { to: "/payments", label: "nav.payments", icon: Receipt, hosted: true },
    ],
  },
  {
    title: "nav.manage",
    items: [
      { to: "/settings", label: "nav.settings", icon: Settings },
      { to: "/accounts", label: "nav.accounts", icon: UserCog, role: "owner" },
      { to: "/audit", label: "nav.audit", icon: FileClock, role: "admin" },
    ],
  },
];

const Nav = ({ onPick }: { onPick?: () => void }) => {
  const { t } = useTranslation();
  const state = useAppState();
  const can = useCan();
  return (
    <nav className="flex flex-col gap-5 text-sm">
      {SECTIONS.map((section) => {
        const items = section.items.filter((item) => (!item.role || can(item.role)) && (!item.hosted || state?.billing));
        if (!items.length) return null;
        return (
          <div key={section.title} className="flex flex-col gap-0.5">
            <div className="px-3 pb-1 text-xs font-medium text-muted-foreground">{t(section.title)}</div>
            {items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                onClick={onPick}
                activeOptions={{ exact: item.to === "/" }}
                className="flex items-center gap-2.5 rounded-md px-3 py-2 text-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground data-[status=active]:bg-accent data-[status=active]:font-medium data-[status=active]:text-accent-foreground"
              >
                <item.icon className="size-4 shrink-0" aria-hidden />
                {t(item.label)}
              </Link>
            ))}
          </div>
        );
      })}
    </nav>
  );
};

const THEMES: Array<{ value: Theme; icon: typeof Sun }> = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
];

const UserMenu = () => {
  const { t } = useTranslation();
  const state = useAppState();
  const { theme, setTheme } = useTheme();
  const client = useQueryClient();
  const navigate = useNavigate();
  const signOut = async () => {
    await post("/logout").catch(() => undefined);
    await resetSession(client);
    await navigate({ to: "/login", search: {} });
  };
  if (!state?.me) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-auto w-full justify-start gap-2.5 px-3 py-2">
          <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary uppercase">{state.me.username.slice(0, 2)}</span>
          <span className="flex min-w-0 flex-col items-start text-left">
            <span className="truncate text-sm font-medium">{state.me.username}</span>
            <span className="text-xs text-muted-foreground">{t(`roles.${state.me.role}`)}</span>
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("menu.theme")}</DropdownMenuLabel>
        <div className="flex gap-1 px-2 pb-2">
          {THEMES.map(({ value, icon: Icon }) => (
            <Button key={value} size="sm" variant={theme === value ? "secondary" : "ghost"} className="min-w-0 flex-1 px-2" onClick={() => setTheme(value)} aria-pressed={theme === value}>
              <Icon className="size-4" aria-hidden />
              <span className="sr-only sm:not-sr-only sm:text-xs">{t(`menu.themes.${value}`)}</span>
            </Button>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/profile">
            <ScrollText className="size-4" aria-hidden />
            {t("menu.profile")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={signOut}>
          <LogOut className="size-4" aria-hidden />
          {t("menu.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const REPOSITORY = "https://github.com/allay-ai/server";

/** Where a self-hosted backend's operator finds the code, reports a problem, and reads what changed. */
const LINKS = [
  { href: REPOSITORY, label: "layout.links.source", icon: GitBranch },
  { href: `${REPOSITORY}/issues/new/choose`, label: "layout.links.issue", icon: Bug },
  { href: `${REPOSITORY}/discussions`, label: "layout.links.discussions", icon: MessagesSquare },
  { href: `${REPOSITORY}/releases`, label: "layout.links.releases", icon: Sparkles },
];

/** The version, and on a self-hosted backend the project's links: the hosted one is ours, so it needs none. */
const About = () => {
  const { t } = useTranslation();
  const state = useAppState();
  return (
    <div className="flex flex-col gap-2 px-3">
      {state?.selfhosted && (
        <div className="flex flex-col gap-0.5 rounded-lg border bg-background/60 p-1.5">
          <div className="px-1.5 pt-0.5 pb-1 text-xs font-medium text-muted-foreground">{t("layout.links.title")}</div>
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs text-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <link.icon className="size-3.5 shrink-0" aria-hidden />
              <span className="flex-1">{t(link.label)}</span>
              <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            </a>
          ))}
        </div>
      )}
      <a href={/^\d+\.\d+\.\d+$/.test(state?.version ?? "") ? `${REPOSITORY}/releases/tag/v${state!.version}` : `${REPOSITORY}/releases`} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:underline">
        {t("layout.version", { version: state?.version ?? "" })}
      </a>
    </div>
  );
};

/** The signed-in frame: a sidebar on wide screens, a menu sheet on phones. */
export const Layout = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      {/* The column carries the sidebar's color down a long page; the sidebar itself stays in view. */}
      <div className="hidden border-r bg-sidebar lg:block">
        <aside className="sticky top-0 flex h-dvh flex-col gap-6 px-3 py-5">
          <Link to="/" className="px-3">
            <Logo />
          </Link>
          <div className="flex-1 overflow-y-auto">
            <Nav />
          </div>
          <div className="flex flex-col gap-2">
            <About />
            <UserMenu />
          </div>
        </aside>
      </div>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-background/90 px-4 backdrop-blur lg:hidden">
        <Link to="/">
          <Logo />
        </Link>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("layout.menu")}>
              <Menu className="size-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="flex w-72 flex-col gap-6 bg-sidebar px-3 py-5">
            <SheetTitle className="px-3">
              <Logo />
            </SheetTitle>
            <div className="flex-1 overflow-y-auto">
              <Nav onPick={() => setOpen(false)} />
            </div>
            <About />
            <UserMenu />
          </SheetContent>
        </Sheet>
      </header>
      <main className="mx-auto w-full max-w-6xl min-w-0 px-4 py-6 sm:px-6 lg:py-8">
        <Outlet />
      </main>
    </div>
  );
};
