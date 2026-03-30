import { AgentGroupConfig, ArrivalBehavior, Formation } from "../core/types";
import { ManagedAgent } from "./ManagedAgent";

/** An explicit agent group with formation and arrival behavior. */
export class AgentGroup {
	public readonly id: string;
	public formation: Formation;
	public arrivalBehavior: ArrivalBehavior;

	private pathfinder: ManagedAgent | undefined;
	private members: ManagedAgent[] = [];

	/** Cached approach direction, set once when group first enters CLOSE. */
	public arrivalApproachDir: Vector3 | undefined;

	constructor(id: string, config?: AgentGroupConfig) {
		this.id = id;
		this.formation = config?.formation ?? { formationType: "none", spacing: 4 };
		this.arrivalBehavior = config?.arrivalBehavior ?? { arrivalType: "converge" };
	}

	/** Add a managed agent to this group. */
	public addMember(agent: ManagedAgent): void {
		if (agent.groupId === this.id) return;
		agent.groupId = this.id;
		this.members.push(agent);
	}

	/** Remove a managed agent from this group. */
	public removeMember(agent: ManagedAgent): void {
		const idx = this.members.indexOf(agent);
		if (idx === -1) return;
		this.members.unorderedRemove(idx);
		agent.groupId = undefined;

		if (this.pathfinder === agent) {
			this.pathfinder = undefined;
		}
	}

	/** Get all members. */
	public getMembers(): ManagedAgent[] {
		return this.members;
	}

	/** Get the pathfinder — the member that computes the path (closest to target). */
	public getPathfinder(): ManagedAgent | undefined {
		return this.pathfinder;
	}

	/** Get a member's index among all members (0-based). Used for centroid-centric formations. */
	public getMemberIndex(agent: ManagedAgent): number {
		return this.members.indexOf(agent);
	}

	/** Elect the member closest to the target as pathfinder. */
	public electPathfinder(): void {
		let closest: ManagedAgent | undefined;
		let closestDist = math.huge;

		for (const member of this.members) {
			if (member.pursuitPhase !== "far") continue;
			const dist = member.getDistanceToTarget();
			if (dist < closestDist) {
				closest = member;
				closestDist = dist;
			}
		}

		this.pathfinder = closest;
	}

	/** Compute the centroid of all FAR-phase members. */
	public computeCentroid(): Vector3 {
		let sum = Vector3.zero;
		let count = 0;

		for (const member of this.members) {
			if (member.pursuitPhase !== "far") continue;
			sum = sum.add(member.getPosition());
			count++;
		}

		return count > 0 ? sum.div(count) : Vector3.zero;
	}

	/** Get member count. */
	public getMemberCount(): number {
		return this.members.size();
	}

	/** Clean up: clear group references from all members. */
	public destroy(): void {
		for (const member of this.members) {
			member.groupId = undefined;
		}
		this.members = [];
		this.pathfinder = undefined;
	}
}
