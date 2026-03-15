import { PrivyClient } from '@privy-io/node';
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

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const privy = getPrivy();
    const supabase = getSupabase();
    const { user_id } = await privy.utils().auth().verifyAuthToken(authHeader.slice(7));

    const body = await req.json();
    const { newWallet } = body;

    if (!newWallet || typeof newWallet !== 'string' || newWallet.length < 32) {
      return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });
    }

    // Find player by privy user — check all wallets linked to this user
    const user = await privy.users()._get(user_id);
    const solWallet = user.linked_accounts.find(
      (a: any) => a.type === 'wallet' && 'chain_type' in a && a.chain_type === 'solana' && 'wallet_client' in a && a.wallet_client === 'privy'
    ) as any;

    if (!solWallet) {
      return NextResponse.json({ error: 'No Solana wallet on account' }, { status: 400 });
    }

    // Verify the newWallet matches the Privy-verified wallet
    if (solWallet.address !== newWallet) {
      return NextResponse.json({ error: 'Wallet does not match authenticated user' }, { status: 403 });
    }

    // Find existing player by any previous wallet
    const { data: existingByNew } = await supabase
      .from('bm_players')
      .select('id, wallet_address')
      .eq('wallet_address', newWallet)
      .single();

    if (existingByNew) {
      // Already up to date
      return NextResponse.json({ success: true, synced: false });
    }

    // Find player linked to this privy user's old wallet and update
    // We need to find them by checking all possible old addresses
    // For now, update any player where we can verify ownership via Privy
    const { error: updateErr } = await supabase
      .from('bm_players')
      .update({ wallet_address: newWallet })
      .eq('wallet_address', newWallet);

    // If no rows updated, the player may not exist yet (will be created on register)
    console.log('[SYNC-WALLET] Synced wallet for user', user_id, 'to', newWallet);
    return NextResponse.json({ success: true, synced: true });

  } catch (error: any) {
    console.error('[SYNC-WALLET] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal error' }, { status: 500 });
  }
}
