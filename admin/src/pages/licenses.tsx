import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Ban, Coins, Infinity as InfinityIcon, Megaphone, Pencil, Trash2, Wallet } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { BudgetCell, Confirm, Definition, Empty, ErrorBox, Loading, Meter, PageHeader, Pager, StatTile, TableFrame, cardGrid, rowLink, serverParams } from "@/components/common";
import { FormField } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, post } from "@/lib/api";
import { date, dateTime, number, relative, usd } from "@/lib/format";
import { showErrors } from "@/lib/forms";
import { useCan } from "@/lib/session";
import type { License, Payment, ServerSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PaymentsTable } from "./payments";
import { SearchBox } from "./players";
import { ServerName, ServerRuntime, joinAddress } from "./servers";

const LIMIT = 50;

// Green for paid and running, amber for a lapsed payment, plain for never paid, red for blocked, red outline for revoked.
const STATUS_COLORS: Record<License["status"], string> = {
  active: "border-success/30 bg-success/15 text-success",
  expired: "border-warning/40 bg-warning/20 text-foreground",
  unpaid: "text-muted-foreground",
  blocked: "",
  revoked: "border-destructive/40 text-destructive",
};

const StatusBadge = ({ status }: { status: License["status"] }) => {
  const { t } = useTranslation();
  return (
    <Badge variant={status === "blocked" ? "destructive" : "outline"} className={STATUS_COLORS[status]}>
      {t(`licenses.status.${status}`)}
    </Badge>
  );
};

/** The plan in words: one bought or granted, “Granted” for a budget given by hand, “No plan” for none. */
const usePlan = () => {
  const { t } = useTranslation();
  return (license: License) => (license.plan ? t(`plans.${license.plan}`, { defaultValue: license.plan }) : license.granted_at ? t("licenses.grantedPlan") : t("licenses.noPlan"));
};

/**
 * An owner writes to every license holder through the bot: how a breach notice reaches the servers' owners (GDPR art.
 * 33(2)), or news they need. Each holder gets it in the chat where they claimed their license; the audit log keeps the
 * counts, not the text.
 */
