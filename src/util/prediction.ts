import { Workspace } from "@rbxts/services";

/**
 * Predict where a target will be when the agent arrives.
 *
 * Uses iterative refinement: estimate travel time to the target's current
 * position, project the target forward by that time, recompute travel time
 * to the projected position, and repeat.
 *
 * @param agentPosition - Current position of the pursuing agent
 * @param targetPart - The BasePart being pursued (reads Position + AssemblyLinearVelocity)
 * @param agentSpeed - Movement speed of the agent (studs/s)
 * @param iterations - Refinement iterations (default: 2)
 * @returns Predicted world-space position
 */
export function predictTargetPosition(
	agentPosition: Vector3,
	targetPart: BasePart,
	agentSpeed: number,
	iterations = 2,
): Vector3 {
	const targetPos = targetPart.Position;
	const velocity = targetPart.AssemblyLinearVelocity;

	// If target is stationary or agent speed is zero, just return current position
	if (velocity.Magnitude < 0.1 || agentSpeed <= 0) {
		return targetPos;
	}

	let predicted = targetPos;

	for (let i = 0; i < iterations; i++) {
		const distance = agentPosition.sub(predicted).Magnitude;
		const travelTime = distance / agentSpeed;
		predicted = targetPos.add(velocity.mul(travelTime));
	}

	// Clamp prediction to a reasonable range — don't predict further than
	// 2x the straight-line travel distance to avoid wild overshoots
	const maxPredictionDist = agentPosition.sub(targetPos).Magnitude * 2;
	const predictionOffset = predicted.sub(targetPos).Magnitude;

	if (predictionOffset > maxPredictionDist) {
		const direction = predicted.sub(targetPos).Unit;
		predicted = targetPos.add(direction.mul(maxPredictionDist));
	}

	return predicted;
}
