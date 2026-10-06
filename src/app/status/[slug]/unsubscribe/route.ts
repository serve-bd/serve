import { linkRoute } from "@/server/status-pages/link-page";
import { removeSubscriber } from "@/server/status-pages/subscribers";

/** The link in every email; mail apps also POST here for one-click unsubscribe. */
export const { GET, POST } = linkRoute({
  path: "unsubscribe",
  title: "Unsubscribe",
  text: "You will no longer get updates of this page.",
  button: "Unsubscribe",
  doneTitle: "You are unsubscribed",
  doneText: "No more updates of this page will be sent to you.",
  act: removeSubscriber,
});
