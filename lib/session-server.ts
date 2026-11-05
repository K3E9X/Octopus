// Server-side session reading. Split from lib/auth so a server component can ask
// "who is this?" without pulling the whole account module into a client bundle.

import { cookies } from "next/headers";
import { SESSION_COOKIE, readSession, getUser, authEnabled, sessionsUsable, isAtLeast, type User } from "./auth";

export { authEnabled, sessionsUsable };

/**
 * Who is this?
 *
 * The role is re-read from the database on every request and a disabled account
 * resolves to nobody. lib/auth justifies its stateless cookie by saying "revocation is
 * handled by the role check that follows it" — there was no such check anywhere, so a
 * disabled or fired analyst kept working, and kept spending the operator's upstream
 * balance, for the full fourteen days of their cookie. Signing out and changing a
 * password were equally cosmetic.
 *
 * This is where that check lives, so no route can forget it.
 */
export async function currentUser(): Promise<User | null> {
  if (!authEnabled) return null;
  const id = readSession(cookies().get(SESSION_COOKIE)?.value);
  if (!id) return null;
  const user = await getUser(id);
  if (!user || user.role === "disabled") return null;
  return user;
}

/** For routes an administrator may reach. An owner outranks an admin, so it passes too. */
export async function requireAdmin(): Promise<User | null> {
  const u = await currentUser();
  return u && isAtLeast(u.role, "admin") ? u : null;
}

/**
 * For the two powers reserved to whoever pays the bill: creating credit, and holding
 * the source token. An admin runs the deployment; only an owner decides how much of
 * the upstream balance gets spent, because an audit trail signed by someone who can
 * also mint the budget proves nothing.
 */
export async function requireOwner(): Promise<User | null> {
  const u = await currentUser();
  return u && u.role === "owner" ? u : null;
}
