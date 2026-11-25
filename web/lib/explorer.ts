// stellar.expert links for on-chain facts shown on the page. Pure, so the URL
// shapes are tested without rendering anything (tests/web-explorer.test.ts).

const BASE = "https://stellar.expert/explorer";

/** A link to a transaction, such as a payment's settlement. */
export function txUrl(network: string, hash: string): string {
  return `${BASE}/${network}/tx/${hash}`;
}

/** Stellar transaction hashes are 32 bytes of hex; mock settlements use other ids. */
export function isTxHash(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

/** A link to the ledger an attestation was recorded in. */
export function ledgerUrl(network: string, ledger: number): string {
  return `${BASE}/${network}/ledger/${ledger}`;
}

/**
 * A link to the attesting address. Stellar addresses starting `C` are contracts
 * and `G` are accounts, and the explorer serves them under different paths.
 */
export function addressUrl(network: string, address: string): string {
  const kind = address.startsWith("C") ? "contract" : "account";
  return `${BASE}/${network}/${kind}/${address}`;
}

/** `GABCD…WXYZ`: enough to recognise an address, the full one stays in `title`. */
export function shortAddress(address: string): string {
  return address.length <= 13 ? address : `${address.slice(0, 5)}…${address.slice(-5)}`;
}
