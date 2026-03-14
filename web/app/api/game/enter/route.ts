import { PrivyClient } from '@privy-io/node';
import { Connection, PublicKey } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

function getPrivy() {
  return new PrivyClient({
    appId: process.env.NEXT_PUBLIC_PRIVY_APP_ID!,
    appSecret: process.env.PRIVY_APP_SECRET!,
  });
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const TREASURY = '53Qy2ygocLjKWbtjgaepzHfZnf9oiZENJPWMnNUkSz8L';
const ENTRY_MICRO = 1_000_000; // $1.00
const RAKE_MICRO = 100_000;    // $0.10

export async function POST(req: NextRequest) {
  try {
    const privy = getPrivy();
    const supabase = getSupabase();

    // 1. Auth
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { user_id } = await privy.utils().auth().verifyAuthToken(authHeader.slice(7));

    // 2. Get wallet
    const user = await privy.users()._get(user_id);
    const solWallet = user.linked_accounts.find(
      (a: any) => a.type === 'wallet' && 'chain_type' in a && a.chain_type === 'solana' && 'wallet_client' in a && a.wallet_client === 'privy'
    ) as any;
    if (!solWallet) return NextResponse.json({ error: 'No Solana wallet' }, { status: 400 });
    const playerAddress: string = solWallet.address;

    // 3. Get player
    const { data: player } = await supabase
      .from('bm_players')
      .select('id, username, wallet_address')
      .eq('wallet_address', playerAddress)
      .single();

    if (!player) return NextResponse.json({ error: 'Register first' }, { status: 404 });
    if (!player.username) return NextResponse.json({ error: 'Set username first' }, { status: 400 });

    // 4. Get tx signature from client
    const body = await req.json();
    const { txSignature } = body;
    if (!txSignature || typeof txSignature !== 'string') {
      return NextResponse.json({ error: 'Missing transaction signature' }, { status: 400 });
    }

    // 5. Verify transaction on-chain (with retries for slow propagation)
    const connection = new Connection(
      process.env.SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );

    let txInfo = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        txInfo = await connection.getParsedTransaction(txSignature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if (txInfo) break;
      } catch (e) {
        console.log('[ENTER] Tx lookup attempt', attempt + 1, 'failed, retrying...');
      }
      if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
    }

    if (!txInfo) {
      return NextResponse.json({ error: 'Transaction not found yet. Please retry.' }, { status: 400 });
    }

    if (txInfo.meta?.err) {
      return NextResponse.json({ error: 'Transaction failed on-chain' }, { status: 400 });
    }

    // Basic verification: check the transaction is recent (within last 10 minutes)
    const txTime = txInfo.blockTime ? txInfo.blockTime * 1000 : 0;
    if (Date.now() - txTime > 600_000) {
      return NextResponse.json({ error: 'Transaction too old' }, { status: 400 });
    }

    // 5b. Verify transfer: $1 USDC to treasury
    const TREASURY_ADDRESS = '53Qy2ygocLjKWbtjgaepzHfZnf9oiZENJPWMnNUkSz8L';
    const USDC_MINT_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const REQUIRED_AMOUNT = 1_000_000;

    let transferVerified = false;

    if (txInfo.meta?.postTokenBalances && txInfo.meta?.preTokenBalances) {
      for (const post of txInfo.meta.postTokenBalances) {
        if (post.mint === USDC_MINT_ADDRESS && post.owner === TREASURY_ADDRESS) {
          const pre = txInfo.meta.preTokenBalances.find(
            (p: any) => p.accountIndex === post.accountIndex
          );
          const preAmount = pre?.uiTokenAmount?.amount ? parseInt(pre.uiTokenAmount.amount) : 0;
          const postAmount = post.uiTokenAmount?.amount ? parseInt(post.uiTokenAmount.amount) : 0;
          const diff = postAmount - preAmount;
          if (diff >= REQUIRED_AMOUNT) {
            transferVerified = true;
          }
        }
      }
    }

    if (!transferVerified) {
      return NextResponse.json({ error: 'Invalid transfer: must be $1 USDC to treasury' }, { status: 400 });
    }

    // 5c. Verify player signed the transaction
    const signers = txInfo.transaction?.message?.accountKeys?.filter((k: any) => k.signer) || [];
    const playerSigned = signers.some((k: any) => k.pubkey?.toString() === playerAddress);
    if (!playerSigned) {
      return NextResponse.json({ error: 'Transaction not signed by your wallet' }, { status: 400 });
    }

    // 6. Auto-forfeit stale active sessions before creating a new one
    const { data: activeSession } = await supabase
      .from('sm_sessions')
      .select('id, created_at')
      .eq('player_id', player.id)
      .eq('status', 'active')
      .single();

    if (activeSession) {
      const sessionAge = Date.now() - new Date(activeSession.created_at).getTime();
      const TEN_MINUTES = 10 * 60 * 1000;

      if (sessionAge > TEN_MINUTES) {
        // Auto-forfeit stale session so player can re-enter
        await supabase
          .from('sm_sessions')
          .update({ status: 'forfeited', ended_at: new Date().toISOString(), version: 2 })
          .eq('id', activeSession.id)
          .eq('status', 'active');

        // Clear stale enter idempotency
        await supabase.from('sm_idempotency').delete().eq('idempotency_key', `enter:${player.id}`);

        console.log('[ENTER] Auto-forfeited stale session:', activeSession.id);
      } else {
        return NextResponse.json({ error: 'Already in an active game' }, { status: 409 });
      }
    }

    // Create session (unique index prevents double-join)
    const { data: session, error: sessErr } = await supabase
      .from('sm_sessions')
      .insert({
        player_id: player.id,
        status: 'active',
        entry_amount_micro: ENTRY_MICRO,
        entry_tx_sig: txSignature,
      })
      .select('id')
      .single();

    if (sessErr) {
      if (sessErr.code === '23505') {
        if (sessErr.message?.includes('entry_tx')) {
          return NextResponse.json({ error: 'This transaction was already used' }, { status: 409 });
        }
        return NextResponse.json({ error: 'Already in a game' }, { status: 409 });
      }
      throw sessErr;
    }

    // 7. Record transaction
    await supabase.from('bm_transactions').insert({
      player_id: player.id,
      tx_type: 'sm_entry',
      amount: ENTRY_MICRO / 1_000_000,
      amount_micro: ENTRY_MICRO,
      tx_signature: txSignature,
      game: 'swallow_me',
      status: 'confirmed',
    });

    // 8. Idempotency
    const idempotencyKey = `enter:${player.id}`;
    const responsePayload = {
      success: true,
      sessionId: session.id,
      txSignature,
      wallet: playerAddress,
      username: player.username,
      playerId: player.id,
      arenaValueMicro: ENTRY_MICRO - RAKE_MICRO,
    };

    await supabase.from('sm_idempotency').delete().eq('idempotency_key', idempotencyKey);
    await supabase.from('sm_idempotency').insert({
      idempotency_key: idempotencyKey,
      player_id: player.id,
      operation: 'enter',
      status: 'completed',
      response_payload: responsePayload,
      tx_signature: txSignature,
    });

    return NextResponse.json(responsePayload);

  } catch (error: any) {
    console.error('[ENTER] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal error' }, { status: 500 });
  }
}
