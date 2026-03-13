"use client";

import { useEffect, useRef, useState, useCallback, ReactNode } from "react";
import * as Colyseus from "colyseus.js";
import { useVoiceChat } from "../lib/voice/useVoiceChat";

interface SnakeGameProps {
  room: Colyseus.Room;
  onDeath: (data: any) => void;
  onCashout: (data: any) => void;
  overlay?: ReactNode;
  voiceEnabled?: boolean;
  spectating?: boolean;
  onSpectateUpdate?: (data: { name: string; value: number }) => void;
}

function isMobileDevice(): boolean {
  return (
    navigator.maxTouchPoints > 0 ||
    "ontouchstart" in window ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  );
}

export default function SnakeGame({ room, onDeath, onCashout, overlay, voiceEnabled = true, spectating = false, onSpectateUpdate }: SnakeGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<any>(null);
  const [stats, setStats] = useState({ kills: 0, value: 0, alive: 0, length: 50, muted: false });
  const [mobile, setMobile] = useState(false);
  const [localSnakes, setLocalSnakes] = useState<Map<string, any> | null>(null);

  const voice = useVoiceChat(room, localSnakes, room.sessionId);

  useEffect(() => {
    setMobile(isMobileDevice());
  }, []);

  // Sync voice enabled state from prop
  useEffect(() => {
    voice.setVoiceEnabled(voiceEnabled);
  }, [voiceEnabled]);

  const handleToggleMute = useCallback(() => {
    if (rendererRef.current) {
      rendererRef.current.toggleMute();
      setStats((s: any) => ({ ...s, muted: rendererRef.current?.isMuted() ?? false }));
    }
  }, []);

  const handleToggleVoiceMute = useCallback(() => {
    voice.toggleSelfMute();
  }, [voice]);

  useEffect(() => {
    if (!containerRef.current || rendererRef.current) return;

    import("../lib/canvas/GameRenderer").then(({ GameRenderer }) => {
      const renderer = new GameRenderer(containerRef.current!, room);
      renderer.onDeath = onDeath;
      renderer.onCashout = onCashout;
      renderer.onStatsUpdate = setStats;
      rendererRef.current = renderer;

      // Set spectator mode if applicable
      if (spectating) {
        renderer.setSpectating(true);
        renderer.onSpectateTargetChange = (data) => {
          onSpectateUpdate?.(data);
        };
      }

      // Wire voice mute click handler
      renderer.setVoiceMuteClickHandler((sessionId: string) => {
        const peer = voice.peers.get(sessionId);
        if (peer?.isMutedByMe) {
          voice.unmutePeer(sessionId);
        } else {
          voice.mutePeer(sessionId);
        }
      });

      // Listen for cashout errors — dispatch toast event so page.tsx can show it
      room.onMessage("cashout_error", (data: any) => {
        console.error("[CASHOUT ERROR]", data);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("game-toast", {
            detail: { message: data.message || "Cashout failed. Try again.", type: "error" },
          }));
        }
      });
    });

    return () => {
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, [room]);

  // Update renderer with voice state and sync localSnakes every 500ms
  useEffect(() => {
    const interval = setInterval(() => {
      if (rendererRef.current) {
        rendererRef.current.updateVoiceState(voice.peers, voice.selfMuted);
        setLocalSnakes(rendererRef.current.getLocalSnakes());
      }
    }, 250);
    return () => clearInterval(interval);
  }, [voice.peers, voice.selfMuted]);

  const handleCashout = () => {
    room.send("cashout");
  };

  return (
    <div className="relative w-full h-screen overflow-hidden">
      {/* Game canvas */}
      <div ref={containerRef} className="w-full h-full" />

      {/* Death/cashout overlay rendered on top of live canvas */}
      {overlay}

      {/* HUD Overlay — single row, no overflow (hidden when overlay is showing) */}
      {!overlay && (
        <div
          className="absolute top-0 left-0 right-0 flex items-start pointer-events-none"
          style={{
            padding: mobile
              ? "env(safe-area-inset-top, 6px) 10px 0 env(safe-area-inset-left, 6px)"
              : "12px 16px 0 16px",
            gap: mobile ? "4px" : "12px",
          }}
        >
          {/* Balance */}
          <div className={`bg-black/70 backdrop-blur-sm shrink-0 ${mobile ? "rounded-md px-1.5 py-0.5" : "rounded-lg px-4 py-2"}`}>
            <div className={mobile ? "text-[9px] text-gray-400 leading-tight" : "text-sm text-gray-400"}>Balance</div>
            <div className={mobile ? "text-[13px] font-bold text-green-400 leading-tight" : "text-2xl font-bold text-green-400"}>
              ${stats.value.toFixed(2)}
            </div>
          </div>

          {/* Length */}
          <div className={`bg-black/70 backdrop-blur-sm shrink-0 ${mobile ? "rounded-md px-1.5 py-0.5" : "rounded-lg px-3 py-2"}`}>
            <div className={mobile ? "text-[9px] text-gray-400 leading-tight" : "text-sm text-gray-400"}>Len</div>
            <div className={mobile ? "text-[13px] font-bold text-white leading-tight" : "text-2xl font-bold text-white"}>
              {stats.length}
            </div>
          </div>

          {/* Kills */}
          <div className={`bg-black/70 backdrop-blur-sm text-center shrink-0 ${mobile ? "rounded-md px-1.5 py-0.5" : "rounded-lg px-3 py-2"}`}>
            <div className={mobile ? "text-[9px] text-gray-400 leading-tight" : "text-xs text-gray-400"}>Kills</div>
            <div className={mobile ? "text-[12px] font-bold text-white leading-tight" : "text-lg font-bold text-white"}>{stats.kills}</div>
          </div>

          {/* Alive */}
          <div className={`bg-black/70 backdrop-blur-sm text-center shrink-0 ${mobile ? "rounded-md px-1.5 py-0.5" : "rounded-lg px-3 py-2"}`}>
            <div className={mobile ? "text-[9px] text-gray-400 leading-tight" : "text-xs text-gray-400"}>Alive</div>
            <div className={mobile ? "text-[12px] font-bold text-white leading-tight" : "text-lg font-bold text-white"}>{stats.alive}</div>
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Voice Mute */}
          {voiceEnabled && (
            <button
              onClick={handleToggleVoiceMute}
              className={`pointer-events-auto bg-black/70 hover:bg-black/90 text-white font-bold rounded-full transition-colors backdrop-blur-sm flex items-center justify-center shrink-0 ${
                mobile ? "w-7 h-7 text-[10px]" : "w-10 h-10 text-base"
              } ${voice.selfMuted ? "opacity-50" : ""}`}
              title={voice.selfMuted ? "Unmute Mic" : "Mute Mic"}
            >
              {voice.selfMuted ? "\u{1F507}" : "\u{1F399}"}
            </button>
          )}

          {/* Sound Mute */}
          <button
            onClick={handleToggleMute}
            className={`pointer-events-auto bg-black/70 hover:bg-black/90 text-white font-bold rounded-full transition-colors backdrop-blur-sm flex items-center justify-center shrink-0 ${
              mobile ? "w-7 h-7 text-[10px]" : "w-10 h-10 text-base"
            }`}
            title={stats.muted ? "Unmute" : "Mute"}
          >
            {stats.muted ? "\u{1F507}" : "\u{1F50A}"}
          </button>

          {/* Cash Out — pill shape (hidden for spectators) */}
          {!spectating && (
            <button
              onClick={handleCashout}
              className={`pointer-events-auto bg-green-500 hover:bg-green-400 text-black font-bold rounded-full transition-colors shrink-0 ${
                mobile ? "px-2.5 h-[30px] text-[11px] leading-none" : "px-5 py-2.5 text-sm"
              }`}
            >
              {mobile ? `Cash $${stats.value.toFixed(2)}` : `Cash Out $${stats.value.toFixed(2)}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
