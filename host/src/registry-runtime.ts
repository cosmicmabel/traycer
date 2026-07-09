import type { z } from "zod";
import type {
  SchemaVersion,
  VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import type { ConnectionManifest } from "@traycer/protocol/framework/ws-protocol";

/**
 * Runtime accessors over the validated `hostRpcRegistry` /
 * `hostStreamRpcRegistry` objects.
 *
 * The framework's transform runners (`upgradeRequestToVersion`, ...) are
 * typed with const-generic installed versions for compile-time callers; a
 * server dispatching on wire-supplied `{method, schemaVersion}` values needs
 * the same walks over the registry's documented runtime shape
 * (versioned-rpc-types.ts `MajorVersionLine`/`VersionEntry`):
 *
 *   registry[method][major] = {
 *     latestMinor,
 *     versions: { [minor]: { contract, upgradeFromPreviousVersion } },
 *     downgradePathsFromLatest: { [major]: { downgradeRequest, downgradeResponse } },
 *   }
 *
 * Every read below goes through `Reflect.get` + runtime type checks, so a
 * malformed registry fails loudly instead of via unsafe casts.
 */

export interface RuntimeContract {
  readonly method: string;
  readonly schemaVersion: SchemaVersion;
  readonly requestSchema: z.ZodType;
  readonly responseSchema: z.ZodType;
}

interface RuntimeVersionEntry {
  readonly contract: RuntimeContract;
  readonly upgradeRequest: ((request: unknown) => unknown) | null;
  readonly upgradeResponse: ((response: unknown) => unknown) | null;
}

export type DowngradeOutcome =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

interface RuntimeDowngradePath {
  readonly downgradeRequest: (request: unknown) => DowngradeOutcome;
  readonly downgradeResponse: (response: unknown) => DowngradeOutcome;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asFunction(value: unknown): ((input: unknown) => unknown) | null {
  return typeof value === "function"
    ? (value as (input: unknown) => unknown)
    : null;
}

function readContract(value: unknown): RuntimeContract {
  const record = asRecord(value);
  if (record === null) {
    throw new Error("registry entry has no contract object");
  }
  const method = record.method;
  const schemaVersion = asRecord(record.schemaVersion);
  const requestSchema = asRecord(record.requestSchema);
  const responseSchema = asRecord(record.responseSchema);
  if (
    typeof method !== "string" ||
    schemaVersion === null ||
    typeof schemaVersion.major !== "number" ||
    typeof schemaVersion.minor !== "number" ||
    requestSchema === null ||
    responseSchema === null
  ) {
    throw new Error("registry contract is malformed");
  }
  const parseRequest = asFunction(Reflect.get(requestSchema, "safeParse"));
  const parseResponse = asFunction(Reflect.get(responseSchema, "safeParse"));
  if (parseRequest === null || parseResponse === null) {
    throw new Error("registry contract schemas are not zod schemas");
  }
  return {
    method,
    schemaVersion: {
      major: schemaVersion.major,
      minor: schemaVersion.minor,
    },
    // Checked above: both carry a callable `safeParse`, which is the zod
    // surface this server dispatches through.
    requestSchema: record.requestSchema as z.ZodType,
    responseSchema: record.responseSchema as z.ZodType,
  };
}

export class RegistryRuntime {
  private readonly registry: Record<string, unknown>;

  constructor(registry: VersionedRpcRegistry) {
    this.registry = registry;
  }

  methodNames(): readonly string[] {
    return Object.keys(this.registry);
  }

  /** Canonical `{major,minor}` per method — the host's connection manifest. */
  buildManifest(): ConnectionManifest {
    const manifest: Record<string, SchemaVersion> = {};
    for (const method of this.methodNames()) {
      const majors = this.majorNumbers(method);
      const highest = Math.max(...majors);
      const line = this.majorLine(method, highest);
      manifest[method] = { major: highest, minor: line.latestMinor };
    }
    return manifest;
  }

  hasVersion(method: string, version: SchemaVersion): boolean {
    const methodRegistry = asRecord(Reflect.get(this.registry, method) ?? null);
    if (methodRegistry === null) {
      return false;
    }
    const line = asRecord(methodRegistry[String(version.major)] ?? null);
    if (line === null) {
      return false;
    }
    const versions = asRecord(line.versions ?? null);
    return (
      versions !== null &&
      Object.prototype.hasOwnProperty.call(versions, String(version.minor))
    );
  }

  canonical(method: string): SchemaVersion {
    const majors = this.majorNumbers(method);
    const highest = Math.max(...majors);
    return {
      major: highest,
      minor: this.majorLine(method, highest).latestMinor,
    };
  }

  contractAt(method: string, version: SchemaVersion): RuntimeContract {
    return this.versionEntry(method, version).contract;
  }

  /**
   * Upgrades a request from an older installed on-wire version to the host's
   * canonical version by walking every installed version's
   * `upgradeFromPreviousVersion.upgradeRequest` in order (cross-major and
   * same-major share the traversal, mirroring `upgradeRequestToVersion`).
   */
  upgradeRequestToCanonical(
    method: string,
    fromVersion: SchemaVersion,
    request: unknown,
  ): unknown {
    let current = request;
    for (const step of this.versionsAfter(method, fromVersion)) {
      if (step.upgradeRequest === null) {
        throw new Error(
          `${method}: missing upgrade path into ${step.contract.schemaVersion.major}.${step.contract.schemaVersion.minor}`,
        );
      }
      current = step.upgradeRequest(current);
    }
    return current;
  }

  /**
   * Downgrades a canonical response to the client's older on-wire version:
   * cross-major via the direct `downgradePathsFromLatest` bridge, same-major
   * older-minor via a re-parse against the older minor's response schema
   * (minors are additive, so the older schema strips the newer fields).
   */
  downgradeResponseFromCanonical(
    method: string,
    toVersion: SchemaVersion,
    response: unknown,
  ): DowngradeOutcome {
    const canonical = this.canonical(method);
    if (canonical.major !== toVersion.major) {
      const path = this.downgradePath(method, canonical.major, toVersion.major);
      if (path === null) {
        return {
          ok: false,
          error: {
            code: "DOWNGRADE_UNSUPPORTED",
            message: `${method}: no downgrade bridge from major ${canonical.major} to ${toVersion.major}`,
          },
        };
      }
      return path.downgradeResponse(response);
    }
    const target = this.contractAt(method, toVersion);
    const parsed = target.responseSchema.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message: `${method}: response does not narrow to ${toVersion.major}.${toVersion.minor}`,
        },
      };
    }
    return { ok: true, value: parsed.data };
  }

  private majorNumbers(method: string): readonly number[] {
    const methodRegistry = asRecord(Reflect.get(this.registry, method) ?? null);
    if (methodRegistry === null) {
      throw new Error(`unknown method: ${method}`);
    }
    const majors = Object.keys(methodRegistry)
      .map((key) => Number(key))
      .filter((major) => Number.isInteger(major));
    if (majors.length === 0) {
      throw new Error(`method has no installed majors: ${method}`);
    }
    return majors;
  }

  private majorLine(
    method: string,
    major: number,
  ): {
    readonly latestMinor: number;
    readonly line: Record<string, unknown>;
  } {
    const methodRegistry = asRecord(Reflect.get(this.registry, method) ?? null);
    const line = asRecord(methodRegistry?.[String(major)] ?? null);
    const latestMinor = line?.latestMinor;
    if (line === null || typeof latestMinor !== "number") {
      throw new Error(`method ${method} has no major ${major}`);
    }
    return { latestMinor, line };
  }

  private versionEntry(
    method: string,
    version: SchemaVersion,
  ): RuntimeVersionEntry {
    const { line } = this.majorLine(method, version.major);
    const versions = asRecord(line.versions ?? null);
    const entry = asRecord(versions?.[String(version.minor)] ?? null);
    if (entry === null) {
      throw new Error(
        `method ${method} has no installed version ${version.major}.${version.minor}`,
      );
    }
    const upgrade = asRecord(entry.upgradeFromPreviousVersion ?? null);
    return {
      contract: readContract(entry.contract),
      upgradeRequest:
        upgrade === null ? null : asFunction(upgrade.upgradeRequest),
      upgradeResponse:
        upgrade === null ? null : asFunction(upgrade.upgradeResponse),
    };
  }

  /** Every installed version strictly after `fromVersion`, ascending. */
  private versionsAfter(
    method: string,
    fromVersion: SchemaVersion,
  ): readonly RuntimeVersionEntry[] {
    const steps: RuntimeVersionEntry[] = [];
    for (const major of [...this.majorNumbers(method)].sort((a, b) => a - b)) {
      const { line } = this.majorLine(method, major);
      const versions = asRecord(line.versions ?? null);
      if (versions === null) {
        continue;
      }
      const minors = Object.keys(versions)
        .map((key) => Number(key))
        .filter((minor) => Number.isInteger(minor))
        .sort((a, b) => a - b);
      for (const minor of minors) {
        if (
          major > fromVersion.major ||
          (major === fromVersion.major && minor > fromVersion.minor)
        ) {
          steps.push(this.versionEntry(method, { major, minor }));
        }
      }
    }
    return steps;
  }

  private downgradePath(
    method: string,
    fromMajor: number,
    toMajor: number,
  ): RuntimeDowngradePath | null {
    const { line } = this.majorLine(method, fromMajor);
    const paths = asRecord(line.downgradePathsFromLatest ?? null);
    const path = asRecord(paths?.[String(toMajor)] ?? null);
    if (path === null) {
      return null;
    }
    const downgradeRequest = asFunction(path.downgradeRequest);
    const downgradeResponse = asFunction(path.downgradeResponse);
    if (downgradeRequest === null || downgradeResponse === null) {
      return null;
    }
    return {
      downgradeRequest: (request) =>
        readDowngradeOutcome(downgradeRequest(request)),
      downgradeResponse: (response) =>
        readDowngradeOutcome(downgradeResponse(response)),
    };
  }
}

function readDowngradeOutcome(value: unknown): DowngradeOutcome {
  const record = asRecord(value);
  if (record === null || typeof record.ok !== "boolean") {
    throw new Error("downgrade path returned a malformed result");
  }
  if (record.ok) {
    return { ok: true, value: record.value };
  }
  const error = asRecord(record.error ?? null);
  const code = error?.code;
  const message = error?.message;
  return {
    ok: false,
    error: {
      code: typeof code === "string" ? code : "DOWNGRADE_UNSUPPORTED",
      message: typeof message === "string" ? message : "downgrade failed",
    },
  };
}
