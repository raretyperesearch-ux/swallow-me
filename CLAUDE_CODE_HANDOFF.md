# CLAUDE CODE HANDOFF: Swallow Me

## Context
Swallow Me is a real-time multiplayer snake game (slither.io clone) with USDC wagers on Solana. It's a standalone product under the BuyMoney brand. The full codebase has been scaffolded and is ready for installation, build, and deployment.

## What's Already Done
- Full monorepo scaffolded with `web/`, `server/`, `program/` directories
- Supabase project created: `xmmfcotkedbshdoqcnic` (tables already migrated: players, matches, leaderboard, lobbies, referrals, settlement_queue)
- Colyseus game server code written (server/src/)
- Anchor smart contract written (program/programs/swallow-me/src/)
- Next.js frontend with Phaser 3 game renderer (web/)
- Spec doc: swallow-me-spec.md

## Your Job
Execute the following in order. Do NOT rewrite or redesign anything — the architecture decisions are made. Just install, fix any build errors, and deploy.

---

## Step 1: Set Up the Repo

The zip file `swallow-me.zip` should already be unzipped into the GitHub repo directory. If not:

```bash
# Unzip into the repo
unzip swallow-me.zip -d <repo-path>
```

Make sure the monorepo structure is:
```
swallow-me/
├── web/          # Next.js frontend
├── server/       # Colyseus game server  
├── program/      # Anchor smart contract
├── package.json  # Workspace root
├── README.md
└── .gitignore
```

---

## Step 2: Build the Game Server

```bash
cd server
npm install
```

Fix any TypeScript errors. Key things to watch for:
- Colyseus v0.15 schema decorators need `experimentalDecorators` and `emitDecoratorMetadata` (already in tsconfig)
- The `@type` decorators in `rooms/SnakeState.ts` are Colyseus schema decorators
- `uuid` package is used for food/bot IDs
- The server entry is `src/index.ts`

Test it compiles:
```bash
npx tsc --noEmit
```

Then test it runs:
```bash
npm run dev
```

Should see the SWALLOW ME SERVER banner on port 2567. Hit `http://localhost:2567/health` to verify.

---

## Step 3: Build the Frontend

```bash
cd web
npm install
```

Create `.env.local`:
```
NEXT_PUBLIC_GAME_SERVER_URL=ws://localhost:2567
NEXT_PUBLIC_SUPABASE_URL=https://xmmfcotkedbshdoqcnic.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<get from supabase dashboard>
```

Key things to watch for:
- Phaser must be dynamically imported (no SSR) — `SnakeGame.tsx` uses `next/dynamic`
- The Phaser scene receives the Colyseus room via `init()` data
- `reactStrictMode: false` in next.config.js (Phaser breaks with strict mode)
- Tailwind is configured in `tailwind.config.js`

Test it:
```bash
npm run dev
```

Go to `http://localhost:3000` — should see landing page.
Go to `http://localhost:3000/play` — should see lobby selector.
Click a tier with the server running — should connect and spawn into the game.

**Open two browser tabs** to test multiplayer. Bots should also auto-spawn after a few seconds.

---

## Step 4: Fix Any Issues

Common things that might need fixing:
1. **Colyseus schema import paths** — make sure `@colyseus/schema` exports `ArraySchema`
2. **Phaser scene lifecycle** — the `init()` method receives room data, `create()` sets up listeners
3. **State sync** — `SnakeRoom.ts` has a `serverSnakes` map outside the class (module-level). This is intentional for server-side state but may need to be moved inside the class if multiple rooms are created (each room needs its own snake/food maps)
4. **The module-level maps in SnakeRoom.ts are a BUG** — they should be instance properties on the class. Fix this:

```typescript
// WRONG (current — shared across all rooms):
const serverSnakes = new Map<string, ServerSnake>();
const serverFoods = new Map<string, ServerFood>();

// RIGHT (fix to this — per-room):
export class SnakeRoom extends Room<SnakeRoomState> {
  private serverSnakes = new Map<string, ServerSnake>();
  private serverFoods = new Map<string, ServerFood>();
  // ... rest of class
}
```

