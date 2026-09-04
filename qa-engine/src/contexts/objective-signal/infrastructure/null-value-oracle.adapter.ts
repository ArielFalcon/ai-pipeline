// qa-engine/src/contexts/objective-signal/infrastructure/null-value-oracle.adapter.ts
// ValueOraclePort for qa.valueOracle:"off" (and the shadow-aware default). measure() returns a
// null score with zero mutants and never re-runs the suite — no fault-injection against DEV, no
// Stryker. Signal-only by contract: a null valueScore never gates publish.
import type { ValueOraclePort, ValueOracleResult } from "../application/ports/index.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";

export class NullValueOracleAdapter implements ValueOraclePort {
  async measure(_br: BlastRadius, _repoDir: string, _namespace: string, _baselineCases?: string[]): Promise<ValueOracleResult> {
    return {
      valueScore: null,
      mutantCount: 0,
      killedCount: 0,
      details: "valueOracle is off — no fault-injection or mutation scoring this run",
    };
  }
}
