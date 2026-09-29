import { getSetting } from "@/server/settings";
import { EmailSettingsForm } from "./email-settings";

export const metadata = { title: "Email" };

export default async function EmailSettingsPage() {
  const email = await getSetting("email");
  return (
    <EmailSettingsForm
      initial={
        email
          ? {
              provider: email.provider,
              fromName: email.fromName,
              fromAddress: email.fromAddress,
              smtpHost: email.smtp?.host ?? "",
              smtpPort: email.smtp?.port ?? 587,
              smtpSecurity: email.smtp?.security ?? "starttls",
              smtpUsername: email.smtp?.username ?? "",
              hasPassword: !!email.smtp?.password,
              hasApiKey: !!email.apiKey,
            }
          : null
      }
    />
  );
}
