import { linkRoute } from "@/server/status-pages/link-page";
import { confirmSubscriber } from "@/server/status-pages/subscribers";

/** The link in the confirmation email. */
export const { GET, POST } = linkRoute({
  path: "confirm",
  title: "Confirm your subscription",
  text: "You will get incident and maintenance updates by email.",
  button: "Confirm",
  doneTitle: "You are subscribed",
  doneText: "Updates of this page now come to your inbox. Every email has a link to unsubscribe.",
  act: confirmSubscriber,
});
