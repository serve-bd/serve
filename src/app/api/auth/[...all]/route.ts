import { getAuth } from "@/server/auth";
import { withSignInGuard } from "@/server/sso/domain-guard";

// Looked up per request: sign-in providers can change in settings without a restart.
async function handle(request: Request) {
  const auth = await getAuth();
  return withSignInGuard(() => auth.handler(request));
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
