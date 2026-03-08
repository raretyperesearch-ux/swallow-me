use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer};

declare_id!("SW4LLowMeXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");

pub mod state;
pub mod instructions;
pub mod errors;

use state::*;
use errors::*;

#[program]
pub mod swallow_me {
    use super::*;

    /// Initialize a new game lobby
    pub fn init_lobby(
        ctx: Context<InitLobby>,
        lobby_id: [u8; 32],
        tier: u8,
        entry_amount: u64,
        rake_bps: u16,
    ) -> Result<()> {
        let lobby = &mut ctx.accounts.lobby;
        lobby.lobby_id = lobby_id;
        lobby.tier = tier;
        lobby.entry_amount = entry_amount;
        lobby.rake_bps = rake_bps;
        lobby.player_count = 0;
        lobby.is_active = true;
        lobby.created_at = Clock::get()?.unix_timestamp;
        lobby.authority = ctx.accounts.authority.key();
        lobby.treasury = ctx.accounts.treasury.key();
        lobby.usdc_vault = ctx.accounts.usdc_vault.key();
        lobby.bump = ctx.bumps.lobby;
        Ok(())
    }

    /// Player joins a lobby by escrowing USDC
    pub fn join_lobby(
        ctx: Context<JoinLobby>,
        _lobby_id: [u8; 32],
    ) -> Result<()> {
        let lobby = &ctx.accounts.lobby;
        require!(lobby.is_active, SwallowError::LobbyInactive);

        let escrow = &mut ctx.accounts.player_escrow;
        escrow.lobby = lobby.key();
        escrow.wallet = ctx.accounts.player.key();
        escrow.current_value = lobby.entry_amount;
        escrow.is_alive = true;
        escrow.joined_at = Clock::get()?.unix_timestamp;
        escrow.bump = ctx.bumps.player_escrow;

        // Transfer USDC from player to vault
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.player_usdc.to_account_info(),
                to: ctx.accounts.usdc_vault.to_account_info(),
                authority: ctx.accounts.player.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, lobby.entry_amount)?;

        // Increment player count
        let lobby = &mut ctx.accounts.lobby;
        lobby.player_count += 1;

        msg!("Player {} joined lobby tier {} with {} USDC",
            ctx.accounts.player.key(),
            lobby.tier,
            lobby.entry_amount
        );

        Ok(())
    }

    /// Settle a kill — transfer victim's value to killer (minus rake)
    /// Only callable by the authorized cranker
    pub fn settle_kill(
        ctx: Context<SettleKill>,
        _lobby_id: [u8; 32],
        payout_amount: u64,
        rake_amount: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.lobby.authority,
            SwallowError::Unauthorized
        );

        let victim_escrow = &mut ctx.accounts.victim_escrow;
        require!(victim_escrow.is_alive, SwallowError::PlayerDead);

        let killer_escrow = &mut ctx.accounts.killer_escrow;
        require!(killer_escrow.is_alive, SwallowError::PlayerDead);

        // Validate amounts
        require!(
            payout_amount + rake_amount <= victim_escrow.current_value,
            SwallowError::InsufficientFunds
        );

        // Update escrow balances
        victim_escrow.current_value = 0;
        victim_escrow.is_alive = false;
        killer_escrow.current_value += payout_amount;

        // Transfer rake to treasury from vault (PDA signer)
        let lobby_id = ctx.accounts.lobby.lobby_id;
        let bump = ctx.accounts.lobby.bump;
        let seeds = &[b"lobby" as &[u8], lobby_id.as_ref(), &[bump]];
        let signer = &[&seeds[..]];

        let rake_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.usdc_vault.to_account_info(),
                to: ctx.accounts.treasury_usdc.to_account_info(),
                authority: ctx.accounts.lobby.to_account_info(),
            },
            signer,
        );
        token::transfer(rake_ctx, rake_amount)?;

        msg!("Kill settled: {} → killer +{}, rake {}",
            ctx.accounts.victim_escrow.wallet,
            payout_amount,
            rake_amount
        );

        Ok(())
    }

    /// Player cashes out their current balance
    pub fn cashout(
        ctx: Context<Cashout>,
        _lobby_id: [u8; 32],
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.lobby.authority,
            SwallowError::Unauthorized
        );

        let escrow = &mut ctx.accounts.player_escrow;
        require!(escrow.is_alive, SwallowError::PlayerDead);
        require!(escrow.current_value > 0, SwallowError::InsufficientFunds);

        let amount = escrow.current_value;
        escrow.current_value = 0;
        escrow.is_alive = false;

        // Transfer from vault to player wallet
        let lobby_id = ctx.accounts.lobby.lobby_id;
        let bump = ctx.accounts.lobby.bump;
        let seeds = &[b"lobby" as &[u8], lobby_id.as_ref(), &[bump]];
        let signer = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.usdc_vault.to_account_info(),
                to: ctx.accounts.player_usdc.to_account_info(),
                authority: ctx.accounts.lobby.to_account_info(),
            },
            signer,
        );
        token::transfer(transfer_ctx, amount)?;

        let lobby = &mut ctx.accounts.lobby;
        lobby.player_count = lobby.player_count.saturating_sub(1);

        msg!("Cashout: {} withdrew {} USDC", escrow.wallet, amount);

        Ok(())
    }

    /// Forfeit — player dies to wall or disconnect. Value goes to rake.
    pub fn forfeit(
        ctx: Context<Forfeit>,
        _lobby_id: [u8; 32],
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.lobby.authority,
            SwallowError::Unauthorized
        );

        let escrow = &mut ctx.accounts.player_escrow;
        require!(escrow.is_alive, SwallowError::PlayerDead);

        let amount = escrow.current_value;
        escrow.current_value = 0;
        escrow.is_alive = false;

        // Forfeit value goes to treasury as rake
        let lobby_id = ctx.accounts.lobby.lobby_id;
        let bump = ctx.accounts.lobby.bump;
        let seeds = &[b"lobby" as &[u8], lobby_id.as_ref(), &[bump]];
        let signer = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.usdc_vault.to_account_info(),
                to: ctx.accounts.treasury_usdc.to_account_info(),
                authority: ctx.accounts.lobby.to_account_info(),
            },
            signer,
        );
        token::transfer(transfer_ctx, amount)?;

        let lobby = &mut ctx.accounts.lobby;
        lobby.player_count = lobby.player_count.saturating_sub(1);

        msg!("Forfeit: {} lost {} USDC", escrow.wallet, amount);

        Ok(())
    }

    /// Admin closes a lobby
    pub fn close_lobby(
        ctx: Context<CloseLobby>,
        _lobby_id: [u8; 32],
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.lobby.authority,
            SwallowError::Unauthorized
        );

        let lobby = &mut ctx.accounts.lobby;
        lobby.is_active = false;

        msg!("Lobby closed: tier {}", lobby.tier);
        Ok(())
    }
}

