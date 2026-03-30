import { ManagedAgent } from "./ManagedAgent";

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

		// For each target group, run greedy clustering
		const newClusters = new Map<string, Cluster>();

		for (const [target, group] of byTarget) {
			// Sort by distance to target so closer agents become leaders
			table.sort(group, (a, b) => a.getDistanceToTarget() < b.getDistanceToTarget());

			const activeClusters: Cluster[] = [];

			for (const agent of group) {
				// Check if agent can join an existing cluster
				let joined = false;

				// If agent already has a cluster, check drift
				if (agent.clusterId) {
					const existing = this.clusters.get(agent.clusterId);
					if (existing && existing.leader !== agent) {
						const driftDist = agent.getPosition().sub(existing.leader.getPosition()).Magnitude;
						if (driftDist <= driftThreshold) {
							// Still close enough — keep assignment
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
					// Try joining the nearest active cluster
					for (const cluster of activeClusters) {
						const dist = agent.getPosition().sub(cluster.centroid).Magnitude;
						if (dist <= clusterRadius) {
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
