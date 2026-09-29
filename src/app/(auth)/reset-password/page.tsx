import { connection } from "next/server";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage(props: PageProps<"/reset-password">) {
  await connection();
  const { token, error } = await props.searchParams;
  return <ResetPasswordForm token={typeof token === "string" ? token : null} invalid={error === "INVALID_TOKEN"} />;
}
