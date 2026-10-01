import { redirect } from "next/navigation";

/** The dashboard domain and TLS settings moved to General. */
export default function DashboardSettingsPage() {
  redirect("/settings");
}
