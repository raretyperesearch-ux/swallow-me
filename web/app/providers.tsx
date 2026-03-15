'use client';
import { PrivyProvider } from '@privy-io/react-auth';

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

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
        } as any,
      } as any}
    >
      {children}
    </PrivyProvider>
  );
}
