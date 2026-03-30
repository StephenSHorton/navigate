import { ArrivalBehavior } from "../core/types";

/**
 * Compute the arrival position for an agent in a group.
 *
 * @param behavior - Arrival behavior configuration
 * @param targetPosition - The target's current/predicted position
 * @param agentIndex - This agent's index within its group (0 = leader)
 * @param totalAgents - Total agents in the group
 * @param approachDirection - Stable direction the group is approaching FROM (e.g., pathfinder→target)
 * @returns World-space position this agent should move toward on arrival
 */
export function computeArrivalPosition(
	behavior: ArrivalBehavior,
	targetPosition: Vector3,
	agentIndex: number,
	totalAgents: number,
	approachDirection: Vector3,
): Vector3 {
	switch (behavior.arrivalType) {
		case "converge":
			return targetPosition;

		case "surround":
			return computeSurround(targetPosition, agentIndex, totalAgents, behavior.radius ?? 10);

		case "stack":
			return computeStack(
				targetPosition,
				agentIndex,
				approachDirection,
				behavior.radius ?? 5,
				behavior.stackDistance ?? 3,
			);

		case "spread":
			return computeSpread(
				targetPosition,
				agentIndex,
				totalAgents,
				approachDirection,
				behavior.radius ?? 10,
			);
	}
}

/** Surround: distribute evenly in a circle around target. */
function computeSurround(
	targetPos: Vector3,
	agentIndex: number,
	totalAgents: number,
	radius: number,
): Vector3 {
	const angle = (agentIndex / totalAgents) * 2 * math.pi;
	return targetPos.add(new Vector3(math.cos(angle) * radius, 0, math.sin(angle) * radius));
}

/** Stack: line up behind the approach direction. */
function computeStack(
	targetPos: Vector3,
	agentIndex: number,
	approachDir: Vector3,
	radius: number,
	stackDistance: number,
): Vector3 {
	const flatDir = new Vector3(approachDir.X, 0, approachDir.Z);
	const direction = flatDir.Magnitude > 0.1 ? flatDir.Unit : new Vector3(0, 0, 1);
	return targetPos.add(direction.mul(radius + agentIndex * stackDistance));
}

/** Spread: semicircle fan on the approach side. */
function computeSpread(
	targetPos: Vector3,
	agentIndex: number,
	totalAgents: number,
	approachDir: Vector3,
	radius: number,
): Vector3 {
	const flatDir = new Vector3(approachDir.X, 0, approachDir.Z);
	const baseDir = flatDir.Magnitude > 0.1 ? flatDir.Unit : new Vector3(0, 0, 1);

	if (totalAgents <= 1) return targetPos.add(baseDir.mul(radius));

	const halfArc = math.pi;
	const angleStep = halfArc / (totalAgents - 1);
	const angle = -halfArc / 2 + agentIndex * angleStep;

	// Rotate baseDir around Y axis by angle
	const cosA = math.cos(angle);
	const sinA = math.sin(angle);
	const rotated = new Vector3(
		baseDir.X * cosA - baseDir.Z * sinA,
		0,
		baseDir.X * sinA + baseDir.Z * cosA,
	);

	return targetPos.add(rotated.mul(radius));
}
