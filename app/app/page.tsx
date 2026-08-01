import OrbitBoard from "@/components/OrbitBoard";
import { currentUser, authEnabled } from "@/lib/session-server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function AppPage() {
  // With a database the tool is behind an account; without one there is nowhere to
  // keep accounts, so the deployment is single-operator and the tool is open.
  if (authEnabled) {
    const user = await currentUser();
    if (!user) redirect("/signin?next=/app");
  }
  return <OrbitBoard />;
}
