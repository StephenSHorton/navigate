import Maid from "@rbxts/maid";
import { PathfindingService, RunService, Workspace } from "@rbxts/services";
import Signal from "@rbxts/signal";
import { AgentStatus, PathAgentConfig, PathfindingError } from "../core/types";

const JUMP_ACTION = Enum.PathWaypointAction.Jump;
const PARTIAL_STATUS = Enum.PathStatus.ClosestNoPath;
const AIR_MATERIAL = Enum.Material.Air;
const JUMPING_STATE = Enum.HumanoidStateType.Jumping;
const FREEFALL_STATE = Enum.HumanoidStateType.Freefall;

export class PathAgent {
	// ── Internal state ──────────────────────────────────────────────────

	private agent: Model;
	private humanoid?: Humanoid;
	private pathObj: Path;
	private waypoints: PathWaypoint[] = [];
	private _currentWaypointIndex = 0;
	private _status: AgentStatus = "idle";
	private _lastError?: PathfindingError;
	private idle = true;
	private inAir = false;
	private goal?: Vector3 | BasePart;
	private partial = false;
	private destroying = false;

	// ── Config (resolved defaults) ──────────────────────────────────────

	private recomputeOnBlock: boolean;
	private timeoutEnabled: boolean;
	private speed: number;
	private timeoutMultiplier: number;
	private _visualize: boolean;
	private waypointReachedThreshold: number;
	private moveCallback?: (goal: Vector3) => void;
	private jumpCallback?: () => void;

	// ── Cleanup & cancellation ──────────────────────────────────────────

	private maid = new Maid();
	private override = new Signal();

	// ── Visualization ───────────────────────────────────────────────────

	private visualParts: BasePart[] = [];
	private closeTargetPart: BasePart | undefined;

	/** Override the default green waypoint color (e.g., to distinguish shared paths). */
	public waypointColor = Color3.fromRGB(0, 255, 0);

	// ── Public signals ──────────────────────────────────────────────────

	/** Fires when the agent arrives at the final waypoint. */
	public readonly reached = new Signal<(waypoint: PathWaypoint, partial: boolean) => void>();

	/** Fires at each intermediate waypoint. */
	public readonly waypointReached = new Signal<(current: PathWaypoint, upcoming: PathWaypoint) => void>();

	/** Fires when a path obstruction is detected ahead. */
	public readonly blocked = new Signal<(waypointIndex: number) => void>();

	/** Fires when the agent hasn't progressed within the timeout window. */
	public readonly stuck = new Signal<() => void>();

	/** Fires on any pathfinding error (computation failure, no path, etc.). */
	public readonly error = new Signal<(err: PathfindingError) => void>();

	/** Fires on any status transition. */
	public readonly statusChanged = new Signal<(newStatus: AgentStatus, oldStatus: AgentStatus) => void>();

	/** Fires when navigation is explicitly stopped. */
	public readonly stopped = new Signal<() => void>();

	// ── Public accessors ────────────────────────────────────────────────

	public getStatus(): AgentStatus {
		return this._status;
	}

	public getCurrentWaypointIndex(): number {
		return this._currentWaypointIndex;
	}

	public getLastError(): PathfindingError | undefined {
		return this._lastError;
	}

	public getVisualize(): boolean {
		return this._visualize;
	}

	public setVisualize(value: boolean): void {
		this._visualize = value;
		if (!value) this.clearVisualization();
	}

	// ── Constructor ─────────────────────────────────────────────────────

	constructor(agent: Model, config?: PathAgentConfig) {
		this.agent = agent;
		this.humanoid = agent.FindFirstChildOfClass("Humanoid");

		// Resolve config with defaults
		this.recomputeOnBlock = config?.recomputeOnBlock ?? true;
		this.timeoutEnabled = config?.timeoutEnabled ?? true;
		this.speed = config?.speed ?? 16;
		this.timeoutMultiplier = config?.timeoutMultiplier ?? 2;
		this._visualize = config?.visualize ?? false;
		this.waypointReachedThreshold = config?.waypointReachedThreshold ?? 2;
		this.moveCallback = config?.onMove;
		this.jumpCallback = config?.onJump;

		// Create PathfindingService path object
		this.pathObj = PathfindingService.CreatePath(config?.agentParams as object);

		// Server: claim network ownership for smooth movement
		if (RunService.IsServer()) {
			this.claimNetworkOwnership();
			this.maid.GiveTask(
				agent.DescendantAdded.Connect((descendant) => {
					if (descendant.IsA("BasePart")) {
						const [canSet] = descendant.CanSetNetworkOwnership();
						if (canSet) descendant.SetNetworkOwner(undefined);
					}
				}),
			);
		}

		// Set up movement system
		if (this.humanoid) {
			this.setupHumanoid(this.humanoid);
		} else if (this.moveCallback) {
			this.setupNonHumanoid();
		}

		// React to path obstructions
		this.maid.GiveTask(
			this.pathObj.Blocked.Connect((blockedIdx) => {
				// blockedIdx from Roblox is 1-based; our index is 0-based
				const adjusted = blockedIdx - 1;
				if (adjusted >= this._currentWaypointIndex && !this.idle) {
					this.blocked.Fire(adjusted);
					if (this.recomputeOnBlock && this.goal) {
						this.run(this.goal);
					}
				}
			}),
		);
	}

