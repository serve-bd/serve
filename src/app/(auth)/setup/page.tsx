import { connection } from "next/server";
import { redirect } from "next/navigation";
import { userCount } from "@/server/accounts";
import { SetupForm } from "./setup-form";

export const metadata = { title: "Set up Serve" };

export default async function SetupPage() {
  await connection();
  if ((await userCount()) > 0) redirect("/login");
  return <SetupForm />;
}
