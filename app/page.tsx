import Landing from "@/components/Landing";
import { currentUser, authEnabled } from "@/lib/session-server";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = authEnabled ? await currentUser() : null;
  return <Landing signedIn={!authEnabled || !!user} />;
}
