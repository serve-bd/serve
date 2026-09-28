import { connection } from "next/server";
import { redirect } from "next/navigation";
import { userCount } from "@/server/accounts";
import { getSession } from "@/server/auth";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage(props: PageProps<"/login">) {
  await connection();
  if ((await userCount()) === 0) redirect("/setup");
  if (await getSession()) redirect("/");
  const { next } = await props.searchParams;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="text-[13px] text-muted">Welcome back. Sign in to manage your deployments.</p>
      </div>
      <LoginForm next={typeof next === "string" && next.startsWith("/") ? next : "/"} />
    </div>
  );
}
