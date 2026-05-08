# @rbxts/navigate

Composable TypeScript-native pathfinding suite for roblox-ts. Wraps Roblox's `PathfindingService` with scalable multi-agent coordination, formations, and arrival behaviors.

## Install

```bash
bun add @rbxts/navigate
# or
npm install @rbxts/navigate
```

## Quick start

Single agent:

```ts
import { PathAgent } from "@rbxts/navigate";

const agent = new PathAgent(npcModel, {
  agentParams: { AgentRadius: 2, AgentHeight: 5, AgentCanJump: true },
  speed: 16,
  visualize: true,
});

agent.run(targetPart);
```

Many agents (multi-NPC pursuit, auto-clustering, compute budget):

```ts
import { PathManager } from "@rbxts/navigate";

const manager = PathManager.create();

const managed = manager.registerAgent(npcModel, {
  speed: 12,
  visualize: true,
});

manager.setTarget(npcModel, playerRootPart);
```

Or, for an explicit group with formation + arrival behavior:

```ts
manager.createGroup("squad", [npc1, npc2, npc3], {
  formation: { formationType: "wedge", spacing: 6 },
  arrivalBehavior: { arrivalType: "surround", radius: 12 },
});
```

## Layers

- **PathAgent (Layer 1)** — single-agent wrapper around `PathfindingService`. Handles waypoints, jumps, stuck detection, visualization.
- **PathManager** — singleton coordinator for many agents:
  - Two-phase pursuit (FAR = pathfinding, CLOSE = direct `MoveTo`) with line-of-sight guard
  - Auto-clustering — nearby NPCs pursuing the same target share one path; followers `MoveTo(leader)` instead of pathfinding
  - Per-frame compute budget caps `ComputeAsync` calls
- **Groups + formations + arrival behaviors** — explicit named groups with `wedge`/`line`/`circle`/`grid` formations and `converge`/`surround`/`stack`/`spread` arrival.

## License

MIT