	// ── Public methods ──────────────────────────────────────────────────

	/** Navigate to the given goal. Cancels any in-progress navigation. */
	public run(goal: Vector3 | BasePart): void {
		if (this.destroying) return;

		// Cancel any pending operations (waitUntilLanded, etc.)
		this.override.Fire();
		this.goal = goal;

		// Don't compute paths while airborne — wait for landing, then retry
		if (this.inAir && this.humanoid) {
			this.waitUntilLanded();
			return;
		}

		const from = this.getPosition();
		const to = this.toVector3(goal);

		if (!this.computePath(from, to)) return;

		// Start traversal from the second waypoint (first is agent's current position)
		this._currentWaypointIndex = 1;
		this.idle = false;
		this.setStatus("moving");

		this.travelToWaypoint();
	}

	/** Stop navigation and halt the agent at its current position. */
	public stop(): void {
		if (this.destroying) return;

		this.idle = true;
		this.override.Fire();

		// Fully clear the humanoid's walk state. MoveTo(currentPos) cancels
		// the prior path but leaves WalkToPoint set and MoveDirection non-zero
		// for a tick, which keeps walk animations playing after stop().
		if (this.humanoid && !this.moveCallback) {
			this.humanoid.WalkToPoint = Vector3.zero;
			this.humanoid.Move(Vector3.zero, false);
		}

		this.setStatus("idle");
		this.stopped.Fire();
	}

	/** Clean up the PathAgent and release all resources. */
	public destroy(): void {
		if (this.destroying) return;
		this.destroying = true;

		this.idle = true;
		this.override.Fire();
		this.clearVisualization();

		this.reached.Destroy();
		this.waypointReached.Destroy();
		this.blocked.Destroy();
		this.stuck.Destroy();
		this.error.Destroy();
		this.statusChanged.Destroy();
		this.stopped.Destroy();
		this.override.Destroy();

		this.maid.DoCleaning();
		this.pathObj.Destroy();
	}

	// ── Private: status & errors ────────────────────────────────────────

	private setStatus(newStatus: AgentStatus): void {
		if (newStatus === this._status) return;
		const oldStatus = this._status;
		this._status = newStatus;
		this.statusChanged.Fire(newStatus, oldStatus);
	}

	private fireError(errorType: PathfindingError): void {
		this._lastError = errorType;
		this.setStatus("error");
		this.error.Fire(errorType);
	}

	// ── Private: path computation ───────────────────────────────────────

	private computePath(from: Vector3, to: Vector3): boolean {
		const [success, message] = pcall(() => {
			this.pathObj.ComputeAsync(from, to);
		});

		if (this.destroying) return false;

		if (!success) {
			warn(`PathAgent: ComputeAsync failed — ${message}`);
			this.fireError("computation_error");
			return false;
		}

		const rawWaypoints = this.pathObj.GetWaypoints();
		const isPartial = this.pathObj.Status === PARTIAL_STATUS;

		if (rawWaypoints.size() === 0) {
			this.fireError("no_path");
			return false;
		}

		if (rawWaypoints.size() < 2) {
			// Already at destination
			this.waypoints = rawWaypoints;
			this.partial = isPartial;
			this.arrive();
			return false;
		}

		this.waypoints = this.filterCloseWaypoints(rawWaypoints);
		this.partial = isPartial;

		if (this._visualize) {
			this.showVisualization();
		}

		return true;
	}

