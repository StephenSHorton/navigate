import { hasLineOfSight } from "../util/lineOfSight";
import { ManagedAgent } from "./ManagedAgent";

/**
 * A follower must be able to raycast to its cluster leader. Without LOS
 * (e.g. they're on different floors), MoveTo(leaderPos) can't navigate
 * obstacles and the follower would walk into walls. No-LOS agents fall
 * out of the cluster and pathfind on their own.
 *
 * `ignoreModels` should include every agent in the system — otherwise the
 * raycast hits unrelated NPCs standing between agent and leader, causing
 * spurious cluster fragmentation in dense crowds.
 */
function canFollow(
	agent: ManagedAgent,
	leader: ManagedAgent,
	ignoreModels: Instance[],
): boolean {
	return hasLineOfSight(agent.getPosition(), leader.getPosition(), ignoreModels);
}

interface Cluster {
	id: string;
	target: BasePart;
	leader: ManagedAgent;
	followers: ManagedAgent[];
	centroid: Vector3;
}

/**
 * Path sharing via greedy spatial clustering.
 *
 * NPCs pursuing the same target from nearby positions are grouped
 * into clusters. Only the cluster leader computes a path; followers
 * reuse the leader's waypoints.
 */
export class PathCache {
	private clusters = new Map<string, Cluster>();
	private nextClusterId = 0;

	/**
	 * Rebuild clusters from the current set of FAR-phase agents.
	 * Call once per tick.
	 */
	public updateClusters(
		agents: ManagedAgent[],
		allAgents: ManagedAgent[],
		clusterRadius: number,
		driftThreshold: number,
	): void {
		// Group agents by target
		const byTarget = new Map<BasePart, ManagedAgent[]>();
		for (const agent of agents) {
			if (!agent.target || agent.groupId) continue;
			let group = byTarget.get(agent.target);
			if (!group) {
				group = [];
				byTarget.set(agent.target, group);
			}
			group.push(agent);
		}

		// Clear stale cluster assignments
		for (const agent of agents) {
			if (agent.clusterId) {
				const cluster = this.clusters.get(agent.clusterId);
				if (!cluster) {
					agent.clusterId = undefined;
					agent.isClusterLeader = false;
				}
			}
		}

		// Build a single "ignore all agents" list once per update so the LOS
		// raycast in canFollow doesn't get blocked by other NPCs standing
		// between the candidate and its prospective leader. Includes CLOSE
		// and idle agents — they aren't in the cluster, but their bodies
		// can still block raycasts between two FAR-phase agents.
		const allAgentModels: Instance[] = [];
		for (const agent of allAgents) allAgentModels.push(agent.agentModel);

		// For each target group, run greedy clustering
		const newClusters = new Map<string, Cluster>();

		for (const [target, group] of byTarget) {
			// Sort by distance to target so closer agents become leaders
			table.sort(group, (a, b) => a.getDistanceToTarget() < b.getDistanceToTarget());

			const activeClusters: Cluster[] = [];

			for (const agent of group) {
				// Check if agent can join an existing cluster
				let joined = false;

				// If agent already has a cluster, check drift + LOS to leader
				if (agent.clusterId) {
					const existing = this.clusters.get(agent.clusterId);
					if (existing && existing.leader !== agent) {
						const driftDist = agent.getPosition().sub(existing.leader.getPosition()).Magnitude;
						if (driftDist <= driftThreshold && canFollow(agent, existing.leader, allAgentModels)) {
							// Still close enough AND can see leader — keep assignment
							let found = false;
							for (const c of activeClusters) {
								if (c.id === agent.clusterId) {
									c.followers.push(agent);
									found = true;
									break;
								}
							}
							if (!found) {
								// Re-add the cluster
								const rebuilt: Cluster = {
									id: existing.id,
									target,
									leader: existing.leader,
									followers: [agent],
									centroid: existing.leader.getPosition(),
								};
								activeClusters.push(rebuilt);
							}
							joined = true;
						}
					}
				}

				if (!joined) {
					// Try joining the nearest active cluster (must have LOS to its leader)
					for (const cluster of activeClusters) {
						const dist = agent.getPosition().sub(cluster.centroid).Magnitude;
						if (dist <= clusterRadius && canFollow(agent, cluster.leader, allAgentModels)) {
							cluster.followers.push(agent);
							agent.clusterId = cluster.id;
							agent.isClusterLeader = false;
							joined = true;
							break;
						}
					}
				}

				if (!joined) {
					// Create a new cluster with this agent as leader
					const id = `cluster_${this.nextClusterId++}`;
					const cluster: Cluster = {
						id,
						target,
						leader: agent,
						followers: [],
						centroid: agent.getPosition(),
					};
					activeClusters.push(cluster);
					agent.clusterId = id;
					agent.isClusterLeader = true;
				}
			}

			// Register all active clusters
			for (const cluster of activeClusters) {
				cluster.leader.clusterId = cluster.id;
				cluster.leader.isClusterLeader = true;
				newClusters.set(cluster.id, cluster);
			}
		}

		this.clusters = newClusters;
	}

	/** Get the cluster for a given ID. */
	public getCluster(clusterId: string): Cluster | undefined {
		return this.clusters.get(clusterId);
	}

	/** Check if an agent is a cluster leader (should compute its own path). */
	public isLeader(agent: ManagedAgent): boolean {
		return agent.isClusterLeader || agent.clusterId === undefined;
	}

	/** Clear all clusters. */
	public clear(): void {
		this.clusters.clear();
	}
}
