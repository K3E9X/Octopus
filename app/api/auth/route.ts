// Sign in, register, sign out. One route, three intents.

import { NextRequest, NextResponse } from "next/server";
import { createUser, verifyUser, countUsers, signSession, SESSION_COOKIE, SESSION_MAX_AGE, authEnabled, sessionsUsable } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function setCookie(res: NextResponse, token: string) {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE,
  });
}

export async function POST(req: NextRequest) {
  if (!authEnabled) {
    return NextResponse.json({ error: "This deployment has no database, so it has no accounts. It runs in single-operator mode and the tool is open." }, { status: 501 });
  }
  if (!sessionsUsable()) {
    return NextResponse.json({ error: "Set OCTOPUS_SESSION_SECRET (16+ characters) — without it sessions cannot be signed, and a shared fallback secret would let any deployment forge another's." }, { status: 501 });
  }
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad request" }, { status: 400 }); }
  const action = String(body?.action || "signin");

  if (action === "signout") {
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    return res;
  }

  const email = String(body?.email || "");
  const password = String(body?.password || "");

  if (action === "register") {
    const r = await createUser(email, password, body?.name ? String(body.name).slice(0, 80) : undefined);
    if (r.error || !r.user) return NextResponse.json({ error: r.error || "could not create the account" }, { status: 400 });
    const res = NextResponse.json({ ok: true, user: r.user, firstAccount: r.user.role === "admin" });
    setCookie(res, signSession(r.user.id));
    return res;
  }

  const user = await verifyUser(email, password);
  // one message for both failures: telling an attacker which half was wrong is free
  // help, and telling a disabled account it is disabled is the same leak
  if (!user) return NextResponse.json({ error: "wrong address or password, or the account is disabled" }, { status: 401 });
  const res = NextResponse.json({ ok: true, user });
  setCookie(res, signSession(user.id));
  return res;
}

// GET → what the sign-in page needs to render itself honestly
export async function GET() {
  return NextResponse.json({
    authEnabled,
    sessionsUsable: sessionsUsable(),
    firstAccount: authEnabled ? (await countUsers()) === 0 : false,
  });
}
