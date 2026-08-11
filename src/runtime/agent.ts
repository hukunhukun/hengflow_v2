// Stable HengFlow runtime boundary.
//
// Product code imports runtime capabilities only from this module. The current
// implementation is pinned while the runtime is progressively internalized,
// allowing the rest of HengFlow to evolve without depending on engine layout.
export {
  AgentSession,
  buildSessionContext,
  createAgentSession,
  DefaultResourceLoader,
  estimateTokens,
  getLatestCompactionEntry,
  main,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@hengflow/agent-runtime";

export type {
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@hengflow/agent-runtime";
