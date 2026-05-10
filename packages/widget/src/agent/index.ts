export { Planner, PlannerError } from "./planner.js";
export type { PlanRequest, PlannerOptions } from "./planner.js";
export { Critic, CriticError } from "./critic.js";
export type { CriticOptions } from "./critic.js";
export { PlanSchema, StepSchema } from "./types.js";
export type { Plan, Step, OutputRef, ToolOutputKind } from "./types.js";
export { listTools, getTool } from "./tools/registry.js";
export type { ToolDef } from "./tools/types.js";
export type { DatasetProfile } from "./prompts/builders.js";
export {
	PROVIDER_CATALOGUE,
	DEFAULT_PROVIDER_ID,
	defaultModelFor,
	getProviderInfo,
	ForcedToolError,
	UnknownProviderError,
} from "./forced-tool/index.js";
export type { ProviderId, ProviderInfo } from "./forced-tool/index.js";
import "./tools/index.js"; // ensure tools register on agent/* import
