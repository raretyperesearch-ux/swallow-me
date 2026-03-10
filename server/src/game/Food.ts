import { v4 as uuidv4 } from "uuid";
import { GAME_CONFIG } from "../config/gameConfig";

export interface ServerFood {
  id: string;
  x: number;
  y: number;
  size: number; // 1=normal, 2=death-drop
}

export function createFood(x: number, y: number, size: number = 1): ServerFood {
  return { id: uuidv4(), x, y, size };
}

export function spawnRandomFood(arenaRadius: number): ServerFood {
  // Random position within arena circle
  const angle = Math.random() * Math.PI * 2;
  const distance = Math.random() * (arenaRadius * 0.9); // Keep 10% margin from wall
  return createFood(
    Math.cos(angle) * distance,
    Math.sin(angle) * distance,
    1
  );
}

/**
 * Spawn death food distributed along a snake's body segments.
 * Each orb spawns at a segment position + small random offset,
 * tracing the ghost of the dead snake's shape.
 */
export function spawnDeathFood(
  segments: { x: number; y: number }[],
  maxCount: number
): ServerFood[] {
  const foods: ServerFood[] = [];
  // Cap at 40 for very long snakes to avoid flooding
  const count = Math.min(maxCount, 40);
  const stride = Math.max(1, Math.floor(segments.length / count));

  for (let i = 0; i < segments.length && foods.length < count; i += stride) {
    const seg = segments[i];
    const offsetX = (Math.random() - 0.5) * 20; // ±10 units
    const offsetY = (Math.random() - 0.5) * 20;
    foods.push(
      createFood(seg.x + offsetX, seg.y + offsetY, 2)
    );
  }
  return foods;
}
