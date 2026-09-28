import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth";

export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(auth);
