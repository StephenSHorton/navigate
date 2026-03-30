import { Formation } from "../core/types";

/**
 * Compute the world-space offset for a follower in a formation.
 *
 * @param formation - Formation configuration
 * @param followerIndex - 0-based index among followers (leader excluded)
 * @param followerCount - Total number of followers
 * @param leaderForward - Unit vector of leader's heading direction
 * @returns World-space offset vector to add to leader's position
 */
export function computeFormationOffset(
	formation: Formation,
	followerIndex: number,
	followerCount: number,
	leaderForward: Vector3,
): Vector3 {
	const spacing = formation.spacing;
	const right = new Vector3(0, 1, 0).Cross(leaderForward).Unit;

	switch (formation.formationType) {
		case "none":
			return Vector3.zero;

		case "line":
			return computeLineOffset(followerIndex, spacing, right);

		case "wedge":
			return computeWedgeOffset(followerIndex, spacing, leaderForward, right);

		case "circle":
			return computeCircleOffset(followerIndex, followerCount, spacing);

		case "grid":
			return computeGridOffset(followerIndex, followerCount, spacing, leaderForward, right);

		case "custom":
			return computeCustomOffset(formation, followerIndex, leaderForward, right);
	}
}

/** Line: alternating left/right perpendicular to heading. */
function computeLineOffset(index: number, spacing: number, right: Vector3): Vector3 {
	const side = index % 2 === 0 ? 1 : -1;
	const rank = math.ceil((index + 1) / 2);
	return right.mul(side * rank * spacing);
}

/** Wedge (V-shape): spread backward and outward. */
function computeWedgeOffset(
	index: number,
	spacing: number,
	forward: Vector3,
	right: Vector3,
): Vector3 {
	const row = math.ceil((index + 1) / 2);
	const side = index % 2 === 0 ? 1 : -1;
	return forward.mul(-row * spacing).add(right.mul(side * row * spacing));
}

/** Circle: even ring around leader. */
function computeCircleOffset(index: number, followerCount: number, spacing: number): Vector3 {
	const totalAgents = followerCount + 1;
	const angle = ((index + 1) / totalAgents) * 2 * math.pi;
	return new Vector3(math.cos(angle) * spacing, 0, math.sin(angle) * spacing);
}

/** Grid: rectangular grid behind leader. */
function computeGridOffset(
	index: number,
	followerCount: number,
	spacing: number,
	forward: Vector3,
	right: Vector3,
): Vector3 {
	const columns = math.ceil(math.sqrt(followerCount + 1));
	const row = math.floor(index / columns) + 1;
	const col = index % columns;
	const centerCol = (columns - 1) / 2;
	return forward.mul(-row * spacing).add(right.mul((col - centerCol) * spacing));
}

/** Custom: lookup from offsets array, rotated by leader heading. */
function computeCustomOffset(
	formation: Formation,
	index: number,
	forward: Vector3,
	right: Vector3,
): Vector3 {
	if (!formation.offsets || index >= formation.offsets.size()) {
		return Vector3.zero;
	}
	const offsetVec = formation.offsets[index];
	// Rotate offset by leader heading (X = right, Z = forward)
	return right.mul(offsetVec.X).add(new Vector3(0, offsetVec.Y, 0)).add(forward.mul(offsetVec.Z));
}
