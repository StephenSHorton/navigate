export { PathAgent } from "./agent/PathAgent";
export { PathManager } from "./manager/PathManager";
export { ManagedAgent } from "./manager/ManagedAgent";
export { AgentGroup } from "./manager/AgentGroup";
export { computeFormationOffset } from "./manager/FormationSolver";
export { computeArrivalPosition } from "./manager/ArrivalSolver";
export { predictTargetPosition } from "./util/prediction";
export { hasLineOfSight } from "./util/lineOfSight";
export type {
	AgentGroupConfig,
	AgentParams,
	AgentStatus,
	ArrivalBehavior,
	Formation,
	ManagedAgentConfig,
	PathAgentConfig,
	PathfindingError,
	PathManagerConfig,
	PursuitPhase,
} from "./core/types";
