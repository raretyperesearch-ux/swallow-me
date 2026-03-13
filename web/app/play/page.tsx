"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import * as Colyseus from "colyseus.js";
import { joinRoom } from "../../lib/colyseus/client";
import { usePrivy, getAccessToken } from "@privy-io/react-auth";
import { useSolanaWallets, useSendTransaction } from "@privy-io/react-auth/solana";

// Dynamic import SnakeGame (no SSR — Canvas needs browser)
const SnakeGame = dynamic(() => import("../../components/SnakeGame"), {
  ssr: false,
});

type GamePhase = "lobby" | "playing" | "dead" | "cashout";

export default function PlayPage() {
  const [phase, setPhase] = useState<GamePhase>("lobby");
  const [room, setRoom] = useState<Colyseus.Room | null>(null);
  const [deathData, setDeathData] = useState<any>(null);
  const [cashoutData, setCashoutData] = useState<any>(null);
  const [connecting, setConnecting] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const deathTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Privy auth
  const { login, logout, authenticated, user, ready } = usePrivy();
  const { wallets, ready: walletsReady, createWallet } = useSolanaWallets();
  const { sendTransaction } = useSendTransaction();
  const [playerData, setPlayerData] = useState<any>(null);
  const [usdcBalance, setUsdcBalance] = useState<number>(0);
  const [walletAddress, setWalletAddress] = useState<string>("");
  const [showUsernameModal, setShowUsernameModal] = useState(false);
  const [usernameInput, setUsernameInput] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [showFundsModal, setShowFundsModal] = useState(false);
  const [showAddFundsModal, setShowAddFundsModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showReferralModal, setShowReferralModal] = useState(false);
  const [referralCopied, setReferralCopied] = useState(false);
  const [showCashOutModal, setShowCashOutModal] = useState(false);
  const [cashOutAddress, setCashOutAddress] = useState('');
  const [cashOutAmount, setCashOutAmount] = useState('');
  const [cashingOut, setCashingOut] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "error" | "info" | "success" } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initRetryRef = useRef(0);

  const showToast = (message: string, type: "error" | "info" | "success" = "error") => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, type });
    toastTimerRef.current = setTimeout(() => setToast(null), 3500);
  };

  // Post-login: register/find player + load data (waits for walletAddress from creation effect)
  useEffect(() => {
    if (!walletAddress || !authenticated || !ready) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const maxRetries = 10;

    const initPlayer = async () => {
      if (cancelled) return;
      try {
        const token = await getAccessToken();
        const res = await fetch("/api/user/register", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        });
        const data = await res.json();

        if (cancelled) return;

        // Wallet still provisioning server-side — retry
        if ((data.error === "No Solana wallet" || data.retry) && initRetryRef.current < maxRetries) {
          initRetryRef.current += 1;
          console.log(`[INIT] Wallet not ready server-side, retry ${initRetryRef.current}/${maxRetries} in 2s...`);
          retryTimer = setTimeout(initPlayer, 2000);
          return;
        }

        if (data.player) {
          initRetryRef.current = 0;
          setPlayerData(data.player);
          if (!data.player.username) {
            setShowUsernameModal(true);
          }
          // Refresh balance on successful init
          handleRefreshBalance(true);
        }
      } catch (err) {
        console.error("[INIT] Failed to register/find player:", err);
        if (!cancelled && initRetryRef.current < maxRetries) {
          initRetryRef.current += 1;
          retryTimer = setTimeout(initPlayer, 2000);
        }
      }
    };

    initPlayer();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [walletAddress, authenticated, ready]);

  // Periodic balance refresh when wallet is available
  useEffect(() => {
    if (!walletAddress) return;
    handleRefreshBalance(true);
    const interval = setInterval(() => handleRefreshBalance(true), 15000);
    return () => clearInterval(interval);
  }, [walletAddress]);

  // Create Solana wallet if missing, then set wallet address
  useEffect(() => {
    if (!ready || !authenticated || !walletsReady) return;

    const privyWallet = wallets.find((w: any) => w.walletClientType === "privy");

    if (!privyWallet && createWallet) {
      // No Solana wallet exists — create one explicitly
      console.log('[WALLET] No Solana wallet found, creating one...');
      createWallet()
        .then((wallet: any) => {
          console.log('[WALLET] Solana wallet created:', wallet.address);
          setWalletAddress(wallet.address);
        })
        .catch((err: any) => {
          console.error('[WALLET] Failed to create Solana wallet:', err);
          // If it fails because one already exists, that's fine
          if (err.message?.includes('already')) {
            console.log('[WALLET] Wallet already exists, will pick up on next render');
          }
        });
    } else if (privyWallet) {
      setWalletAddress(privyWallet.address);
    }
  }, [ready, authenticated, walletsReady, wallets, createWallet]);

  // Show username modal once wallet becomes available for first-time users
  useEffect(() => {
    if (walletAddress && playerData && !playerData.username && !showUsernameModal) {
      setShowUsernameModal(true);
    }
  }, [walletAddress, playerData, showUsernameModal]);

  // Cleanup death timer on unmount
  useEffect(() => {
    return () => {
      if (deathTimeoutRef.current) clearTimeout(deathTimeoutRef.current);
    };
  }, []);

  const handleCopyAddress = () => {
    if (!walletAddress) return;
    navigator.clipboard.writeText(walletAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleAddFunds = () => {
    if (!authenticated) {
      login();
      return;
    }
    setShowAddFundsModal(true);
  };

  const handleCashOut = () => {
    if (!authenticated) {
      login();
      return;
    }
    if (usdcBalance <= 0) {
      showToast("No funds to withdraw.", "info");
      return;
    }
    setShowCashOutModal(true);
  };

  const handleCashOutSubmit = async () => {
    const amount = Number(cashOutAmount);
    if (!cashOutAddress || cashOutAddress.length < 32) {
      showToast("Enter a valid Solana wallet address", "error");
      return;
    }
    if (!amount || amount <= 0 || amount > usdcBalance) {
      showToast("Enter a valid amount", "error");
      return;
    }

    setCashingOut(true);
    try {
      const { Connection, PublicKey, Transaction } = await import("@solana/web3.js");
      const { getAssociatedTokenAddress, createTransferInstruction, createAssociatedTokenAccountInstruction, getAccount } = await import("@solana/spl-token");

      const wallet = wallets.find((w: any) => w.walletClientType === "privy");
      if (!wallet) throw new Error("No embedded wallet found");

      const playerPubkey = new PublicKey(wallet.address);
      const connection = new Connection(
        process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
        "confirmed"
      );

      const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      let destPubkey: InstanceType<typeof PublicKey>;
      try {
        destPubkey = new PublicKey(cashOutAddress);
      } catch {
        throw new Error("Invalid destination address");
      }

      const sourceATA = await getAssociatedTokenAddress(USDC_MINT, playerPubkey);
      const destATA = await getAssociatedTokenAddress(USDC_MINT, destPubkey);

      const amountMicro = Math.floor(amount * 1_000_000);
      const tx = new Transaction();

      // Create destination ATA if it doesn't exist
      try {
        await getAccount(connection, destATA);
      } catch {
        tx.add(
          createAssociatedTokenAccountInstruction(playerPubkey, destATA, destPubkey, USDC_MINT)
        );
      }

      tx.add(createTransferInstruction(sourceATA, destATA, playerPubkey, amountMicro));

      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = playerPubkey;

      const result = await sendTransaction({ transaction: tx, connection });
      const signature = (result as any).signature || String(result);
      console.log("[CASHOUT] Withdrawal sent:", signature);

      showToast(`Withdrawal sent! ${amount.toFixed(2)} USDC`, "success");
      setShowCashOutModal(false);
      setCashOutAddress("");
      setCashOutAmount("");
      setTimeout(() => handleRefreshBalance(true), 3000);
    } catch (err: any) {
      console.error("[CASHOUT] Failed:", err);
      showToast(err.message || "Withdrawal failed", "error");
    } finally {
      setCashingOut(false);
    }
  };

  const handleRefreshBalance = async (silent = false) => {
    if (!walletAddress) return;
    try {
      const { Connection, PublicKey } = await import("@solana/web3.js");
      const { getAssociatedTokenAddress } = await import("@solana/spl-token");
      const connection = new Connection(
        process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
        "confirmed"
      );
      const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      const playerPubkey = new PublicKey(walletAddress);
      const ata = await getAssociatedTokenAddress(USDC_MINT, playerPubkey);
      const tokenAccount = await connection.getTokenAccountBalance(ata).catch(() => null);
      const balance = tokenAccount ? Number(tokenAccount.value.uiAmount || 0) : 0;
      setUsdcBalance(balance);
      if (!silent) showToast("Balance updated", "success");
    } catch (err) {
      console.error("[REFRESH] Failed:", err);
      setUsdcBalance(0);
      if (!silent) showToast("Failed to refresh balance", "error");
    }
  };

  const handleSignOut = () => {
    logout();
    setPlayerData(null);
    setWalletAddress("");
    setUsdcBalance(0);
  };

  const handleJoin = async () => {
    if (!authenticated) {
      setShowFundsModal(true);
      return;
    }
    if (!playerData?.username) {
      setShowUsernameModal(true);
      return;
    }
    if (usdcBalance < 1.0) {
      setShowFundsModal(true);
      return;
    }

    setConnecting(true);
    try {
      const { Connection, PublicKey, Transaction } = await import("@solana/web3.js");
      const { getAssociatedTokenAddress, createTransferInstruction } = await import("@solana/spl-token");

      // Find the Privy embedded wallet
      const wallet = wallets.find((w: any) => w.walletClientType === "privy");
      if (!wallet) throw new Error("No embedded wallet found");

      const playerPubkey = new PublicKey(wallet.address);
      const connection = new Connection(
        process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
        "confirmed"
      );

      // Check SOL balance for gas fees
      try {
        const solBalance = await connection.getBalance(playerPubkey);
        const solAmount = solBalance / 1_000_000_000;
        console.log('[JOIN] SOL balance:', solAmount);

        if (solAmount < 0.005) {
          showToast('You need SOL for transaction fees. Send at least 0.01 SOL to your wallet.', 'error');
          setConnecting(false);
          return;
        }
      } catch (e) {
        console.error('[JOIN] SOL balance check failed:', e);
      }

      const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      const TREASURY = new PublicKey("53Qy2ygocLjKWbtjgaepzHfZnf9oiZENJPWMnNUkSz8L");

      const playerATA = await getAssociatedTokenAddress(USDC_MINT, playerPubkey);
      const treasuryATA = await getAssociatedTokenAddress(USDC_MINT, TREASURY);

      const transferIx = createTransferInstruction(
        playerATA, treasuryATA, playerPubkey, 1_000_000
      );

      const tx = new Transaction().add(transferIx);
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = playerPubkey;

      // DON'T wait for confirmation on client — go straight to server
      // The server will verify the transaction via getParsedTransaction
      // If Solana is slow, the server can retry verification

      let signature: string;
      try {
        const result = await sendTransaction({
          transaction: tx,
          connection: connection,
        });
        signature = (result as any).signature || String(result);
        console.log('[JOIN] Transaction sent:', signature);
      } catch (txErr: any) {
        console.error('[JOIN] Transaction send failed:', txErr);
        throw new Error('Transaction failed. Your funds were not sent.');
      }

      // Small delay to let tx propagate, but don't block on full confirmation
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Tell server about the payment
      const authToken = await getAccessToken();
      const res = await fetch("/api/game/enter", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ txSignature: signature }),
      });
      const data = await res.json();
      if (!data.success) {
        // If server can't verify tx yet, retry once after 5 more seconds
        if (data.error?.includes('not found') || data.error?.includes('not contain')) {
          console.log('[JOIN] Server could not verify tx yet, retrying in 5s...');
          await new Promise(resolve => setTimeout(resolve, 5000));
          const res2 = await fetch("/api/game/enter", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({ txSignature: signature }),
          });
          const data2 = await res2.json();
          if (!data2.success) throw new Error(data2.error || 'Failed to enter game');
          // Success on retry
          const r = await joinRoom(1, data2.wallet, data2.username, {
            sessionId: data2.sessionId,
            playerId: data2.playerId,
          });
          setRoom(r);
          setPhase("playing");
          return;
        }
        throw new Error(data.error);
      }

      // Success
      const r = await joinRoom(1, data.wallet, data.username, {
        sessionId: data.sessionId,
        playerId: data.playerId,
      });
      setRoom(r);
      setPhase("playing");
    } catch (err: any) {
      console.error("Failed to join:", err);
      if (err.message?.includes("insufficient") || err.message?.includes("0x1")) {
        setShowFundsModal(true);
      } else {
        showToast(err.message || "Failed to enter game", "error");
      }
    } finally {
      setConnecting(false);
    }
  };

  const handleDeath = useCallback((data: any) => {
    setDeathData(data);
    setPhase("dead");
    // No auto-dismiss — player clicks REJOIN LOBBY when ready
  }, []);

  const handleCashout = useCallback((data: any) => {
    setCashoutData(data);
    setPhase("cashout");
  }, []);

  const handlePlayAgain = useCallback(() => {
    room?.leave();
    setRoom(null);
    setDeathData(null);
    setCashoutData(null);
    setPhase("lobby");
  }, [room]);

  const handleSetUsername = async () => {
    const trimmed = usernameInput.trim();
    if (trimmed.length < 3 || trimmed.length > 16) {
      setUsernameError("Username must be 3-16 characters");
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      setUsernameError("Letters, numbers, underscores only");
      return;
    }
    try {
      const token = await getAccessToken();
      const res = await fetch("/api/user/set-username", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ username: trimmed }),
      });
      const data = await res.json();
      if (data.success) {
        setPlayerData((prev: any) => ({ ...prev, username: trimmed }));
        setShowUsernameModal(false);
        setUsernameError("");
      } else {
        setUsernameError(data.error || "Failed to set username");
      }
    } catch (err: any) {
      setUsernameError(err.message || "Network error");
    }
  };

  // Helper: truncate wallet address
  const truncAddr = (addr: string) =>
    addr ? `${addr.slice(0, 5)}...${addr.slice(-4)}` : "";

  // ─── Lobby Phase (Pink Chrome UI) ────────────────────
  if (phase === "lobby") {
    const displayName = playerData?.username || "Player";
    const avatarLetter = displayName[0].toUpperCase();

    // Shared card style
    const cardStyle: React.CSSProperties = {
      background: "#110a18",
      border: "1px solid rgba(255,105,180,0.08)",
      borderRadius: 16,
      padding: "20px",
    };

    // Wallet card content (reused for desktop + mobile)
    const walletCardContent = (
      <>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={{ fontFamily: "'Russo One', sans-serif", fontSize: 16, color: "#fff" }}>Wallet</span>
          <div style={{ display: "flex", gap: 12 }}>
            {walletAddress && (
              <span
                onClick={handleCopyAddress}
                style={{ fontSize: 11, color: "#FF69B4", cursor: "pointer" }}
              >
                {copied ? "Copied!" : "Copy Address"}
              </span>
            )}
            {walletAddress && (
              <span
                onClick={() => handleRefreshBalance()}
                style={{ fontSize: 11, color: "#666", cursor: "pointer" }}
              >
                Refresh
              </span>
            )}
          </div>
        </div>
        {walletAddress && (
          <div style={{ fontSize: 11, color: "#888", fontFamily: "monospace", marginBottom: 8 }}>
            {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
          </div>
        )}
        <div style={{ fontSize: 32, fontWeight: 800, background: "linear-gradient(180deg, #fff 0%, #bbb 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", marginBottom: 4 }}>
          ${usdcBalance.toFixed(2)}
        </div>
        <div style={{ fontSize: 13, color: "#666", marginBottom: 16 }}>{usdcBalance.toFixed(4)} USDC</div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={handleAddFunds} style={{ flex: 1, padding: "10px", borderRadius: 10, border: "none", background: "linear-gradient(180deg, #00E676 0%, #00C853 100%)", color: "#000", fontWeight: 700, fontSize: 13, cursor: "pointer", boxShadow: "0 4px 0 #009624" }}>Add Funds</button>
          <button onClick={handleCashOut} style={{ flex: 1, padding: "10px", borderRadius: 10, border: "none", background: "linear-gradient(180deg, #AB47BC 0%, #7B1FA2 100%)", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", boxShadow: "0 4px 0 #4A148C" }}>Cash Out</button>
        </div>
      </>
    );

    // Left column: Leaderboard
    const leftColumn = (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={cardStyle}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <span style={{ fontFamily: "'Russo One', sans-serif", fontSize: 16, color: "#fff" }}>Leaderboard</span>
            <span style={{ background: "#00E676", color: "#000", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 8, animation: "pulse 2s infinite" }}>Live</span>
          </div>
          {[
            { rank: 1, name: "venom_king", amount: "$42.50" },
            { rank: 2, name: "snek_lord", amount: "$28.00" },
            { rank: 3, name: "coil_master", amount: "$15.75" },
          ].map((row) => (
            <div key={row.rank} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
              <span style={{ width: 24, height: 24, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, background: row.rank === 1 ? "linear-gradient(135deg, #FFD740, #FF8F00)" : row.rank === 2 ? "linear-gradient(135deg, #B0BEC5, #78909C)" : "linear-gradient(135deg, #A1887F, #795548)", color: "#000" }}>{row.rank}</span>
              <span style={{ flex: 1, fontSize: 13, color: "#ccc" }}>{row.name}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#00E676" }}>{row.amount}</span>
            </div>
          ))}
          <button style={{ width: "100%", marginTop: 12, padding: "10px", borderRadius: 10, border: "1px solid rgba(255,105,180,0.2)", background: "transparent", color: "#FF69B4", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            View Full Leaderboard
          </button>
        </div>
      </div>
    );

    // Right column: Wallet + Store
    const rightColumn = (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Wallet Card (desktop only) */}
        <div className="desktop-wallet" style={cardStyle}>
          {walletCardContent}
        </div>
        {/* Store Card */}
        <div style={{ ...cardStyle, textAlign: "center" as const, position: "relative" as const, overflow: "hidden" }}>
          <div style={{ fontSize: 48, opacity: 0.15, marginBottom: 8 }}>&#x1F512;</div>
          <div style={{ fontFamily: "'Russo One', sans-serif", fontSize: 18, background: "linear-gradient(90deg, #FF69B4, #FF1493)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", marginBottom: 6 }}>COMING SOON</div>
          <div style={{ fontSize: 12, color: "#666" }}>Exclusive skins and custom appearances</div>
        </div>
      </div>
    );

    // Center column
    const centerColumn = (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 8 }}>
          <div style={{ fontFamily: "'Russo One', sans-serif", fontSize: 48, lineHeight: 1.1, letterSpacing: 4 }}>
            <span style={{ background: "linear-gradient(180deg, #fff 0%, #aaa 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>SWALLOW</span>
          </div>
          <div style={{ fontFamily: "'Russo One', sans-serif", fontSize: 48, lineHeight: 1.1, letterSpacing: 4, animation: "chromePulse 3s ease infinite", backgroundSize: "200% 200%" }}>
            <span style={{ background: "linear-gradient(90deg, #FF69B4, #FF1493, #C71585, #FF69B4)", backgroundSize: "200% 200%", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", animation: "chromePulse 3s ease infinite" }}>ME</span>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, letterSpacing: 3, fontWeight: 600 }}>
            <span style={{ color: "#fff" }}>A BUY</span>
            <span style={{ color: "#00E676" }}>MONEY</span>
            <span style={{ color: "#fff" }}> GAME</span>
          </div>
        </div>

        {/* Username Card */}
        <div style={{ ...cardStyle, width: "100%", maxWidth: 340, display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: "50%", background: "linear-gradient(135deg, #FF69B4, #C71585)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 800, color: "#fff", flexShrink: 0 }}>{avatarLetter}</div>
          <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: "#fff" }}>{displayName}</span>
          {authenticated && (
            <button onClick={handleSignOut} style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "6px 12px", color: "#888", fontSize: 11, cursor: "pointer" }}>Sign Out</button>
          )}
        </div>

        {/* Entry Amount Card */}
        <div style={{ ...cardStyle, width: "100%", maxWidth: 340, textAlign: "center" as const, border: "1px solid rgba(255,215,64,0.15)", position: "relative" as const, overflow: "hidden" }}>
          <div style={{ fontSize: 11, color: "#999", letterSpacing: 2, marginBottom: 8, fontWeight: 600 }}>ENTRY AMOUNT</div>
          <div style={{ fontSize: 40, fontWeight: 800, background: "linear-gradient(90deg, #FFE082 0%, #FFD740 45%, #FF8F00 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", animation: "gleam 3s ease infinite" }}>$1.00</div>
        </div>

        {/* JOIN GAME Button */}
        <button
          onClick={handleJoin}
          disabled={connecting}
          style={{
            width: "100%",
            maxWidth: 340,
            padding: "18px 32px",
            borderRadius: 14,
            border: "none",
            background: connecting ? "#444" : "linear-gradient(180deg, #FF69B4 0%, #C71585 100%)",
            color: "#fff",
            fontFamily: "'Russo One', sans-serif",
            fontSize: 20,
            letterSpacing: 2,
            cursor: connecting ? "default" : "pointer",
            boxShadow: connecting ? "none" : "0 6px 0 #8B0A50, 0 8px 20px rgba(255,105,180,0.3)",
            position: "relative" as const,
            overflow: "hidden",
            transition: "transform 0.1s",
          }}
        >
          {connecting ? "Connecting..." : "JOIN GAME"}
          {!connecting && (
            <span style={{ position: "absolute", top: 0, left: "-80%", width: "60%", height: "100%", background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)", animation: "shineSweep 3s ease-in-out infinite" }} />
          )}
        </button>

        {/* Mobile Wallet (hidden on desktop) */}
        <div style={{ display: "none", width: "100%", maxWidth: 340 }} className="mobile-wallet">
          <div style={cardStyle}>
            {walletCardContent}
          </div>
        </div>

        {/* Stats Row */}
        <div style={{ display: "flex", gap: 16, width: "100%", maxWidth: 340 }}>
          <div style={{ ...cardStyle, flex: 1, textAlign: "center" as const, padding: 14 }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#00E676" }}>12</div>
            <div style={{ fontSize: 10, color: "#666", marginTop: 2 }}>Players In Game</div>
          </div>
          <div style={{ ...cardStyle, flex: 1, textAlign: "center" as const, padding: 14 }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#00E676" }}>$1,247</div>
            <div style={{ fontSize: 10, color: "#666", marginTop: 2 }}>Global Winnings</div>
          </div>
        </div>

        {/* Manage Referral */}
        <button onClick={() => { if (!authenticated) { login(); return; } setShowReferralModal(true); }} style={{ width: "100%", maxWidth: 340, padding: "12px", borderRadius: 10, border: "1px solid rgba(255,105,180,0.15)", background: "rgba(255,105,180,0.05)", color: "#FF69B4", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          Manage Referral
        </button>
      </div>
    );

    return (
      <div style={{ minHeight: "100vh", background: "#0c0610", color: "#fff", overflowY: "auto", overflowX: "hidden", position: "fixed", inset: 0 }}>
        {/* Toast notification */}
        {toast && (
          <div
            style={{
              position: "fixed",
              top: 20,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 10000,
              minWidth: 260,
              maxWidth: "calc(100% - 24px)",
              padding: "12px 16px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.12)",
              background:
                toast.type === "success"
                  ? "linear-gradient(180deg, #2E7D32, #1B5E20)"
                  : toast.type === "info"
                  ? "linear-gradient(180deg, #3949AB, #1A237E)"
                  : "linear-gradient(180deg, #C62828, #8E0000)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 700,
              textAlign: "center" as const,
              boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
              pointerEvents: "none" as const,
            }}
          >
            {toast.message}
          </div>
        )}

        {/* Background gameplay video */}
        <video
          autoPlay
          loop
          muted
          playsInline
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            zIndex: 0,
            opacity: 0.12,
            pointerEvents: "none",
            filter: "blur(2px)",
          }}
        >
          <source src="/gameplay-loop.mp4" type="video/mp4" />
        </video>

        {/* Top Bar */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.04)", position: "relative", zIndex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: "50%", background: "linear-gradient(135deg, #FF69B4, #C71585)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800 }}>SM</div>
            <span style={{ fontSize: 13, color: "#999" }}>Welcome, <span style={{ color: "#fff", fontWeight: 600 }}>{displayName}</span></span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setVoiceEnabled(!voiceEnabled)} style={{ width: 32, height: 32, borderRadius: "50%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, cursor: "pointer", color: "#999" }}>{voiceEnabled ? "\u{1F50A}" : "\u{1F507}"}</button>
            <button onClick={() => window.open("https://www.ibuy.money/dashboard", "_blank")} style={{ width: 32, height: 32, borderRadius: "50%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, cursor: "pointer", color: "#999" }}>{"\u{1F464}"}</button>
            <button onClick={() => window.open("https://www.ibuy.money/dashboard", "_blank")} style={{ width: 32, height: 32, borderRadius: "50%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, cursor: "pointer", color: "#999" }}>{"\u{2699}\u{FE0F}"}</button>
          </div>
        </div>

        {/* Main Content */}
        <div style={{ padding: "20px", maxWidth: 1200, margin: "0 auto", position: "relative", zIndex: 1 }}>
          {/* Desktop: 3-column grid */}
          <div className="lobby-grid" style={{ display: "grid", gap: 20 }}>
            <div className="lobby-left">{leftColumn}</div>
            <div className="lobby-center">{centerColumn}</div>
            <div className="lobby-right">{rightColumn}</div>
          </div>
        </div>

        {/* Discord CTA */}
        <a
          href="https://discord.gg/RXmKtyQhRz"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            position: "fixed",
            bottom: 20,
            left: 20,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 16px",
            borderRadius: 12,
            background: "linear-gradient(180deg, #7289DA 0%, #5865F2 100%)",
            color: "#fff",
            fontSize: 13,
            fontWeight: 700,
            textDecoration: "none",
            boxShadow: "0 4px 0 #4752C4",
            zIndex: 50,
          }}
        >
          <svg width="18" height="14" viewBox="0 0 71 55" fill="none"><path d="M60.1 4.9A58.5 58.5 0 0045.4.2a.2.2 0 00-.2.1 40.8 40.8 0 00-1.8 3.7 54 54 0 00-16.2 0A37.4 37.4 0 0025.4.3a.2.2 0 00-.2-.1A58.4 58.4 0 0010.5 5 .2.2 0 0010.4 5C1.5 18.5-.9 31.6.3 44.6v.1a58.7 58.7 0 0017.7 9 .2.2 0 00.3-.1 42 42 0 003.6-5.9.2.2 0 00-.1-.3 38.7 38.7 0 01-5.5-2.6.2.2 0 010-.4c.4-.3.7-.6 1.1-.8a.2.2 0 01.2 0c11.6 5.3 24.1 5.3 35.5 0a.2.2 0 01.3 0l1 .9a.2.2 0 01-.1.3 36.3 36.3 0 01-5.5 2.6.2.2 0 00-.1.3 47.2 47.2 0 003.7 5.9.2.2 0 00.2.1 58.5 58.5 0 0017.7-9v-.1c1.4-15-2.3-28-9.8-39.5a.2.2 0 00-.1-.1zM23.7 36.6c-3.4 0-6.2-3.1-6.2-7s2.7-7 6.2-7c3.5 0 6.3 3.2 6.2 7 0 3.9-2.7 7-6.2 7zm23 0c-3.4 0-6.2-3.1-6.2-7s2.7-7 6.2-7c3.5 0 6.3 3.2 6.2 7 0 3.9-2.7 7-6.2 7z" fill="currentColor"/></svg>
          Join Discord
        </a>

        {/* Referral Modal */}
        {showReferralModal && (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 99999,
            background: 'rgba(0,0,0,0.8)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backdropFilter: 'blur(6px)',
          }} onClick={() => setShowReferralModal(false)}>
            <div style={{
              background: '#110a18',
              border: '1px solid rgba(255,105,180,0.2)',
              borderRadius: 16,
              padding: '32px 24px',
              maxWidth: 360,
              width: '90%',
              textAlign: 'center' as const,
            }} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>&#x1F517;</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: '#fff', marginBottom: 4 }}>
                Referral Program
              </div>
              <div style={{ fontSize: 12, color: '#888', lineHeight: 1.6, marginBottom: 20 }}>
                Earn <span style={{
                  background: 'linear-gradient(90deg, #FFD740, #FFE082, #FF8F00)',
                  backgroundSize: '200% 100%',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  fontWeight: 800,
                }}>30%</span> of the platform fee from every game your referrals play — across ALL BuyMoney games.
              </div>
              <div style={{
                background: '#0c0610',
                border: '1px solid rgba(255,105,180,0.1)',
                borderRadius: 10,
                padding: '12px 14px',
                marginBottom: 12,
                fontSize: 12,
                color: '#aaa',
                fontFamily: 'monospace',
                wordBreak: 'break-all' as const,
              }}>
                {playerData?.referral_code
                  ? `https://ibuy.money/?ref=${playerData.referral_code}`
                  : 'Loading...'}
              </div>
              <button
                onClick={() => {
                  if (playerData?.referral_code) {
                    navigator.clipboard.writeText(`https://ibuy.money/?ref=${playerData.referral_code}`);
                    setReferralCopied(true);
                    setTimeout(() => setReferralCopied(false), 2000);
                  }
                }}
                style={{
                  width: '100%',
                  padding: '14px 0',
                  borderRadius: 12,
                  border: 'none',
                  background: 'linear-gradient(180deg, #FFB3D9, #FF69B4, #FF1493)',
                  borderBottom: '4px solid #5C0030',
                  color: '#fff',
                  fontSize: 14,
                  fontWeight: 800,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {referralCopied ? '\u2713 COPIED!' : 'COPY REFERRAL LINK'}
              </button>
              <div style={{ display: 'flex', gap: 12, marginTop: 16, justifyContent: 'center' }}>
                <div style={{ textAlign: 'center' as const }}>
                  <div style={{
                    fontSize: 20, fontWeight: 800,
                    background: 'linear-gradient(90deg, #00FF87, #00E676, #00C853)',
                    backgroundSize: '200% 100%',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                  }}>
                    {playerData?.total_referrals || 0}
                  </div>
                  <div style={{ fontSize: 10, color: '#555' }}>Referrals</div>
                </div>
                <div style={{ textAlign: 'center' as const }}>
                  <div style={{
                    fontSize: 20, fontWeight: 800,
                    background: 'linear-gradient(90deg, #00FF87, #00E676, #00C853)',
                    backgroundSize: '200% 100%',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                  }}>
                    ${Number(playerData?.total_referral_earnings || 0).toFixed(2)}
                  </div>
                  <div style={{ fontSize: 10, color: '#555' }}>Earned</div>
                </div>
              </div>
              <button
                onClick={() => window.open('https://www.ibuy.money/dashboard', '_blank')}
                style={{
                  width: '100%',
                  padding: '10px 0',
                  marginTop: 12,
                  borderRadius: 10,
                  border: '1px solid rgba(255,105,180,0.1)',
                  background: 'transparent',
                  color: '#FF69B4',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {"View Full Dashboard \u2197"}
              </button>
              <button
                onClick={() => setShowReferralModal(false)}
                style={{
                  width: '100%', padding: '8px 0', marginTop: 6,
                  borderRadius: 8, border: 'none',
                  background: 'transparent', color: '#444', fontSize: 11,
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                Close
              </button>
            </div>
          </div>
        )}

        {/* Cash Out Modal */}
        {showCashOutModal && (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 99999,
            background: 'rgba(0,0,0,0.8)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backdropFilter: 'blur(6px)',
          }} onClick={() => { if (!cashingOut) setShowCashOutModal(false); }}>
            <div style={{
              background: '#110a18',
              border: '1px solid rgba(255,105,180,0.2)',
              borderRadius: 16,
              padding: '32px 24px',
              maxWidth: 380,
              width: '90%',
              textAlign: 'center' as const,
            }} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 18, fontWeight: 900, color: '#fff', marginBottom: 4 }}>
                Withdraw USDC
              </div>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 20 }}>
                Send USDC from your embedded wallet to any Solana address
              </div>

              <div style={{ textAlign: 'left' as const, marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: '#666', marginBottom: 4, fontWeight: 600 }}>DESTINATION ADDRESS</div>
                <input
                  type="text"
                  value={cashOutAddress}
                  onChange={e => setCashOutAddress(e.target.value.trim())}
                  placeholder="Solana wallet address..."
                  disabled={cashingOut}
                  style={{
                    width: '100%',
                    padding: '12px 14px',
                    borderRadius: 10,
                    border: '1px solid rgba(255,105,180,0.15)',
                    background: '#0c0610',
                    color: '#fff',
                    fontSize: 13,
                    fontFamily: 'monospace',
                    outline: 'none',
                    boxSizing: 'border-box' as const,
                  }}
                />
              </div>

              <div style={{ textAlign: 'left' as const, marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: '#666', marginBottom: 4, fontWeight: 600, display: 'flex', justifyContent: 'space-between' }}>
                  <span>AMOUNT (USDC)</span>
                  <span style={{ color: '#888' }}>Balance: ${usdcBalance.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="number"
                    value={cashOutAmount}
                    onChange={e => setCashOutAmount(e.target.value)}
                    placeholder="0.00"
                    disabled={cashingOut}
                    step="0.01"
                    min="0"
                    max={usdcBalance}
                    style={{
                      flex: 1,
                      padding: '12px 14px',
                      borderRadius: 10,
                      border: '1px solid rgba(255,105,180,0.15)',
                      background: '#0c0610',
                      color: '#fff',
                      fontSize: 15,
                      fontWeight: 700,
                      outline: 'none',
                      boxSizing: 'border-box' as const,
                    }}
                  />
                  <button
                    onClick={() => setCashOutAmount(usdcBalance.toFixed(2))}
                    disabled={cashingOut}
                    style={{
                      padding: '12px 16px',
                      borderRadius: 10,
                      border: '1px solid rgba(255,105,180,0.2)',
                      background: 'rgba(255,105,180,0.08)',
                      color: '#FF69B4',
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: cashingOut ? 'default' : 'pointer',
                    }}
                  >
                    MAX
                  </button>
                </div>
              </div>

              <button
                onClick={handleCashOutSubmit}
                disabled={cashingOut || !cashOutAddress || !cashOutAmount || Number(cashOutAmount) <= 0 || Number(cashOutAmount) > usdcBalance}
                style={{
                  width: '100%',
                  padding: '14px 0',
                  borderRadius: 12,
                  border: 'none',
                  background: cashingOut || !cashOutAddress || !cashOutAmount || Number(cashOutAmount) <= 0 || Number(cashOutAmount) > usdcBalance
                    ? '#333'
                    : 'linear-gradient(180deg, #AB47BC, #7B1FA2)',
                  borderBottom: cashingOut ? 'none' : '4px solid #4A148C',
                  color: '#fff',
                  fontSize: 14,
                  fontWeight: 800,
                  cursor: cashingOut ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {cashingOut ? 'Sending...' : `Withdraw ${cashOutAmount ? '$' + Number(cashOutAmount).toFixed(2) : ''} USDC`}
              </button>

              <button
                onClick={() => { setShowCashOutModal(false); setCashOutAddress(''); setCashOutAmount(''); }}
                disabled={cashingOut}
                style={{
                  width: '100%', padding: '10px 0', marginTop: 8,
                  borderRadius: 10, border: 'none',
                  background: 'transparent', color: '#555', fontSize: 12,
                  cursor: cashingOut ? 'default' : 'pointer', fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Responsive styles */}
        <style jsx global>{`
          .lobby-grid {
            grid-template-columns: 1fr;
          }
          .lobby-center { order: 1; }
          .lobby-left { order: 2; }
          .lobby-right { order: 3; }
          @media (max-width: 979px) {
            .mobile-wallet { display: block !important; }
            .desktop-wallet { display: none; }
          }
          @media (min-width: 980px) {
            .lobby-grid {
              grid-template-columns: 300px 1fr 300px;
            }
            .lobby-left { order: 1; }
            .lobby-center { order: 2; }
            .lobby-right { order: 3; }
            .mobile-wallet { display: none !important; }
            .desktop-wallet { display: block; }
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
          @keyframes goldShimmer {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
          }
          @keyframes greenPulse {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
          }
        `}</style>

        {/* Username Modal — mandatory for first-time users, no close/dismiss */}
        {showUsernameModal && (
          <div style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,0.85)",
            display: "flex", alignItems: "center", justifyContent: "center",
            backdropFilter: "blur(6px)",
          }}>
            <div style={{
              background: "#110a18",
              border: "1px solid rgba(255,105,180,0.15)",
              borderRadius: 16,
              padding: "32px 28px",
              maxWidth: 340,
              width: "90%",
              textAlign: "center" as const,
            }}>
              {!walletAddress ? (
                <>
                  <div style={{
                    width: 40, height: 40, border: "3px solid rgba(255,105,180,0.3)",
                    borderTopColor: "#FF69B4", borderRadius: "50%",
                    animation: "spin 1s linear infinite",
                    margin: "0 auto 16px",
                  }} />
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#fff", marginBottom: 8 }}>
                    Setting Up Your Wallet
                  </div>
                  <div style={{ fontSize: 12, color: "#666", lineHeight: 1.5 }}>
                    Please wait while we create your Solana wallet...
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#fff", marginBottom: 8 }}>
                    Welcome to BuyMoney
                  </div>
                  <div style={{ fontSize: 12, color: "#666", marginBottom: 16, lineHeight: 1.5 }}>
                    Choose a username to get started. This is permanent across all BuyMoney games.
                  </div>
                  <input
                    autoFocus
                    type="text"
                    value={usernameInput}
                    onChange={(e) => setUsernameInput(e.target.value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 16))}
                    onKeyDown={(e) => e.key === "Enter" && usernameInput.trim().length >= 3 && handleSetUsername()}
                    placeholder="Enter username..."
                    maxLength={16}
                    style={{
                      width: "100%",
                      padding: "12px 16px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,105,180,0.15)",
                      background: "#0c0610",
                      color: "#fff",
                      fontSize: 14,
                      fontFamily: "inherit",
                      textAlign: "center" as const,
                      marginBottom: 4,
                      outline: "none",
                    }}
                  />
                  <div style={{ fontSize: 10, color: "#444", marginBottom: 12 }}>
                    3-16 characters. Letters, numbers, underscores.
                  </div>
                  {usernameError && <p style={{ color: "#FF4444", fontSize: 12, marginBottom: 8 }}>{usernameError}</p>}
                  <button
                    onClick={handleSetUsername}
                    disabled={usernameInput.trim().length < 3}
                    style={{
                      width: "100%",
                      padding: "14px 0",
                      borderRadius: 12,
                      border: "none",
                      background: usernameInput.trim().length >= 3
                        ? "linear-gradient(180deg, #FFB3D9, #FF69B4, #FF1493)"
                        : "#333",
                      borderBottom: usernameInput.trim().length >= 3 ? "4px solid #8B0A50" : "4px solid #222",
                      color: usernameInput.trim().length >= 3 ? "#fff" : "#666",
                      fontSize: 15,
                      fontWeight: 800,
                      cursor: usernameInput.trim().length >= 3 ? "pointer" : "default",
                      fontFamily: "inherit",
                    }}
                  >
                    SET USERNAME
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Add Funds Modal (from wallet card) */}
        {showAddFundsModal && (
          <div style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,0.7)",
            display: "flex", alignItems: "center", justifyContent: "center",
            backdropFilter: "blur(4px)",
          }} onClick={() => setShowAddFundsModal(false)}>
            <div style={{
              background: "#110a18",
              border: "1px solid rgba(255,105,180,0.15)",
              borderRadius: 16,
              padding: "32px 24px",
              maxWidth: 380,
              width: "90%",
              textAlign: "center" as const,
            }} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#fff", marginBottom: 6 }}>
                Add Funds
              </div>
              <div style={{ fontSize: 12, color: "#666", lineHeight: 1.6, marginBottom: 16 }}>
                Send <span style={{ color: "#00E676", fontWeight: 700 }}>USDC</span> and a small amount of
                <span style={{ color: "#BB86FC", fontWeight: 700 }}> SOL</span> (for fees) on Solana to this address:
              </div>
              <div style={{
                background: "#0c0610",
                border: "1px solid rgba(255,105,180,0.1)",
                borderRadius: 10,
                padding: "14px 16px",
                fontSize: 11,
                color: "#aaa",
                wordBreak: "break-all" as const,
                fontFamily: "monospace",
                marginBottom: 12,
                lineHeight: 1.6,
              }}>
                {walletAddress}
              </div>
              <div style={{ fontSize: 10, color: '#555', marginTop: -4, marginBottom: 12, lineHeight: 1.5 }}>
                You need both USDC (to play) and SOL (for transaction fees).<br/>
                Minimum: $1.00 USDC + 0.01 SOL (~$1.50 total)
              </div>
              <button
                onClick={() => {
                  if (!walletAddress) return;
                  navigator.clipboard.writeText(walletAddress);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                style={{
                  width: "100%",
                  padding: "14px 0",
                  borderRadius: 12,
                  border: "none",
                  background: "linear-gradient(180deg, #66BB6A, #43A047, #2E7D32)",
                  borderBottom: "4px solid #1B5E20",
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 800,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {copied ? "\u2713 COPIED!" : "COPY ADDRESS"}
              </button>
              <div style={{ fontSize: 10, color: "#444", marginTop: 12, lineHeight: 1.5 }}>
                Only send USDC on Solana. Other tokens or chains will be lost.
              </div>
              <button
                onClick={() => setShowAddFundsModal(false)}
                style={{
                  width: "100%", padding: "10px 0", marginTop: 8,
                  borderRadius: 10, border: "1px solid rgba(255,255,255,0.06)",
                  background: "transparent", color: "#555", fontSize: 12,
                  cursor: "pointer", fontFamily: "inherit",
                }}
              >
                Close
              </button>
            </div>
          </div>
        )}

        {/* Needs Funds Modal (from JOIN GAME) */}
        {showFundsModal && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 9999,
              background: "rgba(0,0,0,0.7)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backdropFilter: "blur(4px)",
            }}
            onClick={() => setShowFundsModal(false)}
          >
            <div
              style={{
                background: "#110a18",
                border: "1px solid rgba(255,105,180,0.15)",
                borderRadius: 16,
                padding: "32px 28px",
                maxWidth: 340,
                width: "calc(100% - 32px)",
                textAlign: "center" as const,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ fontSize: 40, marginBottom: 12 }}>&#x1F4B0;</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#fff", marginBottom: 8 }}>
                Add Funds to Play
              </div>
              <div style={{ fontSize: 13, color: "#888", lineHeight: 1.6, marginBottom: 20 }}>
                You need at least <span style={{ color: "#00E676", fontWeight: 700 }}>$1.00 USDC</span> and a small amount of
                <span style={{ color: "#BB86FC", fontWeight: 700 }}> SOL</span> (for fees) on Solana to enter the game.
              </div>

              {authenticated && walletAddress && (
                <div style={{ background: "#0c0610", borderRadius: 10, padding: "12px", marginBottom: 16 }}>
                  <div style={{ fontSize: 10, color: "#666", marginBottom: 6 }}>YOUR WALLET ADDRESS</div>
                  <div style={{ fontSize: 12, color: "#FF69B4", fontFamily: "monospace", wordBreak: "break-all" as const, marginBottom: 8 }}>{walletAddress}</div>
                  <button
                    onClick={handleCopyAddress}
                    style={{ padding: "6px 16px", borderRadius: 8, border: "1px solid rgba(255,105,180,0.2)", background: "transparent", color: "#FF69B4", fontSize: 11, fontWeight: 600, cursor: "pointer" }}
                  >
                    {copied ? "Copied!" : "Copy Address"}
                  </button>
                </div>
              )}

              <button
                onClick={() => {
                  setShowFundsModal(false);
                  if (!authenticated) {
                    login();
                    return;
                  }
                  handleCopyAddress();
                }}
                style={{
                  width: "100%",
                  padding: "14px 0",
                  borderRadius: 12,
                  border: "none",
                  background: "linear-gradient(180deg, #66BB6A, #43A047, #2E7D32)",
                  borderBottom: "4px solid #1B5E20",
                  color: "#fff",
                  fontSize: 15,
                  fontWeight: 800,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {!authenticated ? "SIGN IN & ADD FUNDS" : "COPY ADDRESS"}
              </button>

              <button
                onClick={() => setShowFundsModal(false)}
                style={{
                  width: "100%",
                  padding: "10px 0",
                  marginTop: 8,
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.06)",
                  background: "transparent",
                  color: "#777",
                  fontSize: 12,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── Death Overlay (rendered inside SnakeGame) ─────
  const deathOverlay = phase === "dead" ? (
    <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center text-white z-50 animate-fadeIn">
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

      <button
        onClick={handlePlayAgain}
        style={{
          width: '100%',
          maxWidth: 300,
          padding: '16px 0 30px',
          borderRadius: 12,
          border: 'none',
          background: 'linear-gradient(180deg, #FFB3D9, #FF69B4, #FF1493)',
          borderBottom: '4px solid #5C0030',
          color: '#fff',
          fontSize: 17,
          fontWeight: 900,
          cursor: 'pointer',
          letterSpacing: 2,
          position: 'relative' as const,
          overflow: 'hidden',
        }}
      >
        REJOIN LOBBY
        <span style={{
          position: 'absolute', top: 0, left: '-80%', width: '40%', height: '100%',
          background: 'linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.25) 45%, rgba(255,255,255,0.08) 50%, transparent 55%)',
          transform: 'skewX(-20deg)',
          animation: 'shineSweep 2.5s ease-in-out infinite',
          pointerEvents: 'none',
        }} />
        <div style={{
          position: 'absolute', bottom: 7, left: 0, right: 0,
          fontSize: 11, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        }}>
          {Math.floor(usdcBalance) >= 1 ? (
            <>
              <span style={{
                background: 'linear-gradient(90deg, #FFD740, #FFE082, #FFF8E1, #FFD740, #FF8F00)',
                backgroundSize: '200% 100%',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                animation: 'goldShimmer 2s ease-in-out infinite',
              }}>
                {Math.floor(usdcBalance)} {Math.floor(usdcBalance) === 1 ? 'game' : 'games'} left
              </span>
              <span style={{ color: 'rgba(255,255,255,0.4)' }}>with</span>
              <span style={{
                background: 'linear-gradient(90deg, #00FF87, #00E676, #66FF99, #00E676, #00C853)',
                backgroundSize: '200% 100%',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                animation: 'greenPulse 1.8s ease-in-out infinite',
                filter: 'drop-shadow(0 0 4px rgba(0,230,118,0.3))',
              }}>
                ${usdcBalance.toFixed(2)}
              </span>
            </>
          ) : (
            <>
              <span style={{ color: 'rgba(255,255,255,0.5)' }}>Balance too low</span>
              <span style={{ color: 'rgba(255,255,255,0.3)' }}>&mdash;</span>
              <span style={{
                background: 'linear-gradient(90deg, #FFD740, #FFE082, #FFF8E1, #FFD740, #FF8F00)',
                backgroundSize: '200% 100%',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                animation: 'goldShimmer 2s ease-in-out infinite',
              }}>
                add funds to play
              </span>
            </>
          )}
        </div>
      </button>

      <button
        onClick={() => {
          const text = `I just got swallowed on SwallowMe.gg! ${deathData?.kills || 0} kills before going down.`;
          window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}`);
        }}
        className="bg-gray-700 hover:bg-gray-600 text-white font-bold px-8 py-3 rounded-lg"
        style={{ marginTop: 12 }}
      >
        Share to X
      </button>
    </div>
  ) : null;

  // ─── Cashout Overlay (rendered inside SnakeGame) ───
  const cashoutOverlay = phase === "cashout" ? (
    <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center text-white z-50 animate-fadeIn">
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

      <button
        onClick={handlePlayAgain}
        style={{
          width: '100%',
          maxWidth: 300,
          padding: '16px 0 30px',
          borderRadius: 12,
          border: 'none',
          background: 'linear-gradient(180deg, #FFB3D9, #FF69B4, #FF1493)',
          borderBottom: '4px solid #5C0030',
          color: '#fff',
          fontSize: 17,
          fontWeight: 900,
          cursor: 'pointer',
          letterSpacing: 2,
          position: 'relative' as const,
          overflow: 'hidden',
        }}
      >
        REJOIN LOBBY
        <span style={{
          position: 'absolute', top: 0, left: '-80%', width: '40%', height: '100%',
          background: 'linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.25) 45%, rgba(255,255,255,0.08) 50%, transparent 55%)',
          transform: 'skewX(-20deg)',
          animation: 'shineSweep 2.5s ease-in-out infinite',
          pointerEvents: 'none',
        }} />
        <div style={{
          position: 'absolute', bottom: 7, left: 0, right: 0,
          fontSize: 11, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        }}>
          {Math.floor(usdcBalance) >= 1 ? (
            <>
              <span style={{
                background: 'linear-gradient(90deg, #FFD740, #FFE082, #FFF8E1, #FFD740, #FF8F00)',
                backgroundSize: '200% 100%',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                animation: 'goldShimmer 2s ease-in-out infinite',
              }}>
                {Math.floor(usdcBalance)} {Math.floor(usdcBalance) === 1 ? 'game' : 'games'} left
              </span>
              <span style={{ color: 'rgba(255,255,255,0.4)' }}>with</span>
              <span style={{
                background: 'linear-gradient(90deg, #00FF87, #00E676, #66FF99, #00E676, #00C853)',
                backgroundSize: '200% 100%',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                animation: 'greenPulse 1.8s ease-in-out infinite',
                filter: 'drop-shadow(0 0 4px rgba(0,230,118,0.3))',
              }}>
                ${usdcBalance.toFixed(2)}
              </span>
            </>
          ) : (
            <>
              <span style={{ color: 'rgba(255,255,255,0.5)' }}>Balance too low</span>
              <span style={{ color: 'rgba(255,255,255,0.3)' }}>&mdash;</span>
              <span style={{
                background: 'linear-gradient(90deg, #FFD740, #FFE082, #FFF8E1, #FFD740, #FF8F00)',
                backgroundSize: '200% 100%',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                animation: 'goldShimmer 2s ease-in-out infinite',
              }}>
                add funds to play
              </span>
            </>
          )}
        </div>
      </button>

      <button
        onClick={() => {
          const text = `Just cashed out $${((cashoutData?.amount || 0) / 1_000_000).toFixed(2)} on SwallowMe.gg!`;
          window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}`);
        }}
        className="bg-gray-700 hover:bg-gray-600 text-white font-bold px-8 py-3 rounded-lg"
        style={{ marginTop: 12 }}
      >
        Brag on X
      </button>
    </div>
  ) : null;

  // ─── Playing / Dead / Cashout — canvas stays alive ──
  if ((phase === "playing" || phase === "dead" || phase === "cashout") && room) {
    return (
      <SnakeGame
        room={room}
        onDeath={handleDeath}
        onCashout={handleCashout}
        overlay={deathOverlay || cashoutOverlay}
        voiceEnabled={voiceEnabled}
      />
    );
  }

  return null;
}
