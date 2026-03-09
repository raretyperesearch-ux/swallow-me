import { GAME_CONFIG } from "../config/gameConfig";
import { ServerSnake, updateSnake, growSnake } from "./Snake";
import { ServerFood, spawnRandomFood, spawnDeathFood } from "./Food";
import {
  checkSnakeCollisions,
  checkBoundaryCollisions,
  checkFoodCollisions,
  KillEvent,
  FoodEatEvent,
} from "./Physics";
import { updateBotInput } from "./BotAI";

export interface GameLoopCallbacks {
  onKill: (event: KillEvent) => void;
  onBoostFoodDrop: (x: number, y: number) => void;
  onFoodEaten: (foodIds: string[]) => void;
}

let _debugTickCounter = 0;

export function runGameTick(
  snakes: Map<string, ServerSnake>,
  foods: Map<string, ServerFood>,
  arenaRadius: number,
  callbacks: GameLoopCallbacks
): void {
  _debugTickCounter++;

  // Debug: log segment counts every ~5 seconds (150 ticks at 30Hz)
  if (_debugTickCounter % 150 === 0) {
    for (const [id, snake] of snakes) {
      if (!snake.alive) continue;
      console.log(`[DEBUG] Snake ${id.slice(0, 12)}: ${snake.segments.length} segments, head at (${Math.floor(snake.headX)}, ${Math.floor(snake.headY)}), length=${Math.floor(snake.length)}`);
    }
    console.log(`[DEBUG] Food count: ${foods.size}`);
  }

  // 1. Update bot inputs
  for (const [, snake] of snakes) {
    if (!snake.alive || !snake.isBot) continue;
    const input = updateBotInput(snake, snakes, foods, arenaRadius);
    snake.targetAngle = input.angle;
    snake.boosting = input.boost;
  }

  // 2. Move all snakes
  for (const [, snake] of snakes) {
    if (!snake.alive) continue;

    const wasBoosting = snake.boosting;
    const prevLength = snake.length;
    updateSnake(snake);

    // If boosting caused length loss, drop food behind tail
    if (wasBoosting && snake.length < prevLength) {
      const tail = snake.segments[snake.segments.length - 1];
      if (tail) {
        callbacks.onBoostFoodDrop(tail.x, tail.y);
      }
    }
  }

  // 3. Check collisions (uses spatial grid internally)
  const snakeKills = checkSnakeCollisions(snakes);
  const boundaryKills = checkBoundaryCollisions(snakes, arenaRadius);
  const allKills = [...snakeKills, ...boundaryKills];

  // 4. Process kills
  for (const kill of allKills) {
    const victim = snakes.get(kill.victim);
    if (victim && victim.alive) {
      victim.alive = false;

      // Drop death food at victim location
      const deathFoods = spawnDeathFood(
        victim.headX,
        victim.headY,
        GAME_CONFIG.DEATH_FOOD_COUNT
      );
      for (const f of deathFoods) {
        foods.set(f.id, f);
      }

      // If there's a killer (not wall), credit the kill
      if (kill.killer) {
        const killer = snakes.get(kill.killer);
        if (killer && killer.alive) {
          killer.kills++;
        }
      }

      callbacks.onKill(kill);
    }
  }

  // 5. Check food consumption (uses spatial grid internally)
  const foodEats = checkFoodCollisions(snakes, foods);
  const eatenFoodIds: string[] = [];
  for (const eat of foodEats) {
    const snake = snakes.get(eat.snakeId);
    const food = foods.get(eat.foodId);
    if (snake && food) {
      const growAmount = food.size === 2
        ? GAME_CONFIG.FOOD_VALUE * 3
        : GAME_CONFIG.FOOD_VALUE;
      growSnake(snake, growAmount);
      foods.delete(eat.foodId);
      eatenFoodIds.push(eat.foodId);
      console.log(`[EAT] ${snake.name} ate food, length now ${Math.floor(snake.length)}`);
    }
  }

  // Notify clients of eaten food IDs for immediate removal
  if (eatenFoodIds.length > 0) {
    callbacks.onFoodEaten(eatenFoodIds);
  }

  // 6. Natural food spawning (maintain minimum)
  if (foods.size < GAME_CONFIG.INITIAL_FOOD_COUNT) {
    const toSpawn = Math.min(
      GAME_CONFIG.FOOD_SPAWN_RATE,
      GAME_CONFIG.MAX_FOOD - foods.size
    );
    for (let i = 0; i < toSpawn; i++) {
      const f = spawnRandomFood(arenaRadius);
      foods.set(f.id, f);
    }
  }
}
