import { getAuth } from "@/server/auth";

// Looked up per request: sign-in providers can change in settings without a restart.
async function handle(request: Request) {
  return (await getAuth()).handler(request);
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