	/**
	 * Remove waypoints that are very close together (< 2 studs),
	 * unless they have a Jump action. Reduces unnecessary MoveTo calls.
	 */
	private filterCloseWaypoints(waypoints: ReadonlyArray<PathWaypoint>): PathWaypoint[] {
		const result: PathWaypoint[] = [];

		for (let i = 0; i < waypoints.size(); i++) {
			const wp = waypoints[i];

			// Always keep first and last waypoints
			if (i === 0 || i === waypoints.size() - 1) {
				result.push(wp);
				continue;
			}

			const following = waypoints[i + 1];
			const dist = wp.Position.sub(following.Position).Magnitude;

			if (wp.Action === JUMP_ACTION || dist >= 2) {
				result.push(wp);
			}
		}

		return result;
	}

	// ── Private: traversal ──────────────────────────────────────────────

	private travelToWaypoint(): void {
		const waypoint = this.waypoints[this._currentWaypointIndex];
		if (this.idle || !waypoint || this.destroying) return;

		this.move(waypoint.Position);

		if (waypoint.Action === JUMP_ACTION) {
			this.inAir = true;
			this.jump();
		}

		if (this.timeoutEnabled) {
			this.scheduleTimeoutCheck();
		}
	}

	private onWaypointReached(): void {
		if (this.idle || this.destroying) return;

		const nextWaypoint = this.waypoints[this._currentWaypointIndex + 1];
		if (nextWaypoint !== undefined) {
			const current = this.waypoints[this._currentWaypointIndex];
			this._currentWaypointIndex++;
			this.waypointReached.Fire(current, nextWaypoint);
			this.travelToWaypoint();
		} else {
			this.arrive();
		}
	}

	private arrive(): void {
		const finalWaypoint = this.waypoints[this.waypoints.size() - 1];
		this.idle = true;
		this.override.Fire();
		this.setStatus("reached");
		if (finalWaypoint) {
			this.reached.Fire(finalWaypoint, this.partial);
		}
	}

	// ── Private: stuck detection ────────────────────────────────────────

	private scheduleTimeoutCheck(): void {
		const currentIndex = this._currentWaypointIndex;
		const prevWaypoint = this.waypoints[currentIndex - 1];
		const currentWaypoint = this.waypoints[currentIndex];

		if (!prevWaypoint || !currentWaypoint) return;

		const distance = prevWaypoint.Position.sub(currentWaypoint.Position).Magnitude;
		const estimatedTime = distance / this.speed;
		const timeoutDuration = estimatedTime * this.timeoutMultiplier;

		// Snapshot current state for stale-check inside the delayed callback
		const snapshotWaypoints = this.waypoints;

		task.delay(timeoutDuration, () => {
			if (
				!this.idle &&
				!this.destroying &&
				this.waypoints === snapshotWaypoints &&
				this._currentWaypointIndex === currentIndex
			) {
				this.setStatus("stuck");
				this.stuck.Fire();
				this.error.Fire("timeout");
			}
		});
	}

	// ── Private: wait-for-landing ───────────────────────────────────────

	private waitUntilLanded(): void {
		let overrideConn: RBXScriptConnection | undefined;
		let stateConn: RBXScriptConnection | undefined;

		const cleanup = () => {
			overrideConn?.Disconnect();
			stateConn?.Disconnect();
		};

		overrideConn = this.override.Connect(() => cleanup());

		if (this.humanoid) {
			stateConn = this.humanoid.StateChanged.Connect((_oldState, newState) => {
				if (newState !== JUMPING_STATE && newState !== FREEFALL_STATE) {
					cleanup();
					this.inAir = false;
					if (this.goal && !this.destroying) {
						this.run(this.goal);
					}
				}
			});
		}
	}

	/**
	 * Move the agent directly toward a position without computing a path.
	 * Used by PathManager for close-range direct pursuit.
	 */
	public moveTo(position: Vector3): void {
		if (this.destroying) return;
		this.move(position);
	}

	/** Get the agent's Model instance. */
	public getAgentModel(): Model {
		return this.agent;
	}

	// ── Private: movement ───────────────────────────────────────────────

	private move(position: Vector3): void {
		if (this.moveCallback) {
			this.moveCallback(position);
		} else if (this.humanoid) {
			this.humanoid.MoveTo(position);
		}
	}

	private jump(): void {
		if (this.jumpCallback) {
			this.jumpCallback();
		} else if (this.humanoid) {
			if (this.humanoid.FloorMaterial !== AIR_MATERIAL) {
				this.humanoid.ChangeState(JUMPING_STATE);
			}
		}
	}

