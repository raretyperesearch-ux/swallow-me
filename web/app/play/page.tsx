"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import * as Colyseus from "colyseus.js";
import { joinRoom } from "../../lib/colyseus/client";

// Dynamic import SnakeGame (no SSR — Phaser needs browser)
const SnakeGame = dynamic(() => import("../../components/SnakeGame"), {
  ssr: false,
});

type GamePhase = "lobby" | "playing" | "dead" | "cashout";

export default function PlayPage() {
  const [phase, setPhase] = useState<GamePhase>("lobby");
  const [room, setRoom] = useState<Colyseus.Room | null>(null);
  const [selectedTier, setSelectedTier] = useState<number>(1);
  const [deathData, setDeathData] = useState<any>(null);
  const [cashoutData, setCashoutData] = useState<any>(null);
  const [connecting, setConnecting] = useState(false);

  const handleJoin = async () => {
    setConnecting(true);
    try {
      // TODO: Wire in Privy wallet connect + USDC escrow
      // For Phase 1, just connect to Colyseus with a fake wallet
      const wallet = "test_" + Math.random().toString(36).slice(2, 8);
      const name = "player_" + Math.random().toString(36).slice(2, 6);

      const r = await joinRoom(selectedTier, wallet, name);
      setRoom(r);
      setPhase("playing");
    } catch (err) {
      console.error("Failed to join:", err);
      alert("Failed to connect to game server. Is it running?");
    } finally {
      setConnecting(false);
    }
  };

  const handleDeath = (data: any) => {
    setDeathData(data);
    setPhase("dead");
  };

  const handleCashout = (data: any) => {
    setCashoutData(data);
    setPhase("cashout");
  };

  const handlePlayAgain = () => {
    room?.leave();
    setRoom(null);
    setDeathData(null);
    setCashoutData(null);
    setPhase("lobby");
  };

  // ─── Lobby Phase ────────────────────────────────────
  if (phase === "lobby") {
    return (
      <div className="min-h-screen bg-[#0a0a1a] flex flex-col items-center justify-center text-white">
        <h1 className="text-5xl font-black mb-2">SWALLOW ME</h1>
        <p className="text-gray-400 mb-10">Stake USDC. Eat snakes. Cash out.</p>

        <div className="flex gap-4 mb-8">
          {[1, 5, 20].map((tier) => (
            <button
              key={tier}
              onClick={() => setSelectedTier(tier)}
              className={`w-32 h-32 rounded-xl border-2 flex flex-col items-center justify-center transition-all ${
                selectedTier === tier
                  ? "border-green-400 bg-green-400/10 scale-105"
                  : "border-gray-700 bg-gray-800/50 hover:border-gray-500"
              }`}
            >
              <span className="text-3xl font-bold">${tier}</span>
              <span className="text-xs text-gray-400 mt-1">USDC</span>
            </button>
          ))}
        </div>

        <button
          onClick={handleJoin}
          disabled={connecting}
          className="bg-green-500 hover:bg-green-400 disabled:bg-gray-600 text-black font-bold text-xl px-12 py-4 rounded-xl transition-colors"
        >
          {connecting ? "Connecting..." : `Play $${selectedTier}`}
        </button>

        <p className="text-gray-600 text-sm mt-4">
          A <a href="https://ibuy.money" className="text-gray-400 hover:text-white">BuyMoney</a> game
        </p>
      </div>
    );
  }

  // ─── Playing Phase ──────────────────────────────────
  if (phase === "playing" && room) {
    return (
      <SnakeGame
        room={room}
        onDeath={handleDeath}
        onCashout={handleCashout}
      />
    );
  }

  // ─── Death Screen ───────────────────────────────────
  if (phase === "dead") {
    return (
      <div className="min-h-screen bg-[#0a0a1a] flex flex-col items-center justify-center text-white">
        <h2 className="text-4xl font-black text-red-400 mb-4">SWALLOWED</h2>
        <p className="text-gray-400 mb-6">
          Killed by <span className="text-white font-bold">{deathData?.killerName || "Unknown"}</span>
        </p>

        <div className="flex gap-6 mb-8">
          <div className="text-center">
            <div className="text-2xl font-bold">{deathData?.kills || 0}</div>
            <div className="text-xs text-gray-400">Kills</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold">
              {Math.floor((deathData?.duration || 0) / 1000)}s
            </div>
            <div className="text-xs text-gray-400">Survived</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-red-400">
              -${((deathData?.valueUsdc || 0) / 1_000_000).toFixed(2)}
            </div>
            <div className="text-xs text-gray-400">Lost</div>
          </div>
        </div>

        <div className="flex gap-4">
          <button
            onClick={handlePlayAgain}
            className="bg-green-500 hover:bg-green-400 text-black font-bold px-8 py-3 rounded-lg"
          >
            Play Again
          </button>
          <button
            onClick={() => {
              // TODO: Share to X
              const text = `I just got swallowed on SwallowMe.gg! ${deathData?.kills || 0} kills before going down.`;
              window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}`);
            }}
            className="bg-gray-700 hover:bg-gray-600 text-white font-bold px-8 py-3 rounded-lg"
          >
            Share to X
          </button>
        </div>
      </div>
    );
  }

  // ─── Cashout Screen ─────────────────────────────────
  if (phase === "cashout") {
    return (
      <div className="min-h-screen bg-[#0a0a1a] flex flex-col items-center justify-center text-white">
        <h2 className="text-4xl font-black text-green-400 mb-4">CASHED OUT</h2>

        <div className="flex gap-6 mb-8">
          <div className="text-center">
            <div className="text-3xl font-bold text-green-400">
              ${((cashoutData?.amount || 0) / 1_000_000).toFixed(2)}
            </div>
            <div className="text-xs text-gray-400">Withdrawn</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold">{cashoutData?.kills || 0}</div>
            <div className="text-xs text-gray-400">Kills</div>
          </div>
        </div>

        <div className="flex gap-4">
          <button
            onClick={handlePlayAgain}
            className="bg-green-500 hover:bg-green-400 text-black font-bold px-8 py-3 rounded-lg"
          >
            Play Again
          </button>
          <button
            onClick={() => {
              const text = `Just cashed out $${((cashoutData?.amount || 0) / 1_000_000).toFixed(2)} on SwallowMe.gg! 🐍💰`;
              window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}`);
            }}
            className="bg-gray-700 hover:bg-gray-600 text-white font-bold px-8 py-3 rounded-lg"
          >
            Brag on X
          </button>
        </div>
      </div>
    );
  }

  return null;
}
