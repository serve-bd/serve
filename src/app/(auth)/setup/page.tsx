import { redirect } from "next/navigation";
import { userCount } from "@/server/accounts";
import { SetupForm } from "./setup-form";

export const metadata = { title: "Set up Serve" };

export default async function SetupPage() {
  if ((await userCount()) > 0) redirect("/login");
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold">Set up your server</h1>
        <p className="text-[13px] leading-relaxed text-muted">
          Create the owner account. You will be the owner of the <span className="font-medium text-fg-2">Root</span>{" "}
          organization, which manages this server.
        </p>
      </div>
      <SetupForm />
    </div>
  );
}
