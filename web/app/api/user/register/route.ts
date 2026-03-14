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
    process.env.SUPABASE_SERVICE_ROLE_KEY!
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
    const body = await req.json().catch(() => ({}));
    const { user_id } = await privy.utils().auth().verifyAuthToken(authHeader.slice(7));

    const user = await privy.users()._get(user_id);
    const solWallet = user.linked_accounts.find(
      (a) => a.type === 'wallet' && 'chain_type' in a && a.chain_type === 'solana' && 'wallet_client' in a && a.wallet_client === 'privy'
    );
    if (!solWallet) {
      return NextResponse.json({
        error: 'No Solana wallet',
        retry: true,
        message: 'Your wallet is being created. Please wait a moment.',
      }, { status: 400 });
    }
    const walletAddress = solWallet.address;

    // Check existing
    const { data: existing } = await supabase
      .from('bm_players')
      .select('id, username, wallet_address, referral_code, total_referrals, total_referral_earnings')
      .eq('wallet_address', walletAddress)
      .single();

    if (existing) return NextResponse.json({ player: existing, isNew: false });

    // Create
    const { data: newPlayer, error } = await supabase
      .from('bm_players')
      .insert({
        wallet_address: walletAddress,
        total_rounds_played: 0,
        total_wins: 0,
        total_eliminations: 0,
        total_deposited: 0,
        total_earned: 0,
        total_spent: 0,
        sm_total_games: 0,
        sm_total_kills: 0,
        sm_total_earned: 0,
        sm_best_game: 0,
      })
      .select('id, username, wallet_address, referral_code, total_referrals, total_referral_earnings')
      .single();

    if (error) throw error;

    // Apply referral code for new players only
    if (body.referralCode && newPlayer) {
      try {
        const { error: refError } = await supabase.rpc('apply_referral_code', {
          p_code: body.referralCode,
          p_wallet: walletAddress,
        });
        if (refError) {
          console.error('[REGISTER] Referral apply error:', refError);
        } else {
          console.log('[REGISTER] Applied referral code:', body.referralCode, 'for wallet:', walletAddress);
        }
      } catch (refErr) {
        console.error('[REGISTER] Referral apply failed (non-fatal):', refErr);
      }
    }

    return NextResponse.json({ player: newPlayer, isNew: true });

  } catch (error: any) {
    console.error('[REGISTER] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
