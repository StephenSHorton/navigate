import Maid from "@rbxts/maid";
import { PathAgent } from "../agent/PathAgent";
import { ManagedAgentConfig, PursuitPhase } from "../core/types";

/** Per-agent state wrapper used by PathManager. */
export class ManagedAgent {
	public readonly pathAgent: PathAgent;
	public readonly agentModel: Model;
	public readonly maid = new Maid();

	// ── Pursuit state ───────────────────────────────────────────────────

	public pursuitPhase: PursuitPhase = "idle";
	public target: BasePart | undefined;

	// ── Dirty-flag recomputation ────────────────────────────────────────

	public lastComputedGoal: Vector3 | undefined;
	public lastComputeTime = 0;
	public computeInFlight = false;

	// ── Priority ────────────────────────────────────────────────────────

	public priority = 0;
	public readonly priorityBias: number;

	// ── Path sharing ────────────────────────────────────────────────────

	public clusterId: string | undefined;
	public isClusterLeader = false;

	// ── Group membership ────────────────────────────────────────────────

	public groupId: string | undefined;

	// ── Heading (for formations) ────────────────────────────────────────

	public lastPosition: Vector3 | undefined;

	// ── Collision ───────────────────────────────────────────────────────

	private currentCollisionGroup = "Default";

	// ── Config ──────────────────────────────────────────────────────────

	public readonly speed: number;
	public readonly enablePrediction: boolean;

	constructor(agentModel: Model, config?: ManagedAgentConfig) {
		this.agentModel = agentModel;
		this.speed = config?.speed ?? 16;
		this.priorityBias = config?.priorityBias ?? 0;
		this.target = config?.target;
		this.enablePrediction = config?.enablePrediction ?? false;

		this.pathAgent = new PathAgent(agentModel, config);
		this.maid.GiveTask(() => this.pathAgent.destroy());
	}

	/** Check if this agent needs a path recompute based on dirty flag + cooldown. */
	public needsRecompute(dirtyThreshold: number, cooldown: number): boolean {
		if (this.computeInFlight) return false;
		if (!this.target) return false;

		const now = os.clock();
		if (now - this.lastComputeTime < cooldown) return false;

		// Always recompute if stuck, errored, or already reached the old goal
		const status = this.pathAgent.getStatus();
		if (status === "stuck" || status === "error" || status === "reached") return true;

		if (!this.lastComputedGoal) return true;

		const targetMoved = this.target.Position.sub(this.lastComputedGoal).Magnitude;
		return targetMoved >= dirtyThreshold;
	}

	/** Get distance from agent to its target. Returns math.huge if no target. */
	public getDistanceToTarget(): number {
		if (!this.target) return math.huge;
		return this.getPosition().sub(this.target.Position).Magnitude;
	}

	/** Get the agent's current world position. */
	public getPosition(): Vector3 {
		return this.agentModel.GetPivot().Position;
	}

	/** Update the collision group on all BaseParts. Only touches parts when the group actually changes. */
	public setCollisionGroup(groupName: string): void {
		if (groupName === this.currentCollisionGroup) return;
		this.currentCollisionGroup = groupName;

		for (const descendant of this.agentModel.GetDescendants()) {
			if (descendant.IsA("BasePart")) {
				descendant.CollisionGroup = groupName;
			}
		}
	}

	/** Clean up the managed agent. */
	public destroy(): void {
		this.setCollisionGroup("Default");
		this.maid.DoCleaning();
	}
}