Then update all references from `serverSnakes` to `this.serverSnakes` and `serverFoods` to `this.serverFoods` throughout the class methods.

---

## Step 5: Git Push

```bash
cd <repo-root>
git add .
git commit -m "feat: swallow me v0.1 - multiplayer snake with USDC wagers"
git push origin main
```

---

## Step 6: Deploy Server to Railway

Option A — Railway CLI:
```bash
cd server
railway login
railway init
railway up
```

Option B — Railway Dashboard:
1. New Project → Deploy from GitHub repo
2. Set root directory to `/server`
3. It will auto-detect the Dockerfile
4. Set environment variables:
   - `PORT=2567`
   - `CORS_ORIGIN=https://swallowme.gg` (or wherever frontend deploys)
   - `SOLANA_RPC_URL=https://api.devnet.solana.com` (devnet for now)
   - `SUPABASE_URL=https://xmmfcotkedbshdoqcnic.supabase.co`
   - `SUPABASE_SERVICE_KEY=<from supabase dashboard>`
5. Add custom domain if available
6. Make sure WebSocket support is enabled (Railway does this by default)

Verify: hit `https://<railway-url>/health`

---

## Step 7: Deploy Frontend to Vercel

```bash
cd web
vercel deploy --prod
```

Or connect the GitHub repo in Vercel dashboard:
1. Import repo
2. Set root directory to `/web`
3. Framework: Next.js (auto-detected)
4. Environment variables:
   - `NEXT_PUBLIC_GAME_SERVER_URL=wss://<railway-domain>` (note: wss not ws for production)
   - `NEXT_PUBLIC_SUPABASE_URL=https://xmmfcotkedbshdoqcnic.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY=<from supabase dashboard>`
5. Deploy

---

## Step 8: Anchor Program (Devnet First)

```bash
cd program
anchor build
anchor keys list
# Copy the generated program ID
# Update declare_id!() in lib.rs with the real program ID
# Update Anchor.toml [programs.devnet] with the real program ID
anchor build  # rebuild with correct ID
anchor deploy --provider.cluster devnet
```

The program ID placeholder is `SW4LLowMeXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` — replace it everywhere after `anchor keys list`.

---

## Important Architecture Notes

- **Server-authoritative**: ALL game logic runs on the Colyseus server. The client only sends input (mouse angle + boost boolean) and renders the state it receives. This is non-negotiable for real money.
- **Optimistic settlement**: When a kill happens, the game state updates immediately. The on-chain settlement happens async. The `TODO` comments in SnakeRoom.ts mark where on-chain calls need to be wired in Phase 2.
- **Bots are real players with fake wallets**: They use the same code path as humans. In production they'll have real USDC-funded wallets.
- **Treasury wallet**: `53Qy2ygocLjKWbtjgaepzHfZnf9oiZENJPWMnNUkSz8L` (shared with BuyMoney, can change)
- **Supabase project**: `xmmfcotkedbshdoqcnic` — tables already exist, don't re-migrate

## Known TODOs in Code (marked with `// TODO:`)
1. `SnakeRoom.ts` → `onJoin`: Verify USDC deposit on-chain before spawning
2. `SnakeRoom.ts` → `handleKill`: Call `settle_kill` on-chain
3. `SnakeRoom.ts` → `handleCashout`: Call `cashout` on-chain  
4. `SnakeRoom.ts` → `onLeave`: Call `forfeit` on-chain
5. `play/page.tsx` → `handleJoin`: Wire in Privy wallet connect + USDC escrow tx

These are Phase 2 tasks. Phase 1 works without real money.

## SDK/API Docs — ALWAYS FETCH BEFORE CODING
- Colyseus: https://docs.colyseus.io/
- Phaser 3: https://newdocs.phaser.io/docs/3.80.0
- Anchor: https://www.anchor-lang.com/docs
- Privy: https://docs.privy.io/
- Supabase JS: https://supabase.com/docs/reference/javascript/introduction
