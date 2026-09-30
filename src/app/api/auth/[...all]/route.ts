import { getAuth } from "@/server/auth";
import { withSignInGuard } from "@/server/sso/domain-guard";

// Looked up per request: sign-in providers can change in settings without a restart.
async function handle(request: Request) {
  // Organizations, members and invitations go through Serve's own actions, which check roles and
  // limits. better-auth's endpoints for them would skip those checks (and list invitation ids).
  if (new URL(request.url).pathname.startsWith("/api/auth/organization/")) return Response.json({ message: "Not found" }, { status: 404 });
  const auth = await getAuth();
  return withSignInGuard(() => auth.handler(request));
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
