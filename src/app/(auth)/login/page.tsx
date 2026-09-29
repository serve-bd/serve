import { connection } from "next/server";
import { redirect } from "next/navigation";
import { userCount } from "@/server/accounts";
import { getSession, passwordLoginAllowed } from "@/server/auth";
import { isEmailConfigured } from "@/server/email/send";
import { getSetting } from "@/server/settings";
import { activeProviders, buttonLabel } from "@/server/sso/config";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage(props: PageProps<"/login">) {
  await connection();
  if ((await userCount()) === 0) redirect("/setup");
  if (await getSession()) redirect("/");
  const { next, error } = await props.searchParams;
  const [signIn, password, canReset] = await Promise.all([getSetting("signIn"), passwordLoginAllowed(), isEmailConfigured()]);
  return (
    <LoginForm
      next={typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/"}
      canReset={canReset && password}
      password={password}
      providers={activeProviders(signIn).map((id) => ({ id, label: buttonLabel(id, signIn.providers[id]) }))}
      ssoError={typeof error === "string" ? error : null}
    />
  );
}
