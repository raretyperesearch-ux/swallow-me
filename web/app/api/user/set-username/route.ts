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
    const { user_id } = await privy.utils().auth().verifyAuthToken(authHeader.slice(7));

    const user = await privy.users()._get(user_id);
    const solWallet = user.linked_accounts.find(
      (a) => a.type === 'wallet' && 'chain_type' in a && a.chain_type === 'solana' && 'wallet_client' in a && a.wallet_client === 'privy'
    );
    if (!solWallet) return NextResponse.json({ error: 'No wallet' }, { status: 400 });

    const { username } = await req.json();

    // Validate
    if (!username || typeof username !== 'string') {
      return NextResponse.json({ error: 'Username required' }, { status: 400 });
    }
    const trimmed = username.trim();
    if (trimmed.length < 3 || trimmed.length > 16) {
      return NextResponse.json({ error: 'Username must be 3-16 characters' }, { status: 400 });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      return NextResponse.json({ error: 'Letters, numbers, underscores only' }, { status: 400 });
    }

    // Check player exists and has no username
    const { data: player } = await supabase
      .from('bm_players')
      .select('id, username')
      .eq('wallet_address', solWallet.address)
      .single();

    if (!player) return NextResponse.json({ error: 'Player not found' }, { status: 404 });
    if (player.username) return NextResponse.json({ error: 'Username already set' }, { status: 400 });

    // Set (unique constraint in DB handles race)
    const { error } = await supabase
      .from('bm_players')
      .update({ username: trimmed, display_name: trimmed })
      .eq('id', player.id)
      .is('username', null);

    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: 'Username taken' }, { status: 409 });
      throw error;
    }

    return NextResponse.json({ success: true, username: trimmed });

  } catch (error: any) {
    console.error('[SET-USERNAME] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
