import { PursuitPhase } from "../core/types";
import { hasLineOfSight } from "../util/lineOfSight";
import { ManagedAgent } from "./ManagedAgent";

const HYSTERESIS_BAND = 5;

/**
 * Compute the pursuit phase transition for a managed agent.
 *
 * - IDLE: no target
 * - CLOSE: within threshold AND has line-of-sight
 * - FAR: beyond threshold or no LOS (pathfinding required)
 *
 * Hysteresis: close→far uses threshold + HYSTERESIS_BAND to prevent oscillation.
 *
 * LOS check prevents the zombie from MoveTo'ing through walls when the target
 * is close in straight-line distance but on a different floor / behind cover.
 */
export function computePursuitPhase(
	agent: ManagedAgent,
	closeRangeThreshold: number,
): PursuitPhase {
	if (!agent.target) return "idle";

	const distance = agent.getDistanceToTarget();
	const currentPhase = agent.pursuitPhase;

	// Determine the effective threshold based on current phase
	const effectiveThreshold =
		currentPhase === "close"
			? closeRangeThreshold + HYSTERESIS_BAND
			: closeRangeThreshold;

	if (distance > effectiveThreshold) return "far";

	// Within range — require LOS to actually transition to CLOSE.
	// Ray from agent pivot to target position. Ignore the agent's own model
	// AND the target's owning model (so the raycast doesn't hit the target's
	// own body before reaching the destination point inside it).
	const ignore: Instance[] = [agent.agentModel];
	const targetOwner = agent.target.FindFirstAncestorOfClass("Model");
	if (targetOwner) ignore.push(targetOwner);

	const losClear = hasLineOfSight(
		agent.getPosition(),
		agent.target.Position,
		ignore,
	);

	return losClear ? "close" : "far";
}