const NotifyButton = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const done = await post<{ sent: number; failed: number; unclaimed: number }>("/licenses/notify", { text: text.trim() });
      toast.success(t("licenses.notify.done", done));
      setOpen(false);
      setText("");
    } catch (error) {
      showErrors(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Megaphone className="size-4" aria-hidden />
          {t("licenses.notify.button")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("licenses.notify.title")}</DialogTitle>
          <DialogDescription>{t("licenses.notify.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="notify-text">{t("licenses.notify.text")}</Label>
          <Textarea id="notify-text" value={text} rows={6} maxLength={3000} onChange={(event) => setText(event.target.value)} />
          <span className="text-right text-xs text-muted-foreground">{text.length} / 3000</span>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!text.trim() || busy} onClick={send}>
            {t("licenses.notify.send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const LicensesPage = () => {
  const { t } = useTranslation();
  const can = useCan();
  const plan = usePlan();
  const { search = "", page = 0 } = useSearch({ from: "/app/licenses" });
  const navigate = useNavigate({ from: "/licenses" });
  const query = useQuery({
    queryKey: ["licenses", search, page],
    queryFn: () => api<{ total: number; licenses: License[] }>(`/licenses?limit=${LIMIT}&page=${page}${search ? `&search=${encodeURIComponent(search)}` : ""}`),
    placeholderData: (previous) => previous,
  });
  return (
    <>
      <PageHeader
        title={t("licenses.title")}
        description={t("licenses.description")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {can("owner") && <NotifyButton />}
            <SearchBox value={search} onChange={(value) => navigate({ search: { search: value || undefined, page: 0 } })} placeholder={t("licenses.search")} />
          </div>
        }
      />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {query.data &&
        (query.data.licenses.length === 0 ? (
          <Empty>{t("licenses.none")}</Empty>
        ) : (
          <>
            <TableFrame>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("licenses.columns.license")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("licenses.columns.server")}</TableHead>
                    <TableHead>{t("licenses.columns.status")}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t("licenses.columns.plan")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("licenses.columns.paidUntil")}</TableHead>
                    <TableHead>{t("licenses.columns.budget")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.licenses.map((l) => (
                    <TableRow key={l.id} {...rowLink(() => navigate({ to: "/licenses/$id", params: { id: l.id } }))}>
                      <TableCell className="max-w-56">
                        <Link to="/licenses/$id" params={{ id: l.id }} className="flex min-w-0 flex-col hover:underline">
                          <span className="truncate font-medium">{l.name}</span>
                          {l.name !== l.id && <span className="truncate font-mono text-xs text-muted-foreground">{l.id}</span>}
                        </Link>
                      </TableCell>
                      <TableCell className="hidden max-w-56 md:table-cell">
                        {l.server ? (
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate">{l.server.name ?? t("servers.unnamed")}</span>
                            {l.server.address && <span className="truncate text-xs text-muted-foreground">{l.server.address}</span>}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{t("licenses.noServerYet")}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={l.status} />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <span className="flex items-center gap-2">
                          {plan(l)}
                          {l.kind === "solo" && <Badge variant="outline">{t("licenseKinds.solo")}</Badge>}
                        </span>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">{l.paid_until ? date(l.paid_until) : <span className="text-muted-foreground">{t("licenses.notPaid")}</span>}</TableCell>
                      <TableCell>{l.budget ? <BudgetCell spent={l.spent} budget={l.budget} /> : <span className="text-muted-foreground">{t("licenses.noBudget")}</span>}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableFrame>
            <Pager page={page} total={query.data.total} limit={LIMIT} onPage={(next) => navigate({ search: { search: search || undefined, page: next } })} />
          </>
        ))}
    </>
  );
};

const grantSchema = z.object({
  usd: z.coerce.number<string>().positive("licenses.errors.usd").max(1000, "licenses.errors.usd"),
  days: z.coerce.number<string>().int("licenses.errors.days").min(1, "licenses.errors.days").max(366, "licenses.errors.days"),
});
const extendSchema = z.object({ days: z.coerce.number<string>().int("licenses.errors.days").min(1, "licenses.errors.days").max(366, "licenses.errors.days") });
const editSchema = z.object({
  name: z.string().trim().min(1, "licenses.errors.name").max(64, "licenses.errors.name"),
  language: z.string().trim().regex(/^([a-z]{2,3}(-[a-z0-9]{2,8})?)?$/i, "licenses.errors.language"),
});

const GrantDialog = ({ id, onDone }: { id: string; onDone: () => Promise<void> }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const form = useForm<{ usd: string; days: string }, unknown, { usd: number; days: number }>({ resolver: zodResolver(grantSchema), defaultValues: { usd: "1", days: "30" } });
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async (values) => {
    try {
      await post(`/licenses/${encodeURIComponent(id)}/grant`, values);
      toast.success(t("licenses.granted", { usd: usd(values.usd) }));
      setOpen(false);
      await onDone();
    } catch (error) {
      showErrors(error);
    }
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Coins className="size-4" aria-hidden />
          {t("licenses.grant")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{t("licenses.grantTitle")}</DialogTitle>
            <DialogDescription>{t("licenses.grantText")}</DialogDescription>
          </DialogHeader>
          <FormField id="usd" label={t("licenses.usd")} error={errors.usd && t(errors.usd.message!)}>
            <Input id="usd" inputMode="decimal" {...form.register("usd")} />
          </FormField>
          <FormField id="days" label={t("licenses.days")} error={errors.days && t(errors.days.message!)}>
            <Input id="days" inputMode="numeric" {...form.register("days")} />
          </FormField>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {t("licenses.grant")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const ExtendDialog = ({ id, onDone }: { id: string; onDone: () => Promise<void> }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const form = useForm<{ days: string }, unknown, { days: number }>({ resolver: zodResolver(extendSchema), defaultValues: { days: "7" } });
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async (values) => {
    try {
      const result = await post<{ paid_until: string }>(`/licenses/${encodeURIComponent(id)}/extend`, values);
      toast.success(t("licenses.extended", { date: date(result.paid_until) }));
      setOpen(false);
      await onDone();
    } catch (error) {
      showErrors(error);
    }
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          {t("licenses.extend")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{t("licenses.extendTitle")}</DialogTitle>
            <DialogDescription>{t("licenses.extendText")}</DialogDescription>
          </DialogHeader>
          <FormField id="days" label={t("licenses.days")} error={errors.days && t(errors.days.message!)}>
            <Input id="days" inputMode="numeric" {...form.register("days")} />
          </FormField>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {t("licenses.extend")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** An owner's edit of what the panel and the bot call the license: its name and the language the bot writes in. */
const EditDialog = ({ license, onDone }: { license: License; onDone: () => Promise<void> }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const form = useForm<{ name: string; language: string }>({ resolver: zodResolver(editSchema), defaultValues: { name: license.own_name ?? license.name, language: license.language ?? "" } });
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async (values) => {
    try {
      await api(`/licenses/${encodeURIComponent(license.id)}`, { method: "PATCH", body: { name: values.name, language: values.language.trim() || null } });
      toast.success(t("licenses.edited"));
      setOpen(false);
      await onDone();
    } catch (error) {
      showErrors(error);
    }
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          <Pencil className="size-4" aria-hidden />
          {t("licenses.edit")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{t("licenses.editTitle")}</DialogTitle>
            <DialogDescription>{t("licenses.editText")}</DialogDescription>
          </DialogHeader>
          <FormField id="license-name" label={t("licenses.name")} error={errors.name && t(errors.name.message!)}>
            <Input id="license-name" {...form.register("name")} />
          </FormField>
          <FormField id="license-language" label={t("licenses.language")} hint={t("licenses.languageHint")} error={errors.language && t(errors.language.message!)}>
            <Input id="license-language" placeholder="ru" autoComplete="off" spellCheck={false} {...form.register("language")} />
          </FormField>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Deleting a license. Nobody's money in it: one confirmation. Someone paid and has no refund: the dialog sends them to
 * the refund first, and only an owner may go on, after a warning about the payer's rights and a second agreement.
 */
const DeleteDialog = ({ id, stars, payments, onRefund }: { id: string; stars: number; payments: number; onRefund: () => Promise<void> }) => {
  const { t } = useTranslation();
  const can = useCan();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"ask" | "force">("ask");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const paid = payments > 0;
  const reset = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setStep("ask");
      setAgreed(false);
    }
  };
  const remove = async (force: boolean) => {
    setBusy(true);
    try {
      await api(`/licenses/${encodeURIComponent(id)}`, { method: "DELETE", body: { force } });
      toast.success(t("licenses.deleted"));
      reset(false);
      await client.invalidateQueries({ queryKey: ["licenses"] });
      await navigate({ to: "/licenses", search: {} });
    } catch (error) {
      showErrors(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="border-destructive/40 text-destructive hover:bg-destructive/10">
          {t("licenses.delete")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        {!paid ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("licenses.deleteTitle")}</DialogTitle>
              <DialogDescription>{t("licenses.deleteText")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => reset(false)} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button variant="destructive" onClick={() => remove(false)} disabled={busy}>
                {t("licenses.delete")}
              </Button>
            </DialogFooter>
          </>
        ) : step === "ask" ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("licenses.paidTitle")}</DialogTitle>
              <DialogDescription>{t("licenses.paidText", { stars: number(stars), count: payments })}</DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-col gap-2 sm:flex-row">
              <Button variant="outline" onClick={() => reset(false)} disabled={busy}>
                {t("common.cancel")}
              </Button>
              {can("owner") && (
                <Button variant="outline" className="border-destructive/40 text-destructive hover:bg-destructive/10" onClick={() => setStep("force")} disabled={busy}>
                  {t("licenses.deleteAnyway")}
                </Button>
              )}
              <Button
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onRefund();
                    reset(false);
                  } finally {
                    setBusy(false);
                  }
                }}
                disabled={busy}
              >
                {t("licenses.refund")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("licenses.forceTitle")}</DialogTitle>
              <DialogDescription>{t("licenses.forceText", { stars: number(stars), count: payments })}</DialogDescription>
            </DialogHeader>
            <label className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 accent-destructive" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>{t("licenses.forceAgree")}</span>
            </label>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("ask")} disabled={busy}>
                {t("common.previous")}
              </Button>
              <Button variant="destructive" onClick={() => remove(true)} disabled={busy || !agreed}>
                {t("licenses.forceAction")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

interface LicenseDetail {
  license: License;
  grants: Array<{ id: string; payment: string | null; budget: number; spent: number; starts: string; ends: string }>;
  payments: Payment[];
  servers: ServerSummary[];
}

/** One kind of action on a license: a title, a line on what it does, and its buttons. */
const ActionGroup = ({
  icon: Icon,
  title,
  text,
  children,
  danger,
  className,
}: {
  icon: typeof Coins;
  title: string;
  text: ReactNode;
  children: ReactNode;
  danger?: boolean;
  className?: string;
}) => (
  <div className={cn("flex flex-col gap-3 rounded-lg border p-4", danger && "border-destructive/30 bg-destructive/5", className)}>
    <div className="flex items-start gap-2.5">
      <Icon className={cn("mt-0.5 size-4 shrink-0", danger ? "text-destructive" : "text-muted-foreground")} aria-hidden />
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{text}</span>
      </div>
    </div>
    <div className="mt-auto flex flex-wrap gap-2">{children}</div>
  </div>
);

/** Whole days from now to a date, none once it's past. */
const daysUntil = (at: string) => Math.max(0, Math.ceil((new Date(at).getTime() - Date.now()) / 86_400_000));

/**
 * How long what's left of the budget lasts at the pace the open windows spent it so far, on average a day since the
 * oldest began. Nothing before anything was spent, since a pace of zero says nothing.
 */
const LastsFor = ({ license }: { license: License }) => {
  const { t } = useTranslation();
  const left = license.budget - license.spent;
  if (!license.daily_spend || left <= 0) return null;
  const days = Math.floor(left / license.daily_spend);
  return <span title={t("licenses.lastsForHint")}>{t("licenses.lastsFor", { count: days, days: number(days), pace: usd(license.daily_spend) })}</span>;
};

/** A server behind the license as a card that opens its page: the name, where players join, what it runs. */
const ServerCard = ({ server }: { server: ServerSummary }) => {
  const { t } = useTranslation();
  return (
    <Link
      to="/servers/$tenant/$id"
      params={serverParams(server)}
      className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-4 text-sm transition-colors hover:border-primary/40 hover:bg-accent/40"
    >
      <ServerName server={server} />
      <span className="truncate text-base font-semibold text-primary">{joinAddress(server) ?? t("servers.noDomain")}</span>
      <ServerRuntime server={server} />
      <span className="text-xs text-muted-foreground">{t("licenses.serverLine", { questions: number(server.questions), players: number(server.players), seen: relative(server.last_seen) })}</span>
    </Link>
  );
};

export const LicensePage = () => {
  const { t } = useTranslation();
  const plan = usePlan();
  const { id } = useParams({ from: "/app/licenses/$id" });
  const can = useCan();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["license", id], queryFn: () => api<LicenseDetail>(`/licenses/${encodeURIComponent(id)}`) });
  const refresh = () => client.invalidateQueries({ queryKey: ["license", id] });
  const toggleBlock = async (block: boolean) => {
    try {
      await post(`/licenses/${encodeURIComponent(id)}/${block ? "block" : "unblock"}`);
      toast.success(t(block ? "licenses.blocked" : "licenses.unblocked"));
      await refresh();
    } catch (error) {
      showErrors(error);
    }
  };
  const release = async () => {
    try {
      await post(`/licenses/${encodeURIComponent(id)}/release`);
      toast.success(t("licenses.released"));
      await refresh();
    } catch (error) {
      showErrors(error);
    }
  };
  const changeKind = async (kind: License["kind"]) => {
    try {
      await api(`/licenses/${encodeURIComponent(id)}`, { method: "PATCH", body: { kind } });
      toast.success(t("licenses.kindChanged"));
      await refresh();
    } catch (error) {
      showErrors(error);
    }
  };
  const refund = async () => {
    try {
      const result = await post<{ stars: number }>(`/licenses/${encodeURIComponent(id)}/refund`);
      toast.success(t("licenses.refundDone", { stars: number(result.stars) }));
    } catch (error) {
      showErrors(error);
    }
    // A refund that stopped halfway still returned some payments, so the page shows them either way.
    await refresh();
  };
  const grantInfinity = async () => {
    try {
      await post(`/licenses/${encodeURIComponent(id)}/grant`, { plan: "infinity" });
      toast.success(t("licenses.infinityDone"));
      await refresh();
    } catch (error) {
      showErrors(error);
    }
  };
  const data = query.data;
  const license = data?.license;
  const unrefunded = data?.payments.filter((p) => !p.refunded_at) ?? [];
  const lastPayment = license?.last_payment_at
    ? dateTime(license.last_payment_at)
    : license?.granted_at
      ? t("licenses.grantedOn", { date: date(license.granted_at) })
      : t("licenses.never");
  return (
    <>
      <PageHeader
        title={license?.name ?? id}
        description={license && license.name !== id ? <span className="font-mono text-xs">{id}</span> : undefined}
        actions={license && <StatusBadge status={license.status} />}
      />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {data && license && (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label={t("licenses.plan")} value={plan(license)} hint={license.renews ? t("licenses.renews") : undefined} />
            <StatTile
              label={t("licenses.paidUntil")}
              value={license.paid_until ? date(license.paid_until) : t("licenses.notPaid")}
              hint={license.paid_until ? t("licenses.daysLeft", { days: number(daysUntil(license.paid_until)) }) : undefined}
            />
            <StatTile
              label={t("licenses.budgetNow")}
              value={license.budget ? usd(license.budget - license.spent) : t("licenses.noBudget")}
              hint={
                license.budget ? (
                  <span className="flex flex-col gap-1.5 pt-1">
                    <Meter spent={license.spent} budget={license.budget} label={t("licenses.budgetNow")} />
                    <span>{t("licenses.spentOf", { spent: usd(license.spent), budget: usd(license.budget), percent: license.used_percent })}</span>
                  </span>
                ) : undefined
              }
            />
            <StatTile label={t("licenses.resets")} value={license.resets_at ? date(license.resets_at) : t("licenses.withPeriod")} hint={<LastsFor license={license} />} />
          </div>
          <Card className="gap-4">
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <CardTitle className="text-base">{t("licenses.details")}</CardTitle>
              {can("owner") && !license.revoked_at && <EditDialog license={license} onDone={refresh} />}
            </CardHeader>
            <CardContent>
              <Definition
                columns={3}
                items={[
                  [t("licenses.created"), dateTime(license.created_at)],
                  [t("licenses.kind"), t(`licenseKinds.${license.kind}`)],
                  license.kind === "solo" && [t("licenses.player"), license.bound_at ? t("licenses.playerSince", { date: dateTime(license.bound_at) }) : t("licenses.playerNone")],
                  [t("licenses.telegram"), license.telegram_user_id ? String(license.telegram_user_id) : t("licenses.unclaimed")],
                  [t("licenses.language"), license.language ?? t("licenses.noLanguage")],
                  [t("licenses.lastPayment"), lastPayment],
                  license.plan === "month" && [t("licenses.renewal"), license.stopped_at ? t("licenses.stoppedOn", { date: date(license.stopped_at) }) : t("licenses.renews")],
                  [t("licenses.blockedAt"), license.blocked_at ? t("licenses.blockedSince", { date: dateTime(license.blocked_at) }) : t("common.no")],
                  !!license.revoked_at && [t("licenses.revokedAt"), dateTime(license.revoked_at)],
                ]}
              />
            </CardContent>
          </Card>
          {can("admin") && (
            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold">{t("licenses.actions")}</h2>
              <div className="grid gap-3 md:grid-cols-2">
                {!license.revoked_at && (
                  <ActionGroup icon={Wallet} title={t("licenses.budgetGroup")} text={t("licenses.budgetGroupText")}>
                    <GrantDialog id={id} onDone={refresh} />
                    <ExtendDialog id={id} onDone={refresh} />
                    {can("owner") && license.plan !== "infinity" && (
                      <Confirm
                        label={
                          <>
                            <InfinityIcon className="size-4" aria-hidden />
                            {t("licenses.infinity")}
                          </>
                        }
                        title={t("licenses.infinityTitle")}
                        text={t("licenses.infinityText")}
                        action={t("licenses.infinity")}
                        onConfirm={grantInfinity}
                      />
                    )}
                  </ActionGroup>
                )}
                {!license.revoked_at && (
                  <ActionGroup icon={Ban} title={t("licenses.accessGroup")} text={t("licenses.accessGroupText")}>
                    {license.blocked_at ? (
                      <Confirm label={t("licenses.unblock")} title={t("licenses.unblockTitle")} text={t("licenses.unblockText")} action={t("licenses.unblock")} onConfirm={() => toggleBlock(false)} />
                    ) : (
                      <Confirm label={t("licenses.block")} title={t("licenses.blockTitle")} text={t("licenses.blockText")} action={t("licenses.block")} destructive variant="outline" onConfirm={() => toggleBlock(true)} />
                    )}
                    {license.kind === "solo" && license.bound_at && (
                      <Confirm label={t("licenses.release")} title={t("licenses.releaseTitle")} text={t("licenses.releaseText")} action={t("licenses.release")} variant="outline" onConfirm={release} />
                    )}
                    {can("owner") && (
                      <Confirm
                        label={t(license.kind === "solo" ? "licenses.makeServer" : "licenses.makeSolo")}
                        title={t("licenses.kindTitle")}
                        text={t(license.kind === "solo" ? "licenses.kindServerText" : "licenses.kindSoloText")}
                        action={t(license.kind === "solo" ? "licenses.makeServer" : "licenses.makeSolo")}
                        variant="outline"
                        onConfirm={() => changeKind(license.kind === "solo" ? "server" : "solo")}
                      />
                    )}
                    {data.payments.length > 0 && (
                      <Confirm
                        label={t("licenses.refund")}
                        title={t("licenses.refundTitle")}
                        text={t("licenses.refundText", { stars: number(unrefunded.reduce((sum, p) => sum + p.stars, 0)), count: unrefunded.length })}
                        action={t("licenses.refund")}
                        destructive
                        variant="outline"
                        onConfirm={refund}
                      />
                    )}
                  </ActionGroup>
                )}
                <ActionGroup
                  icon={Trash2}
                  title={t("licenses.deleteGroup")}
                  text={
                    <span className="flex flex-col gap-1.5">
                      <span>{t("licenses.deleteGroupText")}</span>
                      <span>{t("licenses.deleteGroupKeeps")}</span>
                    </span>
                  }
                  danger
                  className="md:col-span-2"
                >
                  <DeleteDialog id={id} stars={unrefunded.reduce((sum, p) => sum + p.stars, 0)} payments={unrefunded.length} onRefund={refund} />
                </ActionGroup>
              </div>
            </section>
          )}
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">{t("licenses.servers")}</h2>
            {data.servers.length === 0 ? (
              <Empty>{t("licenses.noServers")}</Empty>
            ) : (
              <div className={cardGrid(data.servers.length)}>
                {data.servers.map((s) => (
                  <ServerCard key={`${s.server}/${s.server_id ?? ""}`} server={s} />
                ))}
              </div>
            )}
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">{t("licenses.windows")}</h2>
            {data.grants.length === 0 ? (
              <Empty>{t("licenses.noWindows")}</Empty>
            ) : (
              <TableFrame>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("licenses.columns.from")}</TableHead>
                      <TableHead>{t("licenses.columns.to")}</TableHead>
                      <TableHead>{t("licenses.columns.budget")}</TableHead>
                      <TableHead className="hidden sm:table-cell">{t("licenses.columns.source")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.grants.map((g) => (
                      <TableRow key={g.id}>
                        <TableCell>{date(g.starts)}</TableCell>
                        <TableCell>{date(g.ends)}</TableCell>
                        <TableCell>
                          <BudgetCell spent={g.spent} budget={g.budget} />
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">{g.payment ? t("licenses.fromPayment") : t("licenses.byHand")}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableFrame>
            )}
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">{t("licenses.payments")}</h2>
            <CardDescription>{t("licenses.paymentsHint")}</CardDescription>
            <PaymentsTable payments={data.payments} showLicense={false} />
          </section>
        </div>
      )}
    </>
  );
};
