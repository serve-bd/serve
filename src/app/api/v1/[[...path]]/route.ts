import { handleApi } from "@/server/api";

export const dynamic = "force-dynamic";

// The path as sent, decoded once by the router: Next.js hands over decoded segments, so a value
// with an encoded "/" (a compose backup key like dir:/srv/data) would split, and one with "%" would
// be decoded twice.
const handle = async (request: Request) => handleApi(request, new URL(request.url).pathname.replace(/^\/api\/v1\/?/, ""));

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
