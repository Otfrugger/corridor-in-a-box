// Planner step skipping candidates whose lane circuit breaker is open (#607).

/** Structural projection matching `@corridor/engine`'s `BreakerRecord`. */
export interface BreakerStatusRecord {
  readonly state: "closed" | "open";
  readonly trippedAt?: number;
  readonly lastError?: string;
}

/** Structural store interface matching `CorridorHealthStore` without a runtime cycle. */
export interface BreakerStateReader {
  get(corridorId: string): Promise<BreakerStatusRecord | undefined>;
}

export interface BreakerFilterCandidate {
  readonly domain: string;
  readonly receivingDomain?: string;
  readonly corridorId?: string;
  readonly protocol?: string;
}

export interface BreakerDroppedCandidate {
  readonly domain: string;
  readonly receivingDomain: string;
  readonly corridorId?: string;
  readonly protocol?: string;
  readonly dropped: true;
  readonly reason: string;
}

export interface BreakerFilterResult<T extends BreakerFilterCandidate> {
  readonly offered: readonly T[];
  readonly dropped: readonly BreakerDroppedCandidate[];
}

/**
 * Filter candidate routes against the circuit breaker store. Any candidate
 * whose breaker is `"open"` is dropped with `'circuit breaker open since <time>'`.
 */
export async function filterByCircuitBreaker<T extends BreakerFilterCandidate>(
  candidates: readonly T[],
  breakers: BreakerStateReader,
): Promise<BreakerFilterResult<T>> {
  const checks = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      record: await breakers.get(candidate.corridorId ?? candidate.domain),
    })),
  );

  const offered: T[] = [];
  const dropped: BreakerDroppedCandidate[] = [];

  for (const { candidate, record } of checks) {
    if (record?.state === "open") {
      const since =
        record.trippedAt !== undefined ? new Date(record.trippedAt).toISOString() : "unknown";
      dropped.push({
        domain: candidate.domain,
        receivingDomain: candidate.receivingDomain ?? candidate.domain,
        corridorId: candidate.corridorId,
        protocol: candidate.protocol,
        dropped: true,
        reason: `circuit breaker open since ${since}`,
      });
      continue;
    }
    offered.push(candidate);
  }

  return { offered, dropped };
}
