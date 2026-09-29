import { hostInfo } from "@/server/system";
import { HostTerminal } from "./host-terminal";

export const metadata = { title: "Terminal" };

export default async function ServerTerminalPage() {
  const host = await hostInfo();
  return <HostTerminal hostname={host.name} />;
}
