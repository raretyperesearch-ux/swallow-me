# 🐍 Swallow Me

> Real-money snake PvP on Solana. A BuyMoney game.

Stake USDC → Eat other snakes → Cash out your winnings.

## Architecture

```
swallow-me/
├── web/        → Next.js frontend (Phaser + Privy + Tailwind)
├── server/     → Colyseus game server (Node.js/TypeScript)
└── program/    → Anchor smart contract (Rust/Solana)
```

## Quick Start (Phase 1 — No Money, Just Gameplay)

### 1. Start the game server

```bash
cd server
cp .env.example .env
npm install
npm run dev
```

Server runs at `ws://localhost:2567`. Monitor at `http://localhost:2567/monitor`.

### 2. Start the frontend

```bash
cd web
cp .env.example .env.local
npm install
npm run dev
```

Frontend runs at `http://localhost:3000`.

### 3. Play

1. Go to `http://localhost:3000/play`
2. Pick a tier (no real money in Phase 1)
3. Click Play
4. Open a second browser tab to play against yourself
5. Bots will auto-spawn to fill the lobby

## Stack

| Layer | Tech |
|-------|------|
| Game renderer | Phaser 3 |
| Multiplayer | Colyseus (server-authoritative) |
| Frontend | Next.js + Tailwind |
| Wallet | Privy (coming Phase 2) |
| Smart contract | Anchor/Rust on Solana |
| Database | Supabase |
| Game server hosting | Railway |
| Frontend hosting | Vercel |

## Supabase

Project: `xmmfcotkedbshdoqcnic`
URL: `https://xmmfcotkedbshdoqcnic.supabase.co`

Tables: `players`, `matches`, `leaderboard`, `lobbies`, `referrals`, `settlement_queue`

## Env Vars

### Server (`server/.env`)
- `PORT` — Game server port (default 2567)
- `CORS_ORIGIN` — Frontend URL
- `SOLANA_RPC_URL` — Solana RPC
- `CRANKER_KEYPAIR` — Base58 encoded keypair for settlement txns
- `TREASURY_PUBKEY` — Rake destination
- `PROGRAM_ID` — Swallow Me program ID
- `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`

### Web (`web/.env.local`)
- `NEXT_PUBLIC_GAME_SERVER_URL` — WebSocket URL to Colyseus
- `NEXT_PUBLIC_PRIVY_APP_ID`
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## Build Phases

See `swallow-me-spec.md` for full spec.

- [x] Phase 1: Multiplayer snake (no money)
- [ ] Phase 2: Anchor contract + USDC escrow
- [ ] Phase 3: Visual polish + mobile
- [ ] Phase 4: Bots + lobby management
- [ ] Phase 5: Deploy mainnet
- [ ] Phase 6: Growth (share to X, KOL lobbies, TikTok)
