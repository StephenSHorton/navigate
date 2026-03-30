import { PursuitPhase } from "../core/types";
import { ManagedAgent } from "./ManagedAgent";

const HYSTERESIS_BAND = 5;

/**
 * Compute the pursuit phase transition for a managed agent.
 *
 * - IDLE: no target
 * - CLOSE: within threshold AND has line-of-sight
 * - FAR: beyond threshold or no LOS
 *
 * Hysteresis: close→far uses threshold + HYSTERESIS_BAND to prevent oscillation.
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

	if (distance <= effectiveThreshold) {
		return "close";
	}

	return "far";
}
