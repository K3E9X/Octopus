import Admin from "@/components/Admin";
import { requireAdmin, authEnabled } from "@/lib/session-server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Page() {
  // No database means no accounts to administer AND nowhere to keep the source token,
  // so the screen says both rather than showing fields that would silently do nothing.
  if (!authEnabled) {
    return <Admin disabledReason="This deployment has no database, so it has no accounts to administer and nowhere to store the LeakOSINT token. Set POSTGRES_URL to enable accounts, metering and the audit trail; until then the token must come from LEAKOSINT_TOKEN in the environment." />;
  }
  const admin = await requireAdmin();
  if (!admin) redirect("/signin?next=/admin");
  return <Admin me={{ id: admin.id, email: admin.email }} />;
}
