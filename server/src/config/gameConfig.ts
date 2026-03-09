// Game tuning parameters — tweak these to balance gameplay

export const GAME_CONFIG = {
  // Tick rate
  TICK_RATE: 30, // Server physics updates per second (down from 60 — client interpolates)
  CLIENT_SEND_RATE: 15, // State sync pushes per second

  // Arena
  ARENA_RADIUS: 5000, // Circular map radius in game units (bigger for 100 players)
  BOUNDARY_KILL: true, // Die when hitting the wall

  // Snake movement (adjusted for 30Hz tick — same effective speed)
  BASE_SPEED: 9.0, // Normal movement speed (units per tick) — doubled for 30Hz
  BOOST_SPEED: 18.0, // Speed while boosting — doubled for 30Hz
  TURN_RATE: 0.08, // Max radians per tick — doubled for 30Hz
  BOOST_LENGTH_COST: 0.6, // Length units lost per tick while boosting — doubled for 30Hz
  MIN_BOOST_LENGTH: 15, // Can't boost below this length

  // Snake sizing
  INITIAL_LENGTH: 50, // Starting snake length (segments)
  MAX_LENGTH: 500, // Cap to prevent perf issues
  SEGMENT_SPACING: 4, // Distance between body segments
  HEAD_RADIUS: 14, // Collision radius of the head
  BODY_RADIUS: 12, // Collision radius of body segments

  // Food
  INITIAL_FOOD_COUNT: 1000, // Food orbs at game start (more for bigger map)
  MAX_FOOD: 2000, // Cap on total food
  FOOD_VALUE: 1.0, // Length gained per food eaten
  DEATH_FOOD_COUNT: 25, // Food orbs dropped on death
  FOOD_SPAWN_RATE: 5, // New food per tick when below minimum

  // Lobby
  MIN_PLAYERS_TO_START: 3, // Real + bots needed
  BOT_FILL_TARGET: 8, // Fill lobby to this many total with bots
  MAX_PLAYERS: {
    1: 100, // $1 tier
    5: 50, // $5 tier
    20: 25, // $20 tier
  } as Record<number, number>,

  // Interest management
  VIEWPORT_MARGIN: 500, // Extra units beyond viewport to include in sync
};

export const TIER_CONFIG = {
  1: {
    entryAmount: 1_000_000, // 1 USDC (6 decimals)
    rakeBps: 800, // 8%
    maxPlayers: 100,
  },
  5: {
    entryAmount: 5_000_000, // 5 USDC
    rakeBps: 800,
    maxPlayers: 50,
  },
  20: {
    entryAmount: 20_000_000, // 20 USDC
    rakeBps: 800,
    maxPlayers: 25,
  },
} as Record<number, { entryAmount: number; rakeBps: number; maxPlayers: number }>;

export const SOLANA_CONFIG = {
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  TREASURY: process.env.TREASURY_PUBKEY || "53Qy2ygocLjKWbtjgaepzHfZnf9oiZENJPWMnNUkSz8L",
  PROGRAM_ID: process.env.PROGRAM_ID || "",
  RPC_URL: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
};