	// ── Private: humanoid setup ─────────────────────────────────────────

	private setupHumanoid(humanoid: Humanoid): void {
		// Advance waypoints on MoveToFinished
		this.maid.GiveTask(
			humanoid.MoveToFinished.Connect((reached) => {
				if (this.idle || this.destroying) return;

				if (reached) {
					this.onWaypointReached();
				} else {
					this.stop();
					this.fireError("agent_stuck");
				}
			}),
		);

		// Track airborne state so we don't compute paths mid-air
		this.maid.GiveTask(
			humanoid.StateChanged.Connect((oldState, newState) => {
				if (
					(oldState === JUMPING_STATE || oldState === FREEFALL_STATE) &&
					newState !== JUMPING_STATE &&
					newState !== FREEFALL_STATE
				) {
					this.inAir = false;
				}
			}),
		);
	}

	// ── Private: non-humanoid setup ─────────────────────────────────────

	private setupNonHumanoid(): void {
		// Poll position each frame to detect waypoint arrival
		this.maid.GiveTask(
			RunService.Heartbeat.Connect(() => {
				if (this.idle || this.destroying) return;

				const currentWaypoint = this.waypoints[this._currentWaypointIndex];
				if (!currentWaypoint) return;

				const dist = this.getPosition().sub(currentWaypoint.Position).Magnitude;
				if (dist <= this.waypointReachedThreshold) {
					this.onWaypointReached();
				}
			}),
		);
	}

	// ── Private: helpers ────────────────────────────────────────────────

	private getPosition(): Vector3 {
		return this.agent.GetPivot().Position;
	}

	private toVector3(goal: Vector3 | BasePart): Vector3 {
		return typeIs(goal, "Vector3") ? goal : goal.GetPivot().Position;
	}

	private claimNetworkOwnership(): void {
		for (const descendant of this.agent.GetDescendants()) {
			if (descendant.IsA("BasePart")) {
				const [canSet] = descendant.CanSetNetworkOwnership();
				if (canSet) descendant.SetNetworkOwner(undefined);
			}
		}
	}

	// ── Private: visualization ──────────────────────────────────────────

	private showVisualization(): void {
		this.clearVisualization();

		const lastIndex = this.waypoints.size() - 1;

		for (let i = 0; i < this.waypoints.size(); i++) {
			const waypoint = this.waypoints[i];
			const point = new Instance("Part");
			point.Size = new Vector3(0.5, 0.5, 0.5);
			point.Shape = Enum.PartType.Ball;
			point.Material = Enum.Material.Neon;
			point.Anchored = true;
			point.CanCollide = false;
			point.CanTouch = false;
			point.CanQuery = false;
			point.CastShadow = false;
			point.Position = waypoint.Position;

			if (i === lastIndex) {
				point.Color = Color3.fromRGB(255, 0, 0);
			} else if (waypoint.Action === JUMP_ACTION) {
				point.Color = Color3.fromRGB(255, 255, 0);
			} else {
				point.Color = this.waypointColor;
			}

			point.Parent = Workspace;
			this.visualParts.push(point);
		}
	}

	/** Remove all visualization parts (waypoints + close-phase target). Safe to call at any time. */
	public clearVisualization(): void {
		for (const part of this.visualParts) {
			part.Destroy();
		}
		this.visualParts = [];
		this.hideCloseTarget();
	}

	/**
	 * Show or update a single bright waypoint at `pos`. Used by PathManager
	 * during CLOSE-phase pursuit, where there is no path — just a current
	 * MoveTo target. No-op when visualize is disabled.
	 */
	public showCloseTarget(pos: Vector3): void {
		if (!this._visualize) return;

		if (this.closeTargetPart) {
			this.closeTargetPart.Position = pos;
			return;
		}

		const part = new Instance("Part");
		part.Size = new Vector3(0.7, 0.7, 0.7);
		part.Shape = Enum.PartType.Ball;
		part.Material = Enum.Material.Neon;
		part.Color = Color3.fromRGB(255, 0, 0);
		part.Anchored = true;
		part.CanCollide = false;
		part.CanTouch = false;
		part.CanQuery = false;
		part.CastShadow = false;
		part.Position = pos;
		part.Parent = Workspace;
		this.closeTargetPart = part;
	}

	/** Remove the close-phase target indicator if present. */
	public hideCloseTarget(): void {
		if (this.closeTargetPart) {
			this.closeTargetPart.Destroy();
			this.closeTargetPart = undefined;
		}
	}
}
