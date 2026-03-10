import { ServerSnake } from "./Snake";
import { ServerFood } from "./Food";
import { GAME_CONFIG } from "../config/gameConfig";

export enum BotPersonality {
  AGGRESSIVE = "aggressive",
  PASSIVE = "passive",
  HUNTER = "hunter",
  RANDOM = "random",
  COWARD = "coward",
}

const BOT_NAMES = [
  "snek_lord", "noodle_ninja", "hiss_fit", "slithery_pete",
  "venom_vince", "coil_master", "fang_frank", "scale_queen",
  "python_pat", "cobra_kai", "mamba_mike", "boa_boss",
  "asp_assassin", "rattler_rex", "viper_vic", "anaconda_ann",
  "king_cobra", "sidewinder_sam", "copperhead_carl", "garter_gary",
];

export function getRandomBotName(): string {
  return BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
}

export function getRandomPersonality(): BotPersonality {
  const types = Object.values(BotPersonality);
  return types[Math.floor(Math.random() * types.length)];
}

interface BotState {
  personality: BotPersonality;
  targetX: number;
  targetY: number;
  decisionTimer: number;
  panicTimer: number;
}

const botStates = new Map<string, BotState>();

export function initBotState(id: string): void {
  botStates.set(id, {
    personality: getRandomPersonality(),
    targetX: 0,
    targetY: 0,
    decisionTimer: 0,
    panicTimer: 0,
  });
}

export function removeBotState(id: string): void {
  botStates.delete(id);
}

export function updateBotInput(
  bot: ServerSnake,
  allSnakes: Map<string, ServerSnake>,
  allFood: Map<string, ServerFood>,
  arenaRadius: number
): { angle: number; boost: boolean } {
  let state = botStates.get(bot.id);
  if (!state) {
    initBotState(bot.id);
    state = botStates.get(bot.id)!;
  }

  state.decisionTimer--;
  let boost = false;

  // Check if near boundary — panic turn inward
  const distFromCenter = Math.sqrt(bot.headX * bot.headX + bot.headY * bot.headY);
  if (distFromCenter > arenaRadius * 0.85) {
    // Turn toward center
    const angleToCenter = Math.atan2(-bot.headY, -bot.headX);
    return { angle: angleToCenter, boost: false };
  }

  // Check for nearby danger (other snake heads coming at us)
  const dangerDist = 150;
  for (const [id, other] of allSnakes) {
    if (id === bot.id || !other.alive) continue;
    const dx = other.headX - bot.headX;
    const dy = other.headY - bot.headY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < dangerDist && other.length > bot.length * 0.8) {
      // Flee! Turn perpendicular to the threat
      const threatAngle = Math.atan2(dy, dx);
      const fleeAngle = threatAngle + Math.PI + (Math.random() - 0.5);
      return { angle: fleeAngle, boost: dist < 80 };
    }
  }

  // Make decisions based on personality
  if (state.decisionTimer <= 0) {
    state.decisionTimer = 30 + Math.floor(Math.random() * 60); // Re-decide every 0.5-1.5s

    switch (state.personality) {
      case BotPersonality.AGGRESSIVE:
        // Target nearest smaller snake
        let nearestPrey: ServerSnake | null = null;
        let nearestPreyDist = Infinity;
        for (const [id, other] of allSnakes) {
          if (id === bot.id || !other.alive || other.length >= bot.length) continue;
          const dx = other.headX - bot.headX;
          const dy = other.headY - bot.headY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < nearestPreyDist && dist < 500) {
            nearestPreyDist = dist;
            nearestPrey = other;
          }
        }
        if (nearestPrey) {
          state.targetX = nearestPrey.headX;
          state.targetY = nearestPrey.headY;
          boost = nearestPreyDist < 300;
        } else {
          // Wander toward food
          setFoodTarget(state, bot, allFood);
        }
        break;

      case BotPersonality.PASSIVE:
        // Always go for nearest food
        setFoodTarget(state, bot, allFood);
        break;

      case BotPersonality.HUNTER:
        // Cut off targets by predicting where they're heading
        let target: ServerSnake | null = null;
        let targetDist = Infinity;
        for (const [id, other] of allSnakes) {
          if (id === bot.id || !other.alive) continue;
          const dx = other.headX - bot.headX;
          const dy = other.headY - bot.headY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < targetDist && dist < 600) {
            targetDist = dist;
            target = other;
          }
        }
        if (target && targetDist < 400) {
          // Predict where target is heading (lead the target)
          const leadDist = Math.min(200, targetDist * 0.6);
          const predictX = target.headX + Math.cos(target.angle) * leadDist;
          const predictY = target.headY + Math.sin(target.angle) * leadDist;
          state.targetX = predictX;
          state.targetY = predictY;
          boost = targetDist < 250 && bot.length > 20;
        } else {
          setFoodTarget(state, bot, allFood);
        }
        break;

      case BotPersonality.RANDOM:
        // Random wandering with occasional food seeking
        if (Math.random() < 0.4) {
          setFoodTarget(state, bot, allFood);
        } else {
          const wanderAngle = bot.angle + (Math.random() - 0.5) * 1.5;
          state.targetX = bot.headX + Math.cos(wanderAngle) * 300;
          state.targetY = bot.headY + Math.sin(wanderAngle) * 300;
        }
        break;

      case BotPersonality.COWARD:
        // Avoid all other snakes, hug edges for food, flee aggressively
        let nearestThreat: ServerSnake | null = null;
        let nearestThreatDist = Infinity;
        for (const [id, other] of allSnakes) {
          if (id === bot.id || !other.alive) continue;
          const dx = other.headX - bot.headX;
          const dy = other.headY - bot.headY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < nearestThreatDist && dist < 400) {
            nearestThreatDist = dist;
            nearestThreat = other;
          }
        }
        if (nearestThreat && nearestThreatDist < 300) {
          // Flee away from threat
          const fleeAngle = Math.atan2(
            bot.headY - nearestThreat.headY,
            bot.headX - nearestThreat.headX
          );
          state.targetX = bot.headX + Math.cos(fleeAngle) * 400;
          state.targetY = bot.headY + Math.sin(fleeAngle) * 400;
          boost = nearestThreatDist < 150;
        } else {
          // Safe — collect food in less contested areas (toward edge)
          setFoodTarget(state, bot, allFood);
        }
        break;
    }
  }

  const angle = Math.atan2(state.targetY - bot.headY, state.targetX - bot.headX);

  // Add slight randomness to feel human
  const jitter = (Math.random() - 0.5) * 0.1;

  return { angle: angle + jitter, boost };
}

function setFoodTarget(
  state: BotState,
  bot: ServerSnake,
  allFood: Map<string, ServerFood>
): void {
  let nearestFood: ServerFood | null = null;
  let nearestDist = Infinity;

  for (const [, food] of allFood) {
    const dx = food.x - bot.headX;
    const dy = food.y - bot.headY;
    const dist = dx * dx + dy * dy;
    // Prefer death food (size 2) over normal
    const adjusted = food.size === 2 ? dist * 0.5 : dist;
    if (adjusted < nearestDist) {
      nearestDist = adjusted;
      nearestFood = food;
    }
  }

  if (nearestFood) {
    state.targetX = nearestFood.x;
    state.targetY = nearestFood.y;
  } else {
    // Random wander
    const wanderAngle = Math.random() * Math.PI * 2;
    state.targetX = bot.headX + Math.cos(wanderAngle) * 200;
    state.targetY = bot.headY + Math.sin(wanderAngle) * 200;
  }
}
