import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "./logo";

export const AuthFrame = ({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) => (
  <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
    <Logo />
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl">{title}</h1>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  </div>
);
