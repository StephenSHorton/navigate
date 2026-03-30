import { predictTargetPosition } from "../util/prediction";
import { ManagedAgent } from "./ManagedAgent";

/**
 * Global compute budget — caps how many ComputeAsync calls
 * are started per Heartbeat frame across all managed agents.
 *
 * Uses a priority queue sorted by distance (closer = higher priority).
 * Each call is task.spawn'd so they yield concurrently.
 */
export class ComputeBudget {
	private budgetPerFrame: number;
	private pending = new Map<Model, ManagedAgent>();

	constructor(budgetPerFrame: number) {
		this.budgetPerFrame = budgetPerFrame;
	}

	/** Enqueue an agent that needs a path recomputation. */
	public enqueue(agent: ManagedAgent): void {
		if (agent.computeInFlight) return;
		this.pending.set(agent.agentModel, agent);
	}

	/** Remove an agent from the queue. */
	public dequeue(agent: ManagedAgent): void {
		this.pending.delete(agent.agentModel);
	}

	/** Process up to budgetPerFrame agents this frame. */
	public processFrame(enablePrediction: boolean): void {
		if (this.pending.size() === 0) return;

		// Collect and sort by priority (ascending = higher priority first)
		const sorted: ManagedAgent[] = [];
		for (const [_, agent] of this.pending) {
			agent.priority = agent.getDistanceToTarget() - agent.priorityBias;
			sorted.push(agent);
		}
		table.sort(sorted, (a, b) => a.priority < b.priority);

		// Process up to budget
		const count = math.min(this.budgetPerFrame, sorted.size());
		for (let i = 0; i < count; i++) {
			const agent = sorted[i];
			this.pending.delete(agent.agentModel);
			this.dispatchCompute(agent, enablePrediction);
		}
	}

	/** Start a path computation for an agent via task.spawn (non-blocking). */
	private dispatchCompute(agent: ManagedAgent, enablePrediction: boolean): void {
		if (!agent.target) return;

		const targetPos = enablePrediction
			? predictTargetPosition(agent.getPosition(), agent.target, agent.speed)
			: agent.target.Position;

		agent.computeInFlight = true;
		agent.lastComputeTime = os.clock();
		agent.lastComputedGoal = targetPos;

		task.spawn(() => {
			agent.pathAgent.run(targetPos);
			agent.computeInFlight = false;
		});
	}

	/** Update the per-frame budget. */
	public setBudget(budget: number): void {
		this.budgetPerFrame = budget;
	}

	/** Clear all pending agents. */
	public clear(): void {
		this.pending.clear();
	}
}
