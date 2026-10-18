import type { FieldValues, Path, UseFormSetError } from "react-hook-form";
import { toast } from "sonner";
import { ApiError } from "./api";
import i18n from "i18next";

/** Puts the backend's per-field errors on the form's fields, and the rest in a toast. */
export const showErrors = <T extends FieldValues>(error: unknown, setError?: UseFormSetError<T>) => {
  if (error instanceof ApiError) {
    const fields = Object.entries(error.fields);
    if (setError && fields.length) for (const [name, message] of fields) setError(name as Path<T>, { message });
    else toast.error(error.message);
    return;
  }
  toast.error(i18n.t("errors.network"));
};
