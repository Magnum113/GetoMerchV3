import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Shirt } from "lucide-react";
import { LoginForm } from "./login-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAuthCookieName, verifySessionToken } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(getAuthCookieName())?.value;
  const isAuthenticated = await verifySessionToken(token, process.env.ADMIN_AUTH_COOKIE_SECRET);
  if (isAuthenticated) redirect("/");

  return (
    <div className="min-h-screen bg-muted/30 px-4 py-8">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-sm flex-col justify-center">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="rounded-lg bg-primary p-2 text-primary-foreground">
            <Shirt className="h-5 w-5" />
          </div>
          <div className="text-lg font-semibold tracking-tight">GetoMerch</div>
        </div>
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>Вход в админку</CardTitle>
            <CardDescription>Введите пароль владельца для доступа.</CardDescription>
          </CardHeader>
          <CardContent>
            <LoginForm />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
