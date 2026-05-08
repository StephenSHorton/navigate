# @rbxts/navigate

Composable, TypeScript-native pathfinding for [roblox-ts][rbxts]. Wraps Roblox's `PathfindingService` with the things it doesn't give you out of the box: **multi-agent coordination**, **formations**, **arrival behaviors**, and **scalable pursuit** with a per-frame compute budget.

```ts
import { PathManager } from "@rbxts/navigate";

const manager = PathManager.create();
manager.registerAgent(zombieModel, { speed: 14, visualize: true });
manager.setTarget(zombieModel, player.Character.HumanoidRootPart);
```

That's it — the zombie pursues, recovers from getting stuck, transitions to direct steering when close, and never overlaps with `ComputeAsync` calls from other zombies.

[rbxts]: https://roblox-ts.com

---

## Why

Roblox's built-in `PathfindingService` is a navmesh + a path object, and that's it. Anything past "one NPC walking somewhere" is on you:

- **Many NPCs at once** → unbounded `ComputeAsync` calls per frame, frame drops.
- **A swarm chasing one player** → every NPC pathfinds independently to the same target.
- **Close-range pursuit** → the path lags behind the player; NPCs run to where you *were*.
- **Formations** → not a thing.

`navigate` is the layer above. You opt into the parts you need: the single-agent wrapper, the multi-agent manager, or the group/formation system on top.

---

## Install

```sh
bun add @rbxts/navigate
# or
npm install @rbxts/navigate
```

---

## Layers

| Layer | What | When |
|---|---|---|
| `PathAgent` | Single-agent wrapper around `PathfindingService`. Waypoints, jumps, stuck detection, visualization. | One-off NPCs; total control. |
| `PathManager` | Multi-agent coordinator (singleton). Two-phase pursuit, auto-clustering, per-frame compute budget. | Squads, swarms, anything > 1 agent. |
| Groups + formations + arrival | Explicit named groups with `wedge`/`line`/`circle`/`grid` formations and `converge`/`surround`/`stack`/`spread` arrival. | Tactical AI. Encounters that need shape. |

You can mix: a `PathManager` with both ungrouped agents (auto-clustered) and explicit named groups.

---

## Quick start

### Single agent

```ts
import { PathAgent } from "@rbxts/navigate";

const agent = new PathAgent(npcModel, {
  agentParams: { AgentRadius: 2, AgentHeight: 5, AgentCanJump: true },
  speed: 16,
  visualize: true, // draws path waypoints
});

agent.run(targetPart); // or a Vector3

agent.reached.Connect((waypoint, partial) => {
  print("arrived (partial:", partial, ")");
});

agent.stuck.Connect(() => {
  print("can't make progress — try jumping or pick a new goal");
});
```

`PathAgent` works standalone — no `PathManager` required.

### Many agents pursuing a player

```ts
import { PathManager } from "@rbxts/navigate";

const manager = PathManager.create();

for (const zombie of allZombies) {
  manager.registerAgent(zombie, {
    speed: 12,
    visualize: false,
    agentParams: { AgentRadius: 2, AgentHeight: 5, AgentCanJump: true },
  });
}

manager.setTargetAll(player.Character.HumanoidRootPart);
```

The manager handles everything from here:

- Caps `ComputeAsync` calls per frame (default 20). Excess agents wait their turn.
- Clusters nearby agents pursuing the same target — only the closest one to the target pathfinds; the rest follow it directly.
- When an agent gets within ~20 studs of the target *with line-of-sight*, it switches to direct steering (`Humanoid:MoveTo`) for smooth close-range pursuit.

---

## Groups, formations, and arrival

For coordinated movement (squads, escorts, encounter design), use named groups.

```ts
manager.createGroup("alpha-squad", [grunt1, grunt2, grunt3, grunt4], {
  formation: { formationType: "wedge", spacing: 6 },
  arrivalBehavior: { arrivalType: "surround", radius: 12 },
});

manager.setTarget(grunt1, playerRoot); // any member; group inherits
```

The group picks one pathfinder. Other members ride the formation: a wedge shape while moving, then redistribute to surround the target on arrival.

### Formation types

| Type | Shape |
|---|---|
| `none` | All followers converge on the leader (no offset). |
| `line` | Alternating left/right perpendicular to heading. |
| `wedge` | V-shape spreading backward from the leader. |
| `circle` | Even ring around the leader. |
| `grid` | Square grid behind the leader. |
| `custom` | You provide an `offsets: Vector3[]` array, leader-local. |

Set spacing to control density:

```ts
{ formationType: "line",   spacing: 4 }   // tight infantry line
{ formationType: "wedge",  spacing: 8 }   // loose V
{ formationType: "circle", spacing: 10 }  // ring around the leader
{ formationType: "grid",   spacing: 5 }   // square block behind
```

Or hand-place each member:

```ts
{
  formationType: "custom",
  spacing: 0, // unused for custom
  offsets: [
    new Vector3(-4, 0, -2),
    new Vector3( 4, 0, -2),
    new Vector3(-8, 0, -4),
    new Vector3( 8, 0, -4),
  ],
}
```

Custom offsets are in leader-local space (X = right, Z = forward) and get rotated to follow the leader's heading.

### Arrival behaviors

When the group reaches its target, members redistribute:

