import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Trans, useTranslation } from "react-i18next";
import { z } from "zod";
import { AuthFrame } from "@/components/auth-frame";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, post } from "@/lib/api";
import { showErrors } from "@/lib/forms";
import { resetSession } from "@/lib/session";

const schema = z
  .object({
    code: z.string().trim().min(1, "recover.errors.code"),
    username: z.string().trim().toLowerCase().min(1, "recover.errors.username"),
    password: z.string().min(10, "recover.errors.password").max(200),
    repeat: z.string(),
  })
  .refine((v) => v.password === v.repeat, { path: ["repeat"], message: "recover.errors.repeat" });

type Values = z.infer<typeof schema>;

const code = <code className="font-mono text-foreground" />;

/** A forgotten password: a code from /allay init, the account's name, and a new password twice. */
export const RecoverPage = () => {
  const { t } = useTranslation();
  const search = useSearch({ from: "/recover" });
  // The link's code is kept in the form and dropped from the address bar and the history at once.
  const [linked] = useState(() => search.code ?? "");
  const navigate = useNavigate();
  const client = useQueryClient();
  useEffect(() => {
    if (search.code) void navigate({ to: "/recover", search: {}, replace: true });
  }, [search.code, navigate]);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { code: linked, username: "", password: "", repeat: "" } });
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async ({ code, username, password }) => {
    try {
      await post("/recover", { code, username, password });
      await resetSession(client);
      await navigate({ to: "/" });
    } catch (error) {
      const failed = error instanceof ApiError ? error.code : "";
      // A wrong code from the link has no field to show it on, so it goes under the password.
      if (failed === "BAD_CODE") form.setError(linked ? "password" : "code", { message: "recover.errors.badCode" });
      else if (failed === "RATE_LIMITED") form.setError("password", { message: "recover.errors.limited" });
      else if (failed === "NO_ACCOUNT") form.setError("username", { message: "recover.errors.noAccount" });
      else if (failed === "ENV_ADMIN") form.setError("username", { message: "recover.errors.envAdmin" });
      else showErrors(error, form.setError);
    }
  });
  return (
    <AuthFrame title={t("recover.title")} description={<Trans i18nKey="recover.fromGame" components={{ code }} />}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {!linked && (
          <FormField id="code" label={t("recover.code")} error={errors.code && t(errors.code.message!)} hint={<Trans i18nKey="recover.codeHint" components={{ code }} />}>
            <Input id="code" autoComplete="off" spellCheck={false} aria-invalid={!!errors.code} {...form.register("code")} />
          </FormField>
        )}
        <FormField id="username" label={t("recover.username")} error={errors.username && t(errors.username.message!)}>
          <Input id="username" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus={!!linked} aria-invalid={!!errors.username} {...form.register("username")} />
        </FormField>
        <FormField id="password" label={t("recover.password")} error={errors.password && t(errors.password.message!)} hint={t("recover.passwordHint")}>
          <Input id="password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...form.register("password")} />
        </FormField>
        <FormField id="repeat" label={t("recover.repeat")} error={errors.repeat && t(errors.repeat.message!)}>
          <Input id="repeat" type="password" autoComplete="new-password" aria-invalid={!!errors.repeat} {...form.register("repeat")} />
        </FormField>
        <Button type="submit" disabled={isSubmitting}>
          {t("recover.submit")}
        </Button>
        <Link to="/login" className="text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          {t("recover.back")}
        </Link>
      </form>
    </AuthFrame>
  );
};
