import { SendApp } from "@/components/send/SendApp";

export const metadata = {
  title: "Send Testnet Payment — corridor-in-a-box",
  description:
    "Reference Send Application: testnet-only sender interface to plan routes, lock quotes, specify recipient details, and watch payments settle.",
};

export default function SendPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-primary-text">Send Payment</h1>
        <p className="mt-1 text-sm text-secondary-text">
          Reference send application (RFC 0004 §6). Plan optimal corridors, select ranked quotes,
          provide anchor-required recipient fields, and test end-to-end settlement on Stellar Testnet.
        </p>
      </div>

      <SendApp />
    </div>
  );
}
