# CLAUDE.md

## Project Overview

**@rbxts/navigate** is a composable TypeScript-native pathfinding suite for roblox-ts. It wraps Roblox's PathfindingService with scalable multi-agent coordination, formations, and arrival behaviors.

## Commands

```bash
bun install        # Install dependencies
bun run build      # Compile TypeScript to Luau
bun run watch      # Watch mode
```

After building, the compiled output is in `out/`. Consumer projects link to this package via a junction to `out/`.

**Consumer sync:** Use the [rojo-push](https://github.com/StephenSHorton/rojo-push) fork in consuming projects so library rebuilds propagate to Studio reliably across junctions. Run `rojo serve --no-watch` once, then `rojo push` after every `bun run build` here. No watcher = no missed events, no restarts.

## Architecture

### Package Structure

```
src/
├── core/types.ts              # All shared types
├── agent/PathAgent.ts         # Layer 1: Single-agent pathfinding wrapper
├── manager/                   # PathManager + Layer 3 coordination
│   ├── PathManager.ts         # Singleton coordinator (heartbeat loop)
│   ├── ManagedAgent.ts        # Per-agent state wrapper
│   ├── PursuitState.ts        # Two-phase pursuit (far/close transitions)
│   ├── ComputeBudget.ts       # Global ComputeAsync throttling
│   ├── PathCache.ts           # Spatial clustering for path sharing
│   ├── AgentGroup.ts          # Explicit group management
│   ├── FormationSolver.ts     # Formation offset math
│   └── ArrivalSolver.ts       # Arrival position math
├── util/
│   ├── prediction.ts          # Velocity-based target prediction
│   └── lineOfSight.ts         # Raycast LOS utility
└── index.ts                   # Public API exports
```

### Layer 1 — PathAgent

Low-level wrapper around PathfindingService. Handles path computation, waypoint traversal, stuck detection, jump handling, non-humanoid support, and visualization. Can be used standalone without PathManager.

### PathManager (Coordinator)

Singleton that manages 100+ agents efficiently:

- **Two-phase pursuit**: FAR (pathfinding via ComputeAsync) and CLOSE (direct MoveTo with prediction)
- **Predictive targeting**: Uses AssemblyLinearVelocity to aim ahead of moving targets
- **Compute budget**: Priority queue caps ComputeAsync calls per frame (default 20)
- **Auto-clustering**: Ungrouped agents pursuing the same target are spatially clustered. Leaders compute paths, followers moveTo(leaderPos)
- **Collision groups**: Leaders pass through NPCs (`NavigateLeader`), followers collide normally (`NavigateAgent`). Grouped agents are always non-colliding.

### Layer 3 — Groups, Formations, Arrival Behaviors

Explicit groups with configurable formation and arrival:

- **Formations** (FAR phase): wedge, line, circle, grid, custom, none
- **Arrival behaviors** (CLOSE phase): converge, surround, stack, spread
- **Group arrival**: When any member enters CLOSE, the entire group transitions together
- **Approach direction caching**: Locked on first CLOSE transition to prevent circular chasing

## roblox-ts Constraints

- **No getters/setters** — use explicit methods (`getStatus()`, `setVisualize()`)
- **`next` and `local` are reserved** — use `following`, `upcoming`, `offsetVec`, etc.
- **`index.ts` compiles to `init.luau`** — entry point for the package

## Key Design Decisions

1. **PathfindingService is the engine, not the product.** We wrap it and route around its failure modes but never reimplement navmesh traversal.
2. **Compute efficiency drives the architecture.** One pathfinder per group/cluster. Followers use cheap `moveTo()` instead of `ComputeAsync`.
3. **Stuck/reached agents auto-recover.** `needsRecompute()` triggers on stuck, error, or reached status — not just target movement.
4. **Formation offsets anchor on the pathfinder** (stable), not the centroid (oscillates).
5. **Arrival directions are cached** on first CLOSE transition to prevent feedback loops.

## Consumer Pattern

In a Flamework project, use a component with `NPC` tag:

```typescript
const manager = PathManager.create();
const managed = manager.registerAgent(npcModel, { speed: 16, visualize: true });
manager.setTarget(npcModel, playerRootPart);

// Optional: explicit group with formation
manager.createGroup("squad", [model1, model2, ...], {
  formation: { formationType: "wedge", spacing: 6 },
  arrivalBehavior: { arrivalType: "surround", radius: 12 },
});
```

Studio attributes for auto-grouping: `Group`, `Formation`, `Spacing`, `ArrivalType`, `ArrivalRadius` (PascalCase).

## Visualization Colors

- **Green** — auto-clustered leader waypoints
- **Orange** — group pathfinder waypoints
- **Cyan** — follower (auto-clustered or grouped)
- **Yellow** — jump waypoint
- **Red** — final destination waypoint
