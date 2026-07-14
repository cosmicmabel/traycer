import { defineRpcContract } from "@cic/protocol/framework/index";
import {
  migratePhaseToEpicRequestSchema,
  migratePhaseToEpicResponseSchema,
} from "@cic/protocol/host/migration/unary-schemas";
import { migrationRunV10 } from "@cic/protocol/host/migration/run";

export const phaseMigrateToEpicV10 = defineRpcContract({
  method: "phase.migrateToEpic",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: migratePhaseToEpicRequestSchema,
  responseSchema: migratePhaseToEpicResponseSchema,
});

export { migrationRunV10 };
