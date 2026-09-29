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
  return <LoginForm next={typeof next === "string" && next.startsWith("/") ? next : "/"} />;
}
