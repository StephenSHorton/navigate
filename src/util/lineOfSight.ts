import { Workspace } from "@rbxts/services";

/**
 * Check if there is an unobstructed straight line between two points.
 *
 * @param from - Start position
 * @param to - End position
 * @param ignoreInstances - Instances to exclude from the raycast (e.g., the agent's model)
 * @param raycastParams - Optional pre-configured RaycastParams. If provided, ignoreInstances is not used.
 * @returns true if nothing blocks the line between from and to
 */
export function hasLineOfSight(
	from: Vector3,
	to: Vector3,
	ignoreInstances?: Instance[],
	raycastParams?: RaycastParams,
): boolean {
	const params =
		raycastParams ??
		(() => {
			const p = new RaycastParams();
			p.FilterType = Enum.RaycastFilterType.Exclude;
			if (ignoreInstances) {
				p.FilterDescendantsInstances = ignoreInstances;
			}
			return p;
		})();

	const direction = to.sub(from);
	const result = Workspace.Raycast(from, direction, params);

	return result === undefined;
}
