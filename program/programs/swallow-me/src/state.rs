use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct SwallowLobby {
    pub lobby_id: [u8; 32],       // Unique lobby identifier
    pub tier: u8,                  // 1, 5, or 20
    pub entry_amount: u64,         // USDC amount in lamports (6 decimals)
    pub rake_bps: u16,             // Basis points (800 = 8%)
    pub player_count: u16,         // Active players
    pub is_active: bool,           // Lobby accepting new players
    pub created_at: i64,           // Unix timestamp
    pub authority: Pubkey,         // Cranker wallet (can settle kills, cashouts)
    pub treasury: Pubkey,          // Rake destination wallet
    pub usdc_vault: Pubkey,        // PDA token account holding escrowed USDC
    pub bump: u8,                  // PDA bump seed
}

#[account]
#[derive(InitSpace)]
pub struct PlayerEscrow {
    pub lobby: Pubkey,             // Associated lobby
    pub wallet: Pubkey,            // Player's wallet
    pub current_value: u64,        // Current USDC balance (updated on kills)
    pub is_alive: bool,            // Still in the game
    pub joined_at: i64,            // Unix timestamp
    pub bump: u8,                  // PDA bump seed
}
