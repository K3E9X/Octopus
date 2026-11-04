import CheckApp from "@/components/CheckApp";

// The consumer product lives at its own route, distinct from the operator console at /app.
// Anyone can open it; running a check still requires an account and proof of ownership,
// which the component and /api/check enforce.
export const dynamic = "force-dynamic";

export default function Page() {
  return <CheckApp />;
}
