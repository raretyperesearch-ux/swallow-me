use anchor_lang::prelude::*;

#[error_code]
pub enum SwallowError {
    #[msg("Lobby is not active")]
    LobbyInactive,

    #[msg("Player is already dead")]
    PlayerDead,

    #[msg("Insufficient funds in escrow")]
    InsufficientFunds,

    #[msg("Unauthorized: only the lobby authority can call this")]
    Unauthorized,

    #[msg("Invalid tier")]
    InvalidTier,

    #[msg("Lobby is full")]
    LobbyFull,

    #[msg("Player already in lobby")]
    AlreadyInLobby,

    #[msg("Invalid amount")]
    InvalidAmount,
}
