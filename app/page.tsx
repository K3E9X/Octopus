import Landing from "@/components/Landing";
import { currentUser, authEnabled } from "@/lib/session-server";
// Built here rather than in the component: buildReport pulls in libphonenumber, and a
// 150 KB parser has no business in the bundle of the page people see first. The report
// is plain data, so it crosses as a prop.
import { demoReport } from "@/lib/demo";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = authEnabled ? await currentUser() : null;
  return <Landing signedIn={!authEnabled || !!user} demo={demoReport()} />;
}
