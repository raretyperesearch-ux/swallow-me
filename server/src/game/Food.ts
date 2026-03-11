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
 * Spawn death food distributed evenly along a snake's body segments.
 * Traces the ghost shape of the dead snake in food orbs.
 */
export function spawnDeathFoodAlongBody(
  segments: { x: number; y: number }[],
  count: number
): ServerFood[] {
  const foods: ServerFood[] = [];

  if (segments.length === 0) return foods;

  // Distribute orbs evenly along the body
  const step = Math.max(1, Math.floor(segments.length / count));

  for (let i = 0; i < segments.length && foods.length < count; i += step) {
    const seg = segments[i];
    foods.push(
      createFood(
        seg.x + (Math.random() - 0.5) * 10, // tiny random offset
        seg.y + (Math.random() - 0.5) * 10,
        2 // death food size
      )
    );
  }

  return foods;
}

// Keep old name as alias for backwards compat
export const spawnDeathFood = spawnDeathFoodAlongBody;
