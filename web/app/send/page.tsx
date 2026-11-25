import Link from "next/link";

export const metadata = {
  title: "Send — corridor-in-a-box",
  description:
    "Testnet reference send app: plan a payment, pick a route, enter the recipient's details and watch it arrive. Test tokens only.",
};

// The steps of the send app (RFC 0004 §6). Each one is built in its own issue;
// this page is the scaffold they plug into.
const steps = [
  {
    title: "Amount and destination",
    body: "Choose how much to send and the country and currency it should arrive in.",
  },
  {
    title: "Pick a route",
    body: "Compare the routes the router finds. Each price is labelled locked, indicative or estimated, with the reason it was ranked where it is.",
  },
  {
    title: "Recipient details",
    body: "Fill in exactly the fields the receiving anchor asks for, nothing more.",
  },
  {
    title: "Send and watch it arrive",
    body: "Send the testnet payment and follow it until the anchor reports it complete.",
  },
];

export default function SendPage() {
  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-3xl font-bold tracking-tight text-balance">Send a testnet payment</h1>
        <p className="mt-2 max-w-prose text-secondary-text">
          A small reference app on <code>@corridor/service</code>. It walks one payment from
          plan to arrival on the Stellar test network. The steps below are being built; until
          they land, use the payment runner to drive the engine.
        </p>
      </header>

      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => (
          <li
            key={s.title}
            className="flex gap-4 rounded-lg border border-border bg-bg-subtle px-4 py-3"
          >
            <span
              aria-hidden
              className="mt-0.5 text-sm font-semibold tabular-nums text-secondary-text"
            >
              {i + 1}
            </span>
            <div className="min-w-0">
              <h2 className="font-medium">{s.title}</h2>
              <p className="mt-0.5 text-sm text-secondary-text">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Link
          href="/payments"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:opacity-90 active:translate-y-px"
        >
          Open the payment runner
        </Link>
        <Link
          href="/docs"
          className="text-sm font-medium text-secondary-text underline-offset-4 transition-colors hover:text-primary-text hover:underline"
        >
          Read the docs
        </Link>
      </div>
    </div>
  );
}
