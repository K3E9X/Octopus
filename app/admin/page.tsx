import Admin from "@/components/Admin";
import { requireAdmin, authEnabled } from "@/lib/session-server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Page() {
  if (!authEnabled) return <Admin disabledReason="This deployment has no database, so it has no accounts to administer. Set POSTGRES_URL." />;
  const admin = await requireAdmin();
  if (!admin) redirect("/signin?next=/admin");
  return <Admin me={{ id: admin.id, email: admin.email }} />;
}
