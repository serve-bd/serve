import { connection } from "next/server";
import { redirect } from "next/navigation";
import { getSession } from "@/server/auth";
import { isEmailConfigured } from "@/server/email/send";
import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata = { title: "Reset password" };

export default async function ForgotPasswordPage() {
  await connection();
  if (await getSession()) redirect("/");
  return <ForgotPasswordForm emailEnabled={await isEmailConfigured()} />;
}
