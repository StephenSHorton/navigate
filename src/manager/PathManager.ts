import Maid from "@rbxts/maid";
import { PhysicsService, RunService } from "@rbxts/services";
import Signal from "@rbxts/signal";
import {
	AgentGroupConfig,
	ArrivalBehavior,
	Formation,
	ManagedAgentConfig,
	PathManagerConfig,
	PursuitPhase,
} from "../core/types";
import { predictTargetPosition } from "../util/prediction";
import { AgentGroup } from "./AgentGroup";
import { computeArrivalPosition } from "./ArrivalSolver";
import { ComputeBudget } from "./ComputeBudget";
import { computeFormationOffset } from "./FormationSolver";
import { ManagedAgent } from "./ManagedAgent";
import { PathCache } from "./PathCache";
import { computePursuitPhase } from "./PursuitState";

/** Resolved config with all defaults applied. */
interface ResolvedConfig {
	computeBudgetPerFrame: number;
	closeRangeThreshold: number;
	dirtyDistanceThreshold: number;
	recomputeCooldown: number;
	clusterRadius: number;
	clusterDriftThreshold: number;
	updateInterval: number;
}

function resolveConfig(config?: PathManagerConfig): ResolvedConfig {
	return {
		computeBudgetPerFrame: config?.computeBudgetPerFrame ?? 20,
		closeRangeThreshold: config?.closeRangeThreshold ?? 20,
		dirtyDistanceThreshold: config?.dirtyDistanceThreshold ?? 10,
		recomputeCooldown: config?.recomputeCooldown ?? 0.5,
		clusterRadius: config?.clusterRadius ?? 15,
		clusterDriftThreshold: config?.clusterDriftThreshold ?? 20,
		updateInterval: config?.updateInterval ?? 0.1,
	};
}

/**
 * PathManager — singleton coordinator for scalable multi-agent pursuit.
 *
 * Manages a pool of PathAgents with:
 * - Two-phase pursuit (far = pathfinding, close = direct MoveTo)
 * - Predictive targeting via velocity
 * - Global compute budget (capped ComputeAsync calls per frame)
 * - Path sharing via spatial clustering
 */
export class PathManager {
	// ── Singleton ───────────────────────────────────────────────────────

	private static instance?: PathManager;

	public static create(config?: PathManagerConfig): PathManager {
		if (PathManager.instance) {
			PathManager.instance.destroy();
		}
		PathManager.instance = new PathManager(config);
		return PathManager.instance;
	}

	public static getInstance(): PathManager {
		if (!PathManager.instance) {
			error("PathManager has not been created. Call PathManager.create() first.");
		}
		return PathManager.instance;
	}

	// ── Internal state ──────────────────────────────────────────────────

	private agents = new Map<Model, ManagedAgent>();
	private groups = new Map<string, AgentGroup>();
	private computeBudget: ComputeBudget;
	private pathCache = new PathCache();
	private config: ResolvedConfig;
	private maid = new Maid();
	private timeSinceUpdate = 0;

	// ── Public signals ──────────────────────────────────────────────────

	/** Fires when a managed agent changes pursuit phase. */
	public readonly phaseChanged = new Signal<
		(agent: ManagedAgent, phase: PursuitPhase, oldPhase: PursuitPhase) => void
	>();

	// ── Collision groups ────────────────────────────────────────────────

	private static readonly LEADER_GROUP = "NavigateLeader";
	private static readonly AGENT_GROUP = "NavigateAgent";

	// ── Constructor ─────────────────────────────────────────────────────

	private constructor(config?: PathManagerConfig) {
		this.config = resolveConfig(config);
		this.computeBudget = new ComputeBudget(this.config.computeBudgetPerFrame);
		this.setupCollisionGroups();

		this.maid.GiveTask(
			RunService.Heartbeat.Connect((dt) => {
				const [ok, err] = pcall(() => this.onHeartbeat(dt));
				if (!ok) {
					warn(`[PathManager] Heartbeat error: ${err}`);
				}
			}),
		);
	}

	// ── Private: collision groups ────────────────────────────────────────

	private setupCollisionGroups(): void {
		pcall(() => PhysicsService.RegisterCollisionGroup(PathManager.LEADER_GROUP));
		pcall(() => PhysicsService.RegisterCollisionGroup(PathManager.AGENT_GROUP));

		// Leaders pass through all NPCs (leaders and followers)
		PhysicsService.CollisionGroupSetCollidable(PathManager.LEADER_GROUP, PathManager.AGENT_GROUP, false);
		PhysicsService.CollisionGroupSetCollidable(PathManager.LEADER_GROUP, PathManager.LEADER_GROUP, false);
		// Followers collide with each other (default behavior)
	}

	// ── Public API ──────────────────────────────────────────────────────

