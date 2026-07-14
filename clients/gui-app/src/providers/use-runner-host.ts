import { use } from "react";
import type { IRunnerHost } from "@cic/shared/platform/runner-host";
import { RunnerHostContext } from "@/providers/runner-host-context";

export function useRunnerHost(): IRunnerHost {
  const value = use(RunnerHostContext);
  if (value === null) {
    throw new Error(
      "useRunnerHost must be called inside a <RunnerHostProvider>.",
    );
  }
  return value;
}
