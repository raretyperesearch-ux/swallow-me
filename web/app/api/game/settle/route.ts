import { Keypair, Connection, PublicKey, Transaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from '@solana/spl-token';
import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import bs58 from 'bs58';

const USDC_MINT_ADDR = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

function getTreasury() {
  return {
    pubkey: new PublicKey(process.env.TREASURY_WALLET_ADDRESS!),
    keypair: Keypair.fromSecretKey(bs58.decode(process.env.TREASURY_PRIVATE_KEY!)),
  };
}

const MAX_CASHOUT_MICRO = 100_000_000; // $100
const MAX_KILLS = 999;
const MAX_DURATION_MS = 7_200_000; // 2 hours

export async function POST(req: NextRequest) {
  try {
    // 1. Server auth
    const secret = req.headers.get('x-server-secret');
    if (secret !== process.env.GAME_SERVER_SECRET) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const supabase = getSupabase();
    const body = await req.json();
    const { sessionId, outcome, cashoutAmountMicro, kills, durationMs, diedTo } = body;

    // 2. Validate payload
    if (!sessionId || typeof sessionId !== 'string') {
      return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 });
    }
    if (!['cashout', 'death', 'forfeit'].includes(outcome)) {
      return NextResponse.json({ error: 'Invalid outcome' }, { status: 400 });
    }

    const safeKills = Math.min(Math.max(Math.floor(Number(kills) || 0), 0), MAX_KILLS);
    const safeDuration = Math.min(Math.max(Math.floor(Number(durationMs) || 0), 0), MAX_DURATION_MS);
    let safeCashout = 0;

    if (outcome === 'cashout') {
      safeCashout = Math.floor(Number(cashoutAmountMicro) || 0);
      if (safeCashout < 0 || safeCashout > MAX_CASHOUT_MICRO) {
        return NextResponse.json({ error: 'Invalid cashout amount' }, { status: 400 });
      }
    }

    // 3. Deterministic idempotency
    const idempotencyKey = `settle:${outcome}:${sessionId}`;
    const { data: existingOp } = await supabase
      .from('sm_idempotency')
      .select('response_payload')
      .eq('idempotency_key', idempotencyKey)
      .single();

    if (existingOp?.response_payload) {
      return NextResponse.json(existingOp.response_payload);
    }

    // 4. Get session + verify active
    const { data: session } = await supabase
      .from('sm_sessions')
      .select('id, player_id, status, version, entry_amount_micro')
      .eq('id', sessionId)
      .single();

    if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    if (session.status !== 'active') {
      return NextResponse.json({ error: 'Session already settled: ' + session.status }, { status: 409 });
    }

    // 5. Get player
    const { data: player } = await supabase
      .from('bm_players')
      .select('id, wallet_address, sm_total_games, sm_total_kills, sm_total_earned, sm_best_game')
      .eq('id', session.player_id)
      .single();

    if (!player) return NextResponse.json({ error: 'Player not found' }, { status: 404 });

    let txSignature: string | null = null;

    // 6. CASHOUT — two-phase settlement
    if (outcome === 'cashout' && safeCashout > 0) {
      // Phase 1: active → settling_cashout
      const { data: phase1, error: p1Err } = await supabase
        .from('sm_sessions')
        .update({
          status: 'settling_cashout',
          cashout_amount_micro: safeCashout,
          kills: safeKills,
          duration_ms: safeDuration,
          version: session.version + 1,
        })
        .eq('id', sessionId)
        .eq('status', 'active')
        .eq('version', session.version)
        .select('id')
        .single();

      if (p1Err || !phase1) {
        return NextResponse.json({ error: 'Race: session already settling' }, { status: 409 });
      }

      // Check treasury balance
      const connection = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');
      const USDC_MINT = new PublicKey(USDC_MINT_ADDR);
      const { pubkey: TREASURY, keypair: TREASURY_KEY } = getTreasury();
      const treasuryATA = await getAssociatedTokenAddress(USDC_MINT, TREASURY);

      try {
        const treasuryAcct = await getAccount(connection, treasuryATA);
        if (treasuryAcct.amount < BigInt(safeCashout)) {
          await supabase.from('sm_sessions').update({
            status: 'settlement_failed',
            ended_at: new Date().toISOString(),
          }).eq('id', sessionId);
          return NextResponse.json({ error: 'Treasury insufficient' }, { status: 500 });
        }
      } catch (e) {
        await supabase.from('sm_sessions').update({
          status: 'settlement_failed',
          ended_at: new Date().toISOString(),
        }).eq('id', sessionId);
        return NextResponse.json({ error: 'Treasury check failed' }, { status: 500 });
      }

      // Build transfer: treasury → player
      const playerPubkey = new PublicKey(player.wallet_address);
      const playerATA = await getAssociatedTokenAddress(USDC_MINT, playerPubkey);

      const transferTx = new Transaction();

      // Create player ATA if missing
      try {
        await getAccount(connection, playerATA);
      } catch {
        transferTx.add(
          createAssociatedTokenAccountInstruction(TREASURY, playerATA, playerPubkey, USDC_MINT)
        );
      }

      transferTx.add(
        createTransferInstruction(treasuryATA, playerATA, TREASURY, safeCashout)
      );

      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      transferTx.recentBlockhash = blockhash;
      transferTx.feePayer = TREASURY;
      transferTx.sign(TREASURY_KEY);

      try {
        txSignature = await connection.sendRawTransaction(transferTx.serialize());
        await connection.confirmTransaction(txSignature, 'confirmed');
      } catch (e: any) {
        await supabase.from('sm_sessions').update({
          status: 'settlement_failed',
          cashout_tx_sig: 'FAILED:' + (e.message || 'unknown'),
          ended_at: new Date().toISOString(),
        }).eq('id', sessionId);
        return NextResponse.json({ error: 'Transfer failed' }, { status: 500 });
      }

      // Phase 2: settling_cashout → cashed_out
      await supabase.from('sm_sessions').update({
        status: 'cashed_out',
        cashout_tx_sig: txSignature,
        cashout: true,
        ended_at: new Date().toISOString(),
        version: session.version + 2,
      }).eq('id', sessionId);

    } else {
      // DEATH or FORFEIT — single-phase transition
      const newStatus = outcome === 'death' ? 'dead' : 'forfeited';
      const { data: updated, error: upErr } = await supabase
        .from('sm_sessions')
        .update({
          status: newStatus,
          kills: safeKills,
          duration_ms: safeDuration,
          died_to: (typeof diedTo === 'string' && diedTo.length <= 50) ? diedTo : null,
          cashout_amount_micro: 0,
          ended_at: new Date().toISOString(),
          version: session.version + 1,
        })
        .eq('id', sessionId)
        .eq('status', 'active')
        .eq('version', session.version)
        .select('id')
        .single();

      if (upErr || !updated) {
        return NextResponse.json({ error: 'Race: session already settled' }, { status: 409 });
      }
    }

    // 7. Record transaction
    const txType = outcome === 'cashout' ? 'sm_cashout' : outcome === 'death' ? 'sm_death' : 'sm_forfeit';
    await supabase.from('bm_transactions').insert({
      player_id: player.id,
      tx_type: txType,
      amount: safeCashout / 1_000_000,
      amount_micro: safeCashout,
      tx_signature: txSignature,
      game: 'swallow_me',
      status: txSignature ? 'confirmed' : 'recorded',
    });

    // 8. Update player stats
    const earnedDelta = safeCashout / 1_000_000;
    const newEarned = Number(player.sm_total_earned || 0) + earnedDelta;
    const newBest = Math.max(Number(player.sm_best_game || 0), earnedDelta);

    await supabase.from('bm_players').update({
      sm_total_games: (player.sm_total_games || 0) + 1,
      sm_total_kills: (player.sm_total_kills || 0) + safeKills,
      sm_total_earned: newEarned,
      sm_best_game: newBest,
      last_active_at: new Date().toISOString(),
    }).eq('id', player.id);

    // 8b. Record referral earning from the 10% rake
    if (outcome === 'cashout' && safeCashout > 0) {
      try {
        // Calculate the rake: cashout is 90% of raw value, so rake = cashout / 9
        const rakeDollars = (safeCashout / 9) / 1_000_000;

        if (rakeDollars > 0.001) {
          await supabase.rpc('record_referral_earning', {
            p_player_id: player.id,
            p_round_id: sessionId,
            p_buy_in_amount: 1.00,
            p_fee_amount: rakeDollars,
          });
          console.log('[SETTLE] Referral earning recorded: ' + rakeDollars.toFixed(4) + ' for player:', player.id);
        }
      } catch (refErr) {
        // Don't fail the cashout over referral tracking
        console.error('[SETTLE] Referral earning failed (non-fatal):', refErr);
      }
    }

    // 9. Clear enter idempotency so player can re-enter
    await supabase.from('sm_idempotency').delete().eq('idempotency_key', `enter:${player.id}`);

    // 10. Save settle idempotency
    const responsePayload = {
      success: true,
      outcome,
      txSignature,
      cashoutAmountMicro: safeCashout,
    };

    await supabase.from('sm_idempotency').insert({
      idempotency_key: idempotencyKey,
      player_id: player.id,
      operation: 'settle_' + outcome,
      status: 'completed',
      response_payload: responsePayload,
      tx_signature: txSignature,
    });

    return NextResponse.json(responsePayload);

  } catch (error: any) {
    console.error('[SETTLE] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal error' }, { status: 500 });
  }
}
