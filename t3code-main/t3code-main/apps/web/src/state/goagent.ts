import { createGoAgentAtoms } from "@t3tools/client-runtime/state/goagent";

import { connectionAtomRuntime } from "../connection/runtime";

export const goagent = createGoAgentAtoms(connectionAtomRuntime);
