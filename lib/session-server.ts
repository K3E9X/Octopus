// Server-side session reading. Split from lib/auth so a server component can ask
// "who is this?" without pulling the whole account module into a client bundle.

import { cookies } from "next/headers";
import { SESSION_COOKIE, readSession, getUser, authEnabled, sessionsUsable, type User } from "./auth";

export { authEnabled, sessionsUsable };

export async function currentUser(): Promise<User | null> {
  if (!authEnabled) return null;
  const id = readSession(cookies().get(SESSION_COOKIE)?.value);
  return id ? getUser(id) : null;
}

/** For routes that must be an administrator. Returns null when the caller is not. */
export async function requireAdmin(): Promise<User | null> {
  const u = await currentUser();
  return u && u.role === "admin" ? u : null;
}
