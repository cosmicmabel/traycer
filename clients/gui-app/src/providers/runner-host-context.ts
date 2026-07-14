import { createContext } from "react";
import type { IRunnerHost } from "@cic/shared/platform/runner-host";

export const RunnerHostContext = createContext<IRunnerHost | null>(null);
