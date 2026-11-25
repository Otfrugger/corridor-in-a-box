import Link from "next/link";
import { SendApp } from "@/components/send/SendApp";
import { corridors } from "@/lib/corridors";
import { sendOptionsFromCorridors } from "@/lib/send";

export const metadata = {
  title: "Send — corridor-in-a-box",
  description:
    "Testnet reference send app: plan a payment, pick a route, enter the recipient's details and watch it arrive. Test tokens only.",
};

// Destinations and source assets come from the testnet corridor manifests, not
// from a list typed out here.
const { destinations, sourceAssets } = sendOptionsFromCorridors(corridors);

// The send app (RFC 0004 §6). Route planning and the anchor's field lookup are
// injected into <SendApp>; @corridor/service does not offer either yet, so this
// page renders it without them and the app says so rather than invent routes.
export default function SendPage() {
  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-3xl font-bold tracking-tight text-balance">Send a testnet payment</h1>
        <p className="mt-2 max-w-prose text-secondary-text">
          A small reference app on <code>@corridor/service</code>. Choose an amount and a
          destination, compare the routes with their price labels, then fill in exactly what the
          receiving anchor asks for. To drive the engine directly, use the{" "}
          <Link
            href="/payments"
            className="font-medium text-primary-text underline underline-offset-4 hover:text-accent"
          >
            payment runner
          </Link>
          .
        </p>
      </header>

      <SendApp destinations={destinations} sourceAssets={sourceAssets} />
    </div>
  );
}