	/** Register an NPC model and get back a ManagedAgent handle. */
	public registerAgent(model: Model, config?: ManagedAgentConfig): ManagedAgent {
		if (this.agents.has(model)) {
			error(`PathManager: Model "${model.Name}" is already registered.`);
		}

		const managed = new ManagedAgent(model, config);
		managed.setCollisionGroup(PathManager.AGENT_GROUP);
		this.agents.set(model, managed);
		return managed;
	}

	/** Unregister and clean up an agent. */
	public unregisterAgent(model: Model): void {
		const managed = this.agents.get(model);
		if (!managed) return;

		this.computeBudget.dequeue(managed);
		managed.destroy();
		this.agents.delete(model);
	}

	/** Set the pursuit target for a specific agent. */
	public setTarget(model: Model, target: BasePart | undefined): void {
		const managed = this.agents.get(model);
		if (!managed) return;

		managed.target = target;
		if (!target) {
			managed.pursuitPhase = "idle";
			managed.pathAgent.stop();
			managed.lastComputedGoal = undefined;
		}
	}

	/** Set the pursuit target for all registered agents. */
	public setTargetAll(target: BasePart | undefined): void {
		for (const [model] of this.agents) {
			this.setTarget(model, target);
		}
	}

	/** Get the managed agent for a model. */
	public getAgent(model: Model): ManagedAgent | undefined {
		return this.agents.get(model);
	}

	/** Get all registered agents. */
	public getAllAgents(): ManagedAgent[] {
		const result: ManagedAgent[] = [];
		for (const [_, agent] of this.agents) {
			result.push(agent);
		}
		return result;
	}

	/**
	 * Snapshot of pursuit state across all managed agents. Useful for debug
	 * HUDs — counts only, no per-agent data. Cheap to call each tick.
	 */
	public getStats(): {
		total: number;
		far: number;
		close: number;
		idle: number;
		leaders: number;
		followers: number;
		clusters: number;
		groups: number;
	} {
		let far = 0;
		let close = 0;
		let idle = 0;
		let leaders = 0;
		let followers = 0;
		const clusterIds = new Set<string>();

		for (const [_, agent] of this.agents) {
			if (agent.pursuitPhase === "far") far++;
			else if (agent.pursuitPhase === "close") close++;
			else idle++;

			if (agent.clusterId !== undefined) {
				clusterIds.add(agent.clusterId);
				if (agent.isClusterLeader) leaders++;
				else followers++;
			} else {
				// No cluster assignment — treated as its own leader by PathCache.isLeader
				leaders++;
			}
		}

		return {
			total: this.agents.size(),
			far,
			close,
			idle,
			leaders,
			followers,
			clusters: clusterIds.size(),
			groups: this.groups.size(),
		};
	}

	/** Update configuration at runtime. */
	public updateConfig(config: Partial<PathManagerConfig>): void {
		const prev = this.config;
		this.config = {
			...prev,
			...config,
		} as ResolvedConfig;

		if (config.computeBudgetPerFrame !== undefined) {
			this.computeBudget.setBudget(config.computeBudgetPerFrame);
		}
	}

	// ── Group API ───────────────────────────────────────────────────────

	/** Create a named group from registered models. */
	public createGroup(id: string, models: Model[], config?: AgentGroupConfig): AgentGroup {
		if (this.groups.has(id)) {
			error(`PathManager: Group "${id}" already exists.`);
		}
		const agentGroup = new AgentGroup(id, config);
		for (const model of models) {
			const managed = this.agents.get(model);
			if (managed) agentGroup.addMember(managed);
		}
		this.groups.set(id, agentGroup);
		return agentGroup;
	}

	/** Dissolve a group and release its members back to auto-clustering. */
	public dissolveGroup(id: string): void {
		const agentGroup = this.groups.get(id);
		if (!agentGroup) return;
		agentGroup.destroy();
		this.groups.delete(id);
	}

	/** Add a registered model to an existing group. */
	public addToGroup(groupId: string, model: Model): void {
		const agentGroup = this.groups.get(groupId);
		const managed = this.agents.get(model);
		if (agentGroup && managed) agentGroup.addMember(managed);
	}

	/** Remove a model from its group. */
	public removeFromGroup(groupId: string, model: Model): void {
		const agentGroup = this.groups.get(groupId);
		const managed = this.agents.get(model);
		if (agentGroup && managed) agentGroup.removeMember(managed);
	}

	/** Update a group's formation. */
	public setFormation(groupId: string, formation: Formation): void {
		const agentGroup = this.groups.get(groupId);
		if (agentGroup) agentGroup.formation = formation;
	}

