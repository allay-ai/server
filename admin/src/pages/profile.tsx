import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { PageHeader } from "@/components/common";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiError, post } from "@/lib/api";
import { showErrors } from "@/lib/forms";
import { useAppState } from "@/lib/session";

const schema = z
  .object({ current: z.string().min(1, "profile.errors.current"), password: z.string().min(10, "setup.errors.password").max(200), repeat: z.string() })
  .refine((v) => v.password === v.repeat, { path: ["repeat"], message: "setup.errors.repeat" });

export const ProfilePage = () => {
  const { t } = useTranslation();
  const state = useAppState();
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { current: "", password: "", repeat: "" } });
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async ({ current, password }) => {
    try {
      await post("/me/password", { current, password });
      toast.success(t("profile.changed"));
      form.reset();
    } catch (error) {
      if (error instanceof ApiError && error.code === "BAD_CREDENTIALS") form.setError("current", { message: "profile.errors.wrong" });
      else showErrors(error, form.setError);
    }
  });
  return (
    <>
      <PageHeader title={t("profile.title")} description={state?.me ? t("profile.description", { name: state.me.username, role: t(`roles.${state.me.role}`) }) : undefined} />
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle className="text-base">{t("profile.password")}</CardTitle>
          <CardDescription>{state?.me?.env ? t("profile.envAccount") : t("profile.passwordHint")}</CardDescription>
        </CardHeader>
        {!state?.me?.env && (
          <CardContent>
            <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
              <FormField id="current" label={t("profile.current")} error={errors.current && t(errors.current.message!)}>
                <Input id="current" type="password" autoComplete="current-password" {...form.register("current")} />
              </FormField>
              <FormField id="password" label={t("profile.new")} error={errors.password && t(errors.password.message!)}>
                <Input id="password" type="password" autoComplete="new-password" {...form.register("password")} />
              </FormField>
              <FormField id="repeat" label={t("setup.repeat")} error={errors.repeat && t(errors.repeat.message!)}>
                <Input id="repeat" type="password" autoComplete="new-password" {...form.register("repeat")} />
              </FormField>
              <Button type="submit" disabled={isSubmitting} className="self-start">
                {t("profile.save")}
              </Button>
            </form>
          </CardContent>
        )}
      </Card>
    </>
  );
};