| Type | Behavior | Use case |
|---|---|---|
| `converge` | All members move to the target position. | Default; pile-on attack. |
| `surround` | Even ring around target at `radius`. | Encirclement, boss fights. |
| `stack` | Line up behind the approach direction at `stackDistance` apart. | Single-file through a doorway. |
| `spread` | Semicircle fan on the approach side at `radius`. | Firing line, "we have you cornered." |

```ts
manager.setArrivalBehavior("alpha-squad", {
  arrivalType: "surround",
  radius: 14,
});
```

The approach direction is **cached** the moment the group first enters CLOSE phase, so members don't oscillate as the target moves.

---

## Configuration reference

### Per-agent

```ts
manager.registerAgent(model, {
  // Pathfinding
  agentParams: { AgentRadius: 2, AgentHeight: 5, AgentCanJump: true },

  // Movement
  speed: 16,
  visualize: false,

  // Stuck detection
  timeoutEnabled: true,
  timeoutMultiplier: 2, // 2x estimated time before declared stuck

  // Pursuit tuning
  enablePrediction: false, // aim ahead of moving target via velocity
  priorityBias: 0,         // higher = compute budget sooner

  // Custom movement (for non-humanoid agents)
  onMove: (pos) => {/* drive a vehicle */},
  onJump: () => {/* … */},
});
```

### Manager (global)

```ts
PathManager.create({
  computeBudgetPerFrame: 20,    // ComputeAsync calls/frame
  closeRangeThreshold: 20,      // FAR↔CLOSE switch distance
  dirtyDistanceThreshold: 10,   // target-moved distance that triggers recompute
  recomputeCooldown: 0.5,       // min seconds between recomputes per agent
  clusterRadius: 15,            // cluster join radius
  clusterDriftThreshold: 20,    // follower drift before leaving cluster
  updateInterval: 0.1,          // 10 Hz manager tick
});
```

---

## Visualization

When `visualize: true` on an agent, the manager paints small neon parts at each waypoint:

| Color | Meaning |
|---|---|
| 🟢 Green | This agent is its own pathfinder (cluster leader / ungrouped). |
| 🟠 Orange | Group pathfinder waypoints. |
| 🔵 Cyan | Follower (no compute — riding leader's path). |
| 🟡 Yellow | Jump waypoint. |
| 🔴 Red | Final destination. Also: CLOSE-phase target indicator. |

Stale waypoints persist across phase transitions until a new path replaces them — useful for debugging.

For runtime stats (agent counts, leader/follower counts, FAR/CLOSE/idle splits), call:

```ts
const stats = manager.getStats();
//   total, far, close, idle, leaders, followers, clusters, groups
```

Wire that into your own debug HUD however you like.

---

## Pursuit model

The manager runs each agent through three pursuit states:

```
              ┌────────┐  has target & in range & LOS
   spawn ─→  │  IDLE  │ ────────────────────────────────→ ┌─────────┐
              └────────┘                                   │  CLOSE  │
                  ↑↑                                       │ MoveTo  │
                  ││                                       │ direct  │
                  ││                                       └─────────┘
                  ││  out of range or LOS broken         distance > threshold
                  ││  ←────────────────────────────────  or LOS broken
                  ││                                          │
                  ││                                          ↓
                  ││                                       ┌─────────┐
                  └┴───────────────────────────────────────│  FAR    │
                          target lost                      │  paths  │
                                                           └─────────┘
```

- **FAR** = use `PathfindingService` for full nav-mesh paths. Compute is rate-limited.
- **CLOSE** = direct `Humanoid:MoveTo` toward the target. Smoother and cheaper, but only when the path is straight (LOS check guards against walking into walls / off ledges).
- **IDLE** = no target, no movement.

Auto-clustering kicks in during FAR: ungrouped agents pursuing the same target form clusters by spatial proximity (with line-of-sight required between follower and leader). Followers `MoveTo(leader.position)` instead of running their own `ComputeAsync`. One pathfinder, N followers, cheap as chips.

---

## Working with signals

`PathAgent` exposes Roblox-style signals you can connect to:

```ts
const agent = manager.registerAgent(npc, { speed: 16 }).pathAgent;

agent.reached.Connect((waypoint, partial) => { /* arrived */ });
agent.waypointReached.Connect((current, upcoming) => { /* per-step */ });
agent.blocked.Connect((waypointIdx) => { /* obstruction ahead */ });
agent.stuck.Connect(() => { /* timeout — try jumping or repath */ });
agent.error.Connect((err) => { /* "no_path" | "timeout" | etc. */ });
agent.statusChanged.Connect((newStatus, oldStatus) => { /* … */ });
agent.stopped.Connect(() => { /* explicit stop() called */ });
```

`PathManager` emits one signal:

```ts
manager.phaseChanged.Connect((agent, newPhase, oldPhase) => {
  // useful for triggering attack animations on FAR → CLOSE
});
```

---

## Cleanup

`PathManager` owns the `RunService.Heartbeat` connection. Tear it down explicitly when you're done:

```ts
manager.unregisterAgent(npcModel); // single
manager.destroy();                 // entire manager
```

Per-agent `PathAgent` instances created without a manager:

```ts
agent.destroy();
```

---

## License

MIT — © 2026 Stephen Horton.
