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

export function spawnDeathFood(
  x: number,
  y: number,
  count: number
): ServerFood[] {
  const foods: ServerFood[] = [];
  for (let i = 0; i < count; i++) {
    const spreadAngle = Math.random() * Math.PI * 2;
    const spreadDist = Math.random() * 80 + 20;
    foods.push(
      createFood(
        x + Math.cos(spreadAngle) * spreadDist,
        y + Math.sin(spreadAngle) * spreadDist,
        2 // Larger death food
      )
    );
  }
  return foods;
}
