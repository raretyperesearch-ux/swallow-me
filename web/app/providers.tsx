'use client';
import { PrivyProvider } from '@privy-io/react-auth';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const SOLANA_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const SOLANA_WS_URL = SOLANA_RPC_URL.startsWith('https://')
  ? SOLANA_RPC_URL.replace('https://', 'wss://')
  : SOLANA_RPC_URL.startsWith('http://')
    ? SOLANA_RPC_URL.replace('http://', 'ws://')
    : SOLANA_RPC_URL;

export default function Providers({ children }: { children: React.ReactNode }) {
  if (!PRIVY_APP_ID) {
    return <>{children}</>;
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['email', 'google', 'sms'],
        appearance: {
          theme: 'dark',
          accentColor: '#FF69B4',
        },
        embeddedWallets: {
          solana: {
            createOnLogin: 'all-users',
          },
          waitForTransactionConfirmation: false,
        },
        solana: {
          rpcs: {
            'solana:mainnet': {
              rpc: createSolanaRpc(SOLANA_RPC_URL),
              rpcSubscriptions: createSolanaRpcSubscriptions(SOLANA_WS_URL),
              blockExplorerUrl: 'https://explorer.solana.com',
            },
          },
        },
      } as any}
    >
      {children}
    </PrivyProvider>
  );
}
