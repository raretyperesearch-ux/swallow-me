import { GAME_CONFIG } from "../config/gameConfig";
import { ServerSnake } from "./Snake";
import { ServerFood } from "./Food";
import { SpatialGrid } from "./SpatialGrid";

export interface KillEvent {
  killer: string | null; // null = wall death
  victim: string;
  victimValue: number;
  victimName: string;
  killerName: string;
  timestamp: number;
}

export interface FoodEatEvent {
  snakeId: string;
  foodId: string;
}

function distanceSq(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return dx * dx + dy * dy;
}

// Dynamic body radius — MUST match the client's visual radius formula
function getBodyRadius(segmentCount: number): number {
  return 6 + Math.pow(Math.max(1, segmentCount - 20), 0.35) * 3;
}

// Collision epsilon: forgiveness margin (px) — tightened to reduce pass-throughs
const COLLISION_EPSILON = 3;

// 2-tick collision persistence: carry counts between ticks
let pendingCollisionCounts = new Map<string, number>();

// Spawn grace period: ignore collisions for this long after spawning
const SPAWN_GRACE_MS = 2000;

/** Squared distance from point P to closest point on line segment AB (swept collision) */
function pointToSegmentDistSq(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  if (ab2 === 0) return apx * apx + apy * apy;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

/**
 * Ray-casting containment test: is point (px,py) inside the polygon
 * formed by a snake's body segments? Uses crossing-number algorithm.
 */
function isPointInsideSnakeLoop(
  px: number, py: number,
  segments: { x: number; y: number }[],
  minSegments: number = 20
): boolean {
  const n = segments.length;
  if (n < minSegments) return false;

  const head = segments[0];
  const tail = segments[n - 1];
  const closeDist = 200;
  const dx = head.x - tail.x;
  const dy = head.y - tail.y;
  if (dx * dx + dy * dy > closeDist * closeDist) return false;

  let crossings = 0;
  for (let i = 0; i < n; i++) {
    const a = segments[i];
    const b = segments[(i + 1) % n];

    if ((a.y <= py && b.y > py) || (b.y <= py && a.y > py)) {
      const t = (py - a.y) / (b.y - a.y);
      const ix = a.x + t * (b.x - a.x);
      if (px < ix) {
        crossings++;
      }
    }
  }

  return (crossings & 1) === 1;
}

// Spatial grid for food only — snake collision is brute force (airtight)
const foodGrid = new SpatialGrid(30);

/**
 * Check all head-to-body collisions between snakes.
 * BRUTE FORCE — no spatial grid, no skipping, no stride.
 * For 10-20 snakes this is fast enough and CANNOT miss.
 */
export function checkSnakeCollisions(
  snakes: Map<string, ServerSnake>
): KillEvent[] {
  const kills: KillEvent[] = [];
  const alreadyDead = new Set<string>();
  const nextCounts = new Map<string, number>();

  const now = Date.now();

  // HEAD vs BODY: swept capsule check (prevHead→head vs body segments)
  // Requires 2 consecutive ticks of overlap before confirming kill
  for (const [id, snake] of snakes) {
    if (!snake.alive || alreadyDead.has(id)) continue;
    // Spawn grace: newly spawned snakes can't be killed
    if (now - snake.spawnTime < SPAWN_GRACE_MS) continue;

    const headRadius = getBodyRadius(snake.segments.length);

    for (const [otherId, other] of snakes) {
      if (otherId === id || !other.alive || alreadyDead.has(otherId)) continue;

      const otherBodyRadius = getBodyRadius(other.segments.length);
      // Epsilon forgiveness: subtract margin to prevent phantom kills
      const killDist = headRadius + otherBodyRadius - COLLISION_EPSILON;
      const killDistSq = killDist * killDist;

      // Swept check: test body segment point against line from prevHead→head
      for (let i = 1; i < other.segments.length; i++) {
        const seg = other.segments[i];
        const dSq = pointToSegmentDistSq(
          seg.x, seg.y,
          snake.prevHeadX, snake.prevHeadY,
          snake.headX, snake.headY,
        );

        if (dSq < killDistSq) {
          const actualDist = Math.sqrt(dSq);
          const penetration = killDist - actualDist;
          const key = `${id}:${otherId}:${i}`;

          // Deep overlap threshold: mixed abs/relative for all snake sizes
          const deepThreshold = Math.max(2.0, killDist * 0.35);

          if (penetration >= deepThreshold) {
            // DEEP HIT: instant kill (prevents high-speed pass-through)
            if (!alreadyDead.has(id)) {
              console.log(`[KILL:deep_instant] victim=${snake.name}(${id}) killer=${other.name}(${otherId}) seg=${i} dist=${actualDist.toFixed(1)} killDist=${killDist.toFixed(1)} pen=${penetration.toFixed(1)}`);
              kills.push({
                killer: otherId,
                victim: id,
                victimValue: snake.valueUsdc,
                victimName: snake.name,
                killerName: other.name,
                timestamp: now,
              });
              alreadyDead.add(id);
            }
          } else {
            // SHALLOW EDGE TOUCH: require 2-tick persistence (anti-ghost-kill)
            const prev = pendingCollisionCounts.get(key) ?? 0;
            const count = prev + 1;
            nextCounts.set(key, count);

            if (count >= 2 && !alreadyDead.has(id)) {
              console.log(`[KILL:shallow_persist] victim=${snake.name}(${id}) killer=${other.name}(${otherId}) seg=${i} dist=${actualDist.toFixed(1)} killDist=${killDist.toFixed(1)} pen=${penetration.toFixed(1)} ticks=${count}`);
              kills.push({
                killer: otherId,
                victim: id,
                victimValue: snake.valueUsdc,
                victimName: snake.name,
                killerName: other.name,
                timestamp: now,
              });
              alreadyDead.add(id);
            }
          }
          break;
        }
      }
      if (alreadyDead.has(id)) break;
    }
  }

  // Head-to-head: bigger snake wins, same size = both die
  // Head-to-head is instant (no 2-tick requirement — it's obvious/mutual)
  const heads = Array.from(snakes.entries()).filter(
    ([id, s]) => s.alive && !alreadyDead.has(id) && now - s.spawnTime >= SPAWN_GRACE_MS
  );
  for (let i = 0; i < heads.length; i++) {
    for (let j = i + 1; j < heads.length; j++) {
      const [idA, a] = heads[i];
      const [idB, b] = heads[j];
      if (alreadyDead.has(idA) || alreadyDead.has(idB)) continue;

      const headCollDist = getBodyRadius(a.segments.length) + getBodyRadius(b.segments.length) - COLLISION_EPSILON;
      const dSq = distanceSq(a.headX, a.headY, b.headX, b.headY);
      if (dSq < headCollDist * headCollDist) {
        if (a.length > b.length * 1.1) {
          kills.push({ killer: idA, victim: idB, victimValue: b.valueUsdc, victimName: b.name, killerName: a.name, timestamp: now });
          alreadyDead.add(idB);
        } else if (b.length > a.length * 1.1) {
          kills.push({ killer: idB, victim: idA, victimValue: a.valueUsdc, victimName: a.name, killerName: b.name, timestamp: now });
          alreadyDead.add(idA);
        } else {
          kills.push({ killer: null, victim: idA, victimValue: a.valueUsdc, victimName: a.name, killerName: "", timestamp: now });
          kills.push({ killer: null, victim: idB, victimValue: b.valueUsdc, victimName: b.name, killerName: "", timestamp: now });
          alreadyDead.add(idA);
          alreadyDead.add(idB);
        }
      }
    }
  }

  // Carry persistence state to next tick
  pendingCollisionCounts = nextCounts;

  return kills;
}

/**
 * Check snake head vs arena boundary.
 */
export function checkBoundaryCollisions(
  snakes: Map<string, ServerSnake>,
  arenaRadius: number
): KillEvent[] {
  const kills: KillEvent[] = [];

  const now = Date.now();
  for (const [id, snake] of snakes) {
    if (!snake.alive) continue;
    if (now - snake.spawnTime < SPAWN_GRACE_MS) continue;

    const distFromCenter = Math.sqrt(
      snake.headX * snake.headX + snake.headY * snake.headY
    );

    if (distFromCenter + getBodyRadius(snake.segments.length) >= arenaRadius) {
      kills.push({
        killer: null,
        victim: id,
        victimValue: snake.valueUsdc,
        victimName: snake.name,
        killerName: "wall",
        timestamp: now,
      });
    }
  }

  return kills;
}

/**
 * Check snake heads vs food orbs.
 */
export function checkFoodCollisions(
  snakes: Map<string, ServerSnake>,
  foods: Map<string, ServerFood>
): FoodEatEvent[] {
  const eats: FoodEatEvent[] = [];
  const eaten = new Set<string>();

  // Build food grid
  foodGrid.clear();
  for (const [foodId, food] of foods) {
    foodGrid.insert(foodId, food.x, food.y);
  }

  const eatDist = GAME_CONFIG.HEAD_RADIUS * 2;
  const eatDistSq = eatDist * eatDist;

  for (const [snakeId, snake] of snakes) {
    if (!snake.alive) continue;

    const nearbyFoodIds = foodGrid.getNearby(snake.headX, snake.headY);

    for (const foodId of nearbyFoodIds) {
      if (eaten.has(foodId)) continue;
      const food = foods.get(foodId);
      if (!food) continue;

      const dSq = distanceSq(snake.headX, snake.headY, food.x, food.y);

      if (dSq < eatDistSq) {
        eats.push({ snakeId, foodId });
        eaten.add(foodId);
      }
    }
  }

  return eats;
}

/**
 * Containment check: if a snake's head is INSIDE a closed loop
 * formed by another snake's body, that snake dies.
 */
export function checkContainmentKills(
  snakes: Map<string, ServerSnake>
): KillEvent[] {
  const kills: KillEvent[] = [];
  const alreadyDead = new Set<string>();

  for (const [id, snake] of snakes) {
    if (!snake.alive || alreadyDead.has(id)) continue;

    for (const [otherId, other] of snakes) {
      if (otherId === id || !other.alive || alreadyDead.has(otherId)) continue;

      if (other.segments.length < 30) continue;

      if (isPointInsideSnakeLoop(snake.headX, snake.headY, other.segments)) {
        kills.push({
          killer: otherId,
          victim: id,
          victimValue: snake.valueUsdc,
          victimName: snake.name,
          killerName: other.name,
          timestamp: Date.now(),
        });
        alreadyDead.add(id);
        break;
      }
    }
  }

  return kills;
}
