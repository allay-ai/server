import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { Trans, useTranslation } from "react-i18next";
import { z } from "zod";
import { AuthFrame } from "@/components/auth-frame";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { post } from "@/lib/api";
import { showErrors } from "@/lib/forms";
import { resetSession, useAppState } from "@/lib/session";

const schema = z
  .object({
    code: z.string().trim().min(1, "setup.errors.code"),
    username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{1,31}$/, "setup.errors.username"),
    password: z.string().min(10, "setup.errors.password").max(200),
    repeat: z.string(),
  })
  .refine((v) => v.password === v.repeat, { path: ["repeat"], message: "setup.errors.repeat" });

type Values = z.infer<typeof schema>;

/** The first admin account: a code from /allay init or the backend's log, a name, and a password twice. */
export const SetupPage = () => {
  const { t } = useTranslation();
  const state = useAppState();
  const { code } = useSearch({ from: "/setup" });
  const navigate = useNavigate();
  const client = useQueryClient();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { code: code ?? "", username: "", password: "", repeat: "" } });
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async ({ code, username, password }) => {
    try {
      await post("/setup", { code, username, password });
      // The code is spent: drop it from the address bar and the history.
      window.history.replaceState(null, "", window.location.pathname);
      await resetSession(client);
      await navigate({ to: "/" });
    } catch (error) {
      showErrors(error, form.setError);
    }
  });
  const fromLog = state?.setup === "log";
  return (
    <AuthFrame title={t("setup.title")} description={<Trans i18nKey={fromLog ? "setup.fromLog" : "setup.fromGame"} components={{ code: <code className="font-mono text-foreground" /> }} />}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {!code && (
          <FormField id="code" label={t("setup.code")} error={errors.code && t(errors.code.message!)}>
            <Input id="code" autoComplete="off" spellCheck={false} aria-invalid={!!errors.code} {...form.register("code")} />
          </FormField>
        )}
        <FormField id="username" label={t("setup.username")} error={errors.username && t(errors.username.message!)} hint={t("setup.usernameHint")}>
          <Input id="username" autoComplete="username" autoCapitalize="none" spellCheck={false} aria-invalid={!!errors.username} {...form.register("username")} />
        </FormField>
        <FormField id="password" label={t("setup.password")} error={errors.password && t(errors.password.message!)} hint={t("setup.passwordHint")}>
          <Input id="password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...form.register("password")} />
        </FormField>
        <FormField id="repeat" label={t("setup.repeat")} error={errors.repeat && t(errors.repeat.message!)}>
          <Input id="repeat" type="password" autoComplete="new-password" aria-invalid={!!errors.repeat} {...form.register("repeat")} />
        </FormField>
        <Button type="submit" disabled={isSubmitting}>
          {t("setup.submit")}
        </Button>
      </form>
    </AuthFrame>
  );
};
