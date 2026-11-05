import SearchApp from "@/components/SearchApp";

// The product. Anyone can open it; running a search needs an account, a declared basis
// and, where the deployment meters, credits. The component and /api/search enforce it.
export const dynamic = "force-dynamic";

export default function Page() {
  return <SearchApp />;
}