// ─── Account Contexts ─────────────────────────────────────

#[derive(Accounts)]
#[instruction(lobby_id: [u8; 32])]
pub struct InitLobby<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + SwallowLobby::INIT_SPACE,
        seeds = [b"lobby", lobby_id.as_ref()],
        bump
    )]
    pub lobby: Account<'info, SwallowLobby>,

    #[account(
        init,
        payer = authority,
        token::mint = usdc_mint,
        token::authority = lobby,
        seeds = [b"vault", lobby_id.as_ref()],
        bump
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,
    /// CHECK: Treasury wallet
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(lobby_id: [u8; 32])]
pub struct JoinLobby<'info> {
    #[account(
        mut,
        seeds = [b"lobby", lobby_id.as_ref()],
        bump = lobby.bump
    )]
    pub lobby: Account<'info, SwallowLobby>,

    #[account(
        init,
        payer = player,
        space = 8 + PlayerEscrow::INIT_SPACE,
        seeds = [b"player", lobby.key().as_ref(), player.key().as_ref()],
        bump
    )]
    pub player_escrow: Account<'info, PlayerEscrow>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = lobby,
        seeds = [b"vault", lobby_id.as_ref()],
        bump
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub player_usdc: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,

    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(lobby_id: [u8; 32])]
pub struct SettleKill<'info> {
    #[account(
        seeds = [b"lobby", lobby_id.as_ref()],
        bump = lobby.bump
    )]
    pub lobby: Account<'info, SwallowLobby>,

    #[account(mut)]
    pub killer_escrow: Account<'info, PlayerEscrow>,

    #[account(mut)]
    pub victim_escrow: Account<'info, PlayerEscrow>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = lobby,
        seeds = [b"vault", lobby_id.as_ref()],
        bump
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub treasury_usdc: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(lobby_id: [u8; 32])]
pub struct Cashout<'info> {
    #[account(
        mut,
        seeds = [b"lobby", lobby_id.as_ref()],
        bump = lobby.bump
    )]
    pub lobby: Account<'info, SwallowLobby>,

    #[account(mut)]
    pub player_escrow: Account<'info, PlayerEscrow>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = lobby,
        seeds = [b"vault", lobby_id.as_ref()],
        bump
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub player_usdc: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(lobby_id: [u8; 32])]
pub struct Forfeit<'info> {
    #[account(
        mut,
        seeds = [b"lobby", lobby_id.as_ref()],
        bump = lobby.bump
    )]
    pub lobby: Account<'info, SwallowLobby>,

    #[account(mut)]
    pub player_escrow: Account<'info, PlayerEscrow>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = lobby,
        seeds = [b"vault", lobby_id.as_ref()],
        bump
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub treasury_usdc: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(lobby_id: [u8; 32])]
pub struct CloseLobby<'info> {
    #[account(
        mut,
        seeds = [b"lobby", lobby_id.as_ref()],
        bump = lobby.bump
    )]
    pub lobby: Account<'info, SwallowLobby>,

    pub authority: Signer<'info>,
}