	/** Update a group's arrival behavior. */
	public setArrivalBehavior(groupId: string, behavior: ArrivalBehavior): void {
		const agentGroup = this.groups.get(groupId);
		if (agentGroup) agentGroup.arrivalBehavior = behavior;
	}

	/** Get a group by ID. */
	public getGroup(id: string): AgentGroup | undefined {
		return this.groups.get(id);
	}

	// ── Lifecycle ───────────────────────────────────────────────────────

	/** Destroy the PathManager and all managed agents. */
	public destroy(): void {
		for (const [_, agentGroup] of this.groups) {
			agentGroup.destroy();
		}
		this.groups.clear();

		for (const [_, agent] of this.agents) {
			agent.destroy();
		}
		this.agents.clear();

		this.computeBudget.clear();
		this.pathCache.clear();
		this.phaseChanged.Destroy();
		this.maid.DoCleaning();

		if (PathManager.instance === this) {
			PathManager.instance = undefined;
		}
	}

	// ── Heartbeat loop ──────────────────────────────────────────────────

	private onHeartbeat(dt: number): void {
		this.timeSinceUpdate += dt;
		if (this.timeSinceUpdate < this.config.updateInterval) return;
		this.timeSinceUpdate = 0;

		const farAgents: ManagedAgent[] = [];
		let closeCount = 0;
		let idleCount = 0;
		let enqueueCount = 0;

		// Phase 1: Update pursuit state for all agents, track lastPosition for heading
		for (const [_, agent] of this.agents) {
			const oldPhase = agent.pursuitPhase;
			const newPhase = computePursuitPhase(agent, this.config.closeRangeThreshold);

			if (newPhase !== oldPhase) {
				agent.pursuitPhase = newPhase;
				this.phaseChanged.Fire(agent, newPhase, oldPhase);

				if (newPhase === "close" && oldPhase === "far") {
					agent.pathAgent.stop();
					agent.pathAgent.clearVisualization();
					agent.setCollisionGroup(PathManager.AGENT_GROUP);
				}

				if (oldPhase === "close") {
					agent.pathAgent.hideCloseTarget();
				}
			}

			// Update heading tracking
			const currentPos = agent.getPosition();
			if (!agent.lastPosition) agent.lastPosition = currentPos;

			if (newPhase === "far") {
				farAgents.push(agent);
			} else if (newPhase === "close") {
				closeCount++;
			} else {
				idleCount++;
			}
		}

		// Phase 1.5: Group arrival — if any group member is CLOSE, force entire group to CLOSE
		for (const [_, agentGroup] of this.groups) {
			const members = agentGroup.getMembers();
			const anyClose = members.some((m) => m.pursuitPhase === "close");
			if (!anyClose) continue;

			// Cache approach direction on first CLOSE transition
			if (!agentGroup.arrivalApproachDir) {
				const pathfinder = agentGroup.getPathfinder();
				const firstCloseMember = members.find((m) => m.pursuitPhase === "close");
				const refAgent = pathfinder ?? firstCloseMember;
				if (refAgent && refAgent.target) {
					agentGroup.arrivalApproachDir = refAgent.getPosition().sub(refAgent.target.Position);
				}
			}

			for (const member of members) {
				if (member.pursuitPhase === "far") {
					member.pursuitPhase = "close";
					member.pathAgent.stop();
					member.setCollisionGroup(PathManager.LEADER_GROUP);
					const idx = farAgents.indexOf(member);
					if (idx !== -1) farAgents.unorderedRemove(idx);
					closeCount++;
				}
			}
		}

		// Phase 1.6: Handle CLOSE agents (grouped get arrival positions, ungrouped converge)
		for (const [_, agent] of this.agents) {
			if (agent.pursuitPhase !== "close" || !agent.target) continue;
			this.handleCloseAgent(agent);
		}

		// Phase 2: Handle explicit groups (FAR phase members)
		let groupPathfinderCount = 0;
		let groupMemberCount = 0;

		for (const [_, agentGroup] of this.groups) {
			const farMembers = agentGroup.getMembers().filter((m) => m.pursuitPhase === "far");
			if (farMembers.size() === 0) continue;

			// Reset cached arrival direction when group returns to FAR
			agentGroup.arrivalApproachDir = undefined;

			// Elect pathfinder (closest to target — computes the path)
			agentGroup.electPathfinder();
			const pathfinder = agentGroup.getPathfinder();
			if (!pathfinder) continue;

			// Pathfinder: compute path via budget, non-colliding
			pathfinder.setCollisionGroup(PathManager.LEADER_GROUP);
			groupPathfinderCount++;

			if (pathfinder.needsRecompute(this.config.dirtyDistanceThreshold, this.config.recomputeCooldown)) {
				this.computeBudget.enqueue(pathfinder);
				enqueueCount++;
			}

			// Leader position and heading
			const leaderPos = pathfinder.getPosition();
			const pfDelta = pathfinder.lastPosition
				? leaderPos.sub(pathfinder.lastPosition)
				: Vector3.zero;
			const flatDelta = new Vector3(pfDelta.X, 0, pfDelta.Z);
			let heading: Vector3;

			if (flatDelta.Magnitude > 0.1) {
				heading = flatDelta.Unit;
			} else if (pathfinder.target) {
				const toTarget = pathfinder.target.Position.sub(leaderPos);
				const flatToTarget = new Vector3(toTarget.X, 0, toTarget.Z);
				heading = flatToTarget.Magnitude > 0.1 ? flatToTarget.Unit : new Vector3(0, 0, 1);
			} else {
				heading = new Vector3(0, 0, 1);
			}

			// Leader moves freely, followers offset from leader
			let followerIdx = 0;
			const followerCount = farMembers.size() - 1;

			for (const member of farMembers) {
				groupMemberCount++;

				if (member === pathfinder) {
					member.pathAgent.waypointColor = Color3.fromRGB(255, 128, 0);
					continue;
				}

				member.setCollisionGroup(PathManager.LEADER_GROUP);
				member.pathAgent.clearVisualization();
				member.pathAgent.waypointColor = Color3.fromRGB(0, 180, 255);

				const offset = computeFormationOffset(
					agentGroup.formation,
					followerIdx,
					followerCount,
					heading,
				);
				member.pathAgent.moveTo(leaderPos.add(offset));
				followerIdx++;
			}
		}

		// Phase 3: Auto-cluster ungrouped FAR agents
		const allAgents: ManagedAgent[] = [];
		for (const [_, agent] of this.agents) allAgents.push(agent);
		this.pathCache.updateClusters(
			farAgents,
			allAgents,
			this.config.clusterRadius,
			this.config.clusterDriftThreshold,
		);

		// Phase 4: Handle auto-clustered leaders/followers (ungrouped only)
		const LEADER_COLOR = Color3.fromRGB(0, 255, 0);
		const FOLLOWER_COLOR = Color3.fromRGB(0, 180, 255);

		let leaderCount = 0;
		let followerCount = 0;

		for (const agent of farAgents) {
			if (agent.groupId) continue; // already handled in Phase 2

			const isLeader = this.pathCache.isLeader(agent);

			if (isLeader) {
				agent.pathAgent.waypointColor = LEADER_COLOR;
				agent.setCollisionGroup(PathManager.LEADER_GROUP);
				leaderCount++;

				if (agent.needsRecompute(this.config.dirtyDistanceThreshold, this.config.recomputeCooldown)) {
					this.computeBudget.enqueue(agent);
					enqueueCount++;
				}
			} else {
				agent.pathAgent.waypointColor = FOLLOWER_COLOR;
				agent.setCollisionGroup(PathManager.AGENT_GROUP);
				followerCount++;

				agent.pathAgent.clearVisualization();
				const cluster = agent.clusterId
					? this.pathCache.getCluster(agent.clusterId)
					: undefined;
				if (cluster) {
					agent.pathAgent.moveTo(cluster.leader.getPosition());
				} else if (agent.target) {
					if (agent.needsRecompute(this.config.dirtyDistanceThreshold, this.config.recomputeCooldown)) {
						this.computeBudget.enqueue(agent);
						enqueueCount++;
					}
				}
			}
		}

		// Phase 5: Process compute budget
		this.computeBudget.processFrame();

		// Update lastPosition for heading computation
		for (const [_, agent] of this.agents) {
			agent.lastPosition = agent.getPosition();
		}

	}

	// ── Phase handlers ──────────────────────────────────────────────────

	private handleCloseAgent(agent: ManagedAgent): void {
		if (!agent.target) return;

		const targetPos = agent.enablePrediction
			? predictTargetPosition(agent.getPosition(), agent.target, agent.speed)
			: agent.target.Position;

		let movePos = targetPos;

		// Check if agent is in a group with an arrival behavior
		if (agent.groupId) {
			const agentGroup = this.groups.get(agent.groupId);
			if (agentGroup && agentGroup.arrivalBehavior.arrivalType !== "converge") {
				const members = agentGroup.getMembers();
				const agentIndex = members.indexOf(agent);

				// Use cached approach direction (set once on first CLOSE transition)
				const approachDir = agentGroup.arrivalApproachDir ?? agent.getPosition().sub(targetPos);

				movePos = computeArrivalPosition(
					agentGroup.arrivalBehavior,
					targetPos,
					agentIndex >= 0 ? agentIndex : 0,
					members.size(),
					approachDir,
				);
			}
		}

		agent.pathAgent.moveTo(movePos);
		agent.pathAgent.showCloseTarget(movePos);
	}
}
