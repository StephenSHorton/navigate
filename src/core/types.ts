/** Current status of a PathAgent. */
export type AgentStatus = "idle" | "moving" | "stuck" | "reached" | "error";

/** Categorized pathfinding error types. */
export type PathfindingError =
	| "no_path"
	| "timeout"
	| "computation_error"
	| "agent_stuck"
	| "agent_destroyed";

/** Parameters forwarded to PathfindingService.CreatePath(). */
export interface AgentParams {
	AgentRadius?: number;
	AgentHeight?: number;
	AgentCanJump?: boolean;
	AgentCanClimb?: boolean;
	WaypointSpacing?: number;
	Costs?: { [material: string]: number };
}

/** Configuration for a PathAgent instance. */
export interface PathAgentConfig {
	/** PathfindingService agent parameters. */
	agentParams?: AgentParams;

	/** Auto re-path when the path is blocked (default: true). */
	recomputeOnBlock?: boolean;

	/** Enable stuck detection via timeout (default: true). */
	timeoutEnabled?: boolean;

	/**
	 * Movement speed used for timeout estimation (default: 16).
	 * Should match the agent's Humanoid.WalkSpeed or equivalent.
	 */
	speed?: number;

	/**
	 * Timeout multiplier — the agent is considered "stuck" if a waypoint
	 * is not reached within estimatedTime * multiplier (default: 2).
	 */
	timeoutMultiplier?: number;

	/** Debug visualization toggle (default: false). */
	visualize?: boolean;

	/**
	 * Distance threshold to consider a waypoint "reached"
	 * for non-humanoid agents using position polling (default: 2).
	 */
	waypointReachedThreshold?: number;

	/** Custom movement callback — skips Humanoid:MoveTo() when provided. */
	onMove?: (goal: Vector3) => void;

	/** Custom jump callback — skips Humanoid jump when provided. */
	onJump?: () => void;
}

// ── PathManager types ───────────────────────────────────────────────

/** Pursuit phase for a managed agent. */
export type PursuitPhase = "far" | "close" | "idle";

/** Configuration for the PathManager singleton. */
export interface PathManagerConfig {
	/** Max ComputeAsync calls started per Heartbeat frame (default: 4). */
	computeBudgetPerFrame?: number;

	/** Distance threshold to switch from far to close pursuit (default: 20). */
	closeRangeThreshold?: number;

	/** Distance the target must move before a far-range recompute (default: 10). */
	dirtyDistanceThreshold?: number;

	/** Min seconds between recomputes for a single agent (default: 0.5). */
	recomputeCooldown?: number;

	/** Cluster radius for path sharing — NPCs within this radius
	 *  pursuing the same target may share a path (default: 15). */
	clusterRadius?: number;

	/** How far a follower can drift from the leader before splitting off (default: 20). */
	clusterDriftThreshold?: number;

	/** Enable velocity-based target prediction (default: true). */
	enablePrediction?: boolean;

	/** Heartbeat update interval in seconds (default: 0.1 = 10 Hz). */
	updateInterval?: number;
}

/** Configuration when registering an agent with PathManager. */
export interface ManagedAgentConfig extends PathAgentConfig {
	/** The target to pursue. Can be changed later via setTarget(). */
	target?: BasePart;

	/** Priority bias — higher values get compute budget sooner.
	 *  Added to distance-based priority. Default: 0. */
	priorityBias?: number;
}

// ── Group / Formation types ─────────────────────────────────────────

/** Formation configuration for group movement. */
export interface Formation {
	/** Formation shape. */
	formationType: "none" | "line" | "wedge" | "circle" | "grid" | "custom";

	/** Distance between agents in the formation (studs). */
	spacing: number;

	/** Which direction agents face. Default: "movement". */
	faceDirection?: "movement" | "target" | "leader";

	/** Custom offset vectors (used when formationType is "custom"). */
	offsets?: Vector3[];
}

/** Arrival behavior when the group reaches its target. */
export interface ArrivalBehavior {
	/** How agents position themselves on arrival. */
	arrivalType: "converge" | "surround" | "stack" | "spread";

	/** Radius for "surround" and "spread" (studs). */
	radius?: number;

	/** Distance between agents for "stack" (studs). */
	stackDistance?: number;
}

/** Configuration for an explicit agent group. */
export interface AgentGroupConfig {
	formation?: Formation;
	arrivalBehavior?: ArrivalBehavior;
}
