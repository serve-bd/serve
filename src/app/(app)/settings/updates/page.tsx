import { currentCommit, currentVersion, updateRepository } from "@/server/instance/version";
import { installMode, updateAvailable } from "@/server/instance/updates";
import { getSettings } from "@/server/settings";
import { UpdatesView } from "./updates-view";

export const metadata = { title: "Updates" };

export default async function UpdatesPage() {
  const s = await getSettings();
  return (
    <UpdatesView
      version={currentVersion()}
      commit={currentCommit()}
      repository={updateRepository()}
      mode={installMode()}
      enabled={s.updateCheckEnabled}
      check={s.updateCheck}
      available={updateAvailable(s.updateCheck)}
      run={s.updateRun}
    />
  );
}
