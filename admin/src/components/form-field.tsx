import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";

/** A label, the control, and its hint or error under it, tied together for screen readers. */
export const FormField = ({ id, label, error, hint, children }: { id: string; label: ReactNode; error?: string; hint?: ReactNode; children: ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    <Label htmlFor={id}>{label}</Label>
    {children}
    {error ? (
      <p id={`${id}-error`} className="text-xs text-destructive">
        {error}
      </p>
    ) : (
      hint && <p className="text-xs text-muted-foreground">{hint}</p>
    )}
  </div>
);
