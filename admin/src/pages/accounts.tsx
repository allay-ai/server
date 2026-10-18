import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { Confirm, ErrorBox, Loading, PageHeader, TableFrame } from "@/components/common";
import { FormField } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, post } from "@/lib/api";
import { dateTime, relative } from "@/lib/format";
import { showErrors } from "@/lib/forms";
import { useAppState } from "@/lib/session";
import type { Account, Role } from "@/lib/types";

const ROLES: Role[] = ["owner", "admin", "viewer"];

const RoleSelect = ({ value, onChange, id }: { value: Role; onChange: (role: Role) => void; id?: string }) => {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Role)}>
      <SelectTrigger id={id} className="w-full sm:w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((role) => (
          <SelectItem key={role} value={role}>
            {t(`roles.${role}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

const createSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{1,31}$/, "setup.errors.username"),
  password: z.string().min(10, "setup.errors.password").max(200),
  role: z.enum(["owner", "admin", "viewer"]),
});

const CreateDialog = ({ onDone }: { onDone: () => Promise<void> }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const form = useForm<z.infer<typeof createSchema>>({ resolver: zodResolver(createSchema), defaultValues: { username: "", password: "", role: "viewer" } });
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async (values) => {
    try {
      await post("/accounts", values);
      toast.success(t("accounts.created", { name: values.username }));
      setOpen(false);
      form.reset();
      await onDone();
    } catch (error) {
      showErrors(error, form.setError);
    }
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" aria-hidden />
          {t("accounts.add")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{t("accounts.addTitle")}</DialogTitle>
            <DialogDescription>{t("accounts.addText")}</DialogDescription>
          </DialogHeader>
          <FormField id="new-username" label={t("setup.username")} error={errors.username && t(errors.username.message!)} hint={t("setup.usernameHint")}>
            <Input id="new-username" autoComplete="off" autoCapitalize="none" spellCheck={false} {...form.register("username")} />
          </FormField>
          <FormField id="new-password" label={t("accounts.password")} error={errors.password && t(errors.password.message!)} hint={t("accounts.passwordHint")}>
            <Input id="new-password" type="password" autoComplete="new-password" {...form.register("password")} />
          </FormField>
          <FormField id="new-role" label={t("accounts.role")} hint={t("accounts.rolesHint")}>
            <Controller control={form.control} name="role" render={({ field }) => <RoleSelect id="new-role" value={field.value} onChange={field.onChange} />} />
          </FormField>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {t("accounts.add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const PasswordDialog = ({ account, onDone }: { account: Account; onDone: () => Promise<void> }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const form = useForm<{ password: string }>({ resolver: zodResolver(z.object({ password: z.string().min(10, "setup.errors.password").max(200) })), defaultValues: { password: "" } });
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async ({ password }) => {
    try {
      await api(`/accounts/${encodeURIComponent(account.username)}`, { method: "PATCH", body: { password } });
      toast.success(t("accounts.passwordReset", { name: account.username }));
      setOpen(false);
      form.reset();
      await onDone();
    } catch (error) {
      showErrors(error, form.setError);
    }
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          {t("accounts.resetPassword")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{t("accounts.resetTitle", { name: account.username })}</DialogTitle>
            <DialogDescription>{t("accounts.resetText")}</DialogDescription>
          </DialogHeader>
          <FormField id="reset-password" label={t("accounts.password")} error={errors.password && t(errors.password.message!)}>
            <Input id="reset-password" type="password" autoComplete="new-password" {...form.register("password")} />
          </FormField>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {t("accounts.resetPassword")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export const AccountsPage = () => {
  const { t } = useTranslation();
  const state = useAppState();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/accounts") });
  const refresh = () => client.invalidateQueries({ queryKey: ["accounts"] });
  const setRole = async (account: Account, role: Role) => {
    try {
      await api(`/accounts/${encodeURIComponent(account.username)}`, { method: "PATCH", body: { role } });
      toast.success(t("accounts.roleChanged", { name: account.username, role: t(`roles.${role}`) }));
      await refresh();
      if (account.username === state?.me?.username) await client.invalidateQueries({ queryKey: ["state"] });
    } catch (error) {
      showErrors(error);
    }
  };
  const remove = async (account: Account) => {
    try {
      await api(`/accounts/${encodeURIComponent(account.username)}`, { method: "DELETE" });
      toast.success(t("accounts.deleted", { name: account.username }));
      await refresh();
    } catch (error) {
      showErrors(error);
    }
  };
  return (
    <>
      <PageHeader title={t("accounts.title")} description={t("accounts.description")} actions={<CreateDialog onDone={refresh} />} />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {query.data && (
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("accounts.columns.name")}</TableHead>
                <TableHead>{t("accounts.columns.role")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("accounts.columns.lastLogin")}</TableHead>
                <TableHead className="text-right">{t("accounts.columns.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.accounts.map((account) => (
                <TableRow key={account.username}>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{account.username}</span>
                      {account.env && <Badge variant="secondary">{t("accounts.fromEnv")}</Badge>}
                      {account.username === state?.me?.username && <Badge variant="outline">{t("accounts.you")}</Badge>}
                    </div>
                    {account.created_by && <span className="text-xs text-muted-foreground">{t("accounts.createdBy", { name: account.created_by, date: dateTime(account.created_at) })}</span>}
                  </TableCell>
                  <TableCell>{account.env ? t(`roles.${account.role}`) : <RoleSelect value={account.role} onChange={(role) => setRole(account, role)} />}</TableCell>
                  <TableCell className="hidden md:table-cell">{account.last_login_at ? relative(account.last_login_at) : "—"}</TableCell>
                  <TableCell className="text-right">
                    {!account.env && (
                      <div className="flex justify-end gap-2">
                        <PasswordDialog account={account} onDone={refresh} />
                        <Confirm
                          label={t("accounts.delete")}
                          title={t("accounts.deleteTitle", { name: account.username })}
                          text={t("accounts.deleteText")}
                          action={t("accounts.delete")}
                          destructive
                          variant="outline"
                          onConfirm={() => remove(account)}
                        />
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      )}
    </>
  );
};
