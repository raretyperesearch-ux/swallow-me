import { GAME_CONFIG } from "../config/gameConfig";

export interface SnakeSegmentData {
  x: number;
  y: number;
}

export interface ServerSnake {
  id: string;
  name: string;
  wallet: string;
  headX: number;
  headY: number;
  prevHeadX: number;
  prevHeadY: number;
  angle: number;
  targetAngle: number;
  speed: number;
  boosting: boolean;
  length: number;
  segments: SnakeSegmentData[];
  alive: boolean;
  isBot: boolean;
  valueUsdc: number; // USDC lamports
  kills: number;
  skinId: number;
  lastInputTime: number;
  spawnTime: number;
  _boostDropCounter?: number;
  sessionId?: string;   // sm_sessions.id from /api/game/enter
  playerId?: string;    // bm_players.id from /api/game/enter
  isSettling?: boolean;  // lock during settlement
}

export function createSnake(
  id: string,
  name: string,
  wallet: string,
  spawnX: number,
  spawnY: number,
  valueUsdc: number,
  isBot: boolean = false,
  skinId: number = 0
): ServerSnake {
  const angle = Math.random() * Math.PI * 2;
  const segments: SnakeSegmentData[] = [];

  // Create initial body segments behind the head
  for (let i = 0; i < GAME_CONFIG.INITIAL_LENGTH; i++) {
    segments.push({
      x: spawnX - Math.cos(angle) * i * GAME_CONFIG.SEGMENT_SPACING,
      y: spawnY - Math.sin(angle) * i * GAME_CONFIG.SEGMENT_SPACING,
    });
  }

  return {
    id,
    name,
    wallet,
    headX: spawnX,
    headY: spawnY,
    prevHeadX: spawnX,
    prevHeadY: spawnY,
    angle,
    targetAngle: angle,
    speed: GAME_CONFIG.BASE_SPEED,
    boosting: false,
    length: GAME_CONFIG.INITIAL_LENGTH,
    segments,
    alive: true,
    isBot,
    valueUsdc,
    kills: 0,
    skinId,
    lastInputTime: Date.now(),
    spawnTime: Date.now(),
  };
}

export function updateSnake(snake: ServerSnake): void {
  if (!snake.alive) return;

  // Smooth turning toward target angle
  let angleDiff = snake.targetAngle - snake.angle;
  while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
  while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

  // Minimum turn radius scales with size — bigger snakes turn wider
  const minRadius = GAME_CONFIG.MIN_TURN_RADIUS + snake.length * GAME_CONFIG.TURN_RADIUS_SCALE;
  const currentSpeed = snake.boosting ? GAME_CONFIG.BOOST_SPEED : GAME_CONFIG.BASE_SPEED;
  const maxTurnRate = currentSpeed / minRadius;
  const effectiveTurnRate = Math.min(GAME_CONFIG.TURN_RATE, maxTurnRate);

  if (Math.abs(angleDiff) > effectiveTurnRate) {
    snake.angle += Math.sign(angleDiff) * effectiveTurnRate;
  } else {
    snake.angle = snake.targetAngle;
  }

  // Set speed based on boost
  if (snake.boosting && snake.length > GAME_CONFIG.MIN_BOOST_LENGTH) {
    snake.speed = GAME_CONFIG.BOOST_SPEED;
    snake.length = Math.max(
      GAME_CONFIG.MIN_BOOST_LENGTH,
      snake.length - GAME_CONFIG.BOOST_LENGTH_COST
    );
  } else {
    snake.speed = GAME_CONFIG.BASE_SPEED;
    snake.boosting = false;
  }

  // Save previous position for swept collision detection
  snake.prevHeadX = snake.headX;
  snake.prevHeadY = snake.headY;

  // Move head
  snake.headX += Math.cos(snake.angle) * snake.speed;
  snake.headY += Math.sin(snake.angle) * snake.speed;

  // Update segment 0 to head position
  if (snake.segments.length > 0) {
    snake.segments[0].x = snake.headX;
    snake.segments[0].y = snake.headY;
  }

  // CHAIN CONSTRAINT — enforce consistent spacing between ALL segments
  // Without this, segments are 8-16 units apart depending on speed,
  // creating invisible gaps that heads pass through
  const spacing = GAME_CONFIG.SEGMENT_SPACING;
  for (let i = 1; i < snake.segments.length; i++) {
    const prev = snake.segments[i - 1];
    const curr = snake.segments[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > spacing) {
      const angle = Math.atan2(dy, dx);
      curr.x = prev.x + Math.cos(angle) * spacing;
      curr.y = prev.y + Math.sin(angle) * spacing;
    }
  }

  // Grow/shrink segments to match target length
  const targetSegments = Math.floor(snake.length);

  while (snake.segments.length < targetSegments) {
    const last = snake.segments[snake.segments.length - 1];
    snake.segments.push({ x: last.x, y: last.y });
  }

  while (snake.segments.length > targetSegments && snake.segments.length > 2) {
    snake.segments.pop();
  }
}

export function growSnake(snake: ServerSnake, amount: number): void {
  snake.length = Math.min(snake.length + amount, GAME_CONFIG.MAX_LENGTH);
}
