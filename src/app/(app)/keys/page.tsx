import { redirect } from "next/navigation";

export default function KeysIndex() {
  redirect("/keys/api-tokens");
}
