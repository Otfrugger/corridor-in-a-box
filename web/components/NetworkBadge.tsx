import { Badge } from "@/components/ui/Badge";
import { NETWORK_LABEL, type NetworkId } from "@/lib/network";

/**
 * Which network the numbers on a card come from.
 *
 * Every card carries one, so a figure is never read without its network. Mainnet is the
 * coloured one: it is where the money is real, and it should be the one that stands out.
 */
export function NetworkBadge({ network }: { network: NetworkId }) {
  return (
    <Badge variant={network === "public" ? "info" : "default"}>
      <span className="sr-only">Network: </span>
      {NETWORK_LABEL[network]}
    </Badge>
  );
}
