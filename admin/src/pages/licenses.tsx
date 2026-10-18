import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { Confirm, Definition, Empty, ErrorBox, Loading, PageHeader, Pager, StatTile, TableFrame } from "@/components/common";
import { FormField } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, post } from "@/lib/api";
import { date, dateTime, number, relative, usd } from "@/lib/format";
import { showErrors } from "@/lib/forms";
import { useCan } from "@/lib/session";
import type { License, Payment, ServerSummary } from "@/lib/types";
import { PaymentsTable } from "./payments";
import { SearchBox } from "./players";

const LIMIT = 50;

const StatusBadge = ({ status }: { status: License["status"] }) => {
  const { t } = useTranslation();
  const variant = status === "active" ? "secondary" : status === "blocked" ? "destructive" : "outline";
  return <Badge variant={variant}>{t(`licenses.status.${status}`)}</Badge>;
};

export const LicensesPage = () => {
  const { t } = useTranslation();
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
        actions={<SearchBox value={search} onChange={(value) => navigate({ search: { search: value || undefined, page: 0 } })} placeholder={t("licenses.search")} />}
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
                    <TableHead>{t("licenses.columns.server")}</TableHead>
                    <TableHead>{t("licenses.columns.status")}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t("licenses.columns.plan")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("licenses.columns.paidUntil")}</TableHead>
                    <TableHead className="text-right">{t("licenses.columns.budget")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.licenses.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="max-w-56">
                        <Link to="/licenses/$id" params={{ id: l.id }} className="block truncate font-medium hover:underline">
                          {l.name}
                        </Link>
                        <span className="font-mono text-xs text-muted-foreground">{l.id}</span>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={l.status} />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">{l.plan ? t(`plans.${l.plan}`, { defaultValue: l.plan }) : "—"}</TableCell>
                      <TableCell className="hidden md:table-cell">{date(l.paid_until)}</TableCell>
                      <TableCell className="tabular text-right whitespace-nowrap">{l.budget ? `${usd(l.spent)} / ${usd(l.budget)}` : "—"}</TableCell>
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

interface LicenseDetail {
  license: License;
  grants: Array<{ id: string; payment: string | null; budget: number; spent: number; starts: string; ends: string }>;
  payments: Payment[];
  servers: ServerSummary[];
}

export const LicensePage = () => {
  const { t } = useTranslation();
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
  const data = query.data;
  const license = data?.license;
  return (
    <>
      <PageHeader title={license?.name ?? id} description={<span className="font-mono text-xs">{id}</span>} actions={license && <StatusBadge status={license.status} />} />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {data && license && (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label={t("licenses.plan")} value={license.plan ? t(`plans.${license.plan}`, { defaultValue: license.plan }) : "—"} hint={license.renews ? t("licenses.renews") : undefined} />
            <StatTile label={t("licenses.paidUntil")} value={date(license.paid_until)} />
            <StatTile label={t("licenses.budgetNow")} value={`${usd(license.spent)} / ${usd(license.budget)}`} hint={t("licenses.used", { percent: license.used_percent })} />
            <StatTile label={t("licenses.resets")} value={date(license.resets_at)} />
          </div>
          <Card className="gap-4">
            <CardHeader>
              <CardTitle className="text-base">{t("licenses.details")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <Definition
                items={[
                  [t("licenses.created"), dateTime(license.created_at)],
                  [t("licenses.telegram"), license.telegram_user_id ? String(license.telegram_user_id) : t("licenses.unclaimed")],
                  [t("licenses.language"), license.language ?? "—"],
                  [t("licenses.lastPayment"), dateTime(license.last_payment_at)],
                  [t("licenses.stopped"), license.stopped_at ? dateTime(license.stopped_at) : "—"],
                  [t("licenses.blockedAt"), license.blocked_at ? dateTime(license.blocked_at) : "—"],
                ]}
              />
              {can("admin") && (
                <div className="flex flex-wrap gap-2">
                  <GrantDialog id={id} onDone={refresh} />
                  <ExtendDialog id={id} onDone={refresh} />
                  {license.blocked_at ? (
                    <Confirm label={t("licenses.unblock")} title={t("licenses.unblockTitle")} text={t("licenses.unblockText")} action={t("licenses.unblock")} onConfirm={() => toggleBlock(false)} />
                  ) : (
                    <Confirm label={t("licenses.block")} title={t("licenses.blockTitle")} text={t("licenses.blockText")} action={t("licenses.block")} destructive variant="outline" onConfirm={() => toggleBlock(true)} />
                  )}
                </div>
              )}
            </CardContent>
          </Card>
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">{t("licenses.windows")}</h2>
            <TableFrame>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("licenses.columns.from")}</TableHead>
                    <TableHead>{t("licenses.columns.to")}</TableHead>
                    <TableHead className="text-right">{t("licenses.columns.budget")}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t("licenses.columns.source")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.grants.map((g) => (
                    <TableRow key={g.id}>
                      <TableCell>{date(g.starts)}</TableCell>
                      <TableCell>{date(g.ends)}</TableCell>
                      <TableCell className="tabular text-right whitespace-nowrap">
                        {usd(g.spent)} / {usd(g.budget)}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">{g.payment ? t("licenses.fromPayment") : t("licenses.byHand")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableFrame>
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">{t("licenses.servers")}</h2>
            {data.servers.length === 0 ? (
              <Empty>{t("licenses.noServers")}</Empty>
            ) : (
              <Card className="py-2">
                <CardContent className="flex flex-col divide-y px-4">
                  {data.servers.map((s) => (
                    <div key={s.server_id ?? s.server} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <span className="font-mono text-xs">{s.server_id ?? t("licenses.unknownServer")}</span>
                      <span className="text-muted-foreground">
                        {t("licenses.serverLine", { questions: number(s.questions), players: number(s.players), cost: usd(s.cost), seen: relative(s.last_seen) })}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
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
