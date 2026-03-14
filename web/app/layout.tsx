import type { Metadata, Viewport } from "next";
import "./globals.css";
import Providers from "./providers";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";

export const metadata: Metadata = {
  title: 'Swallow Me | Real-Money Snake Game',
  description: 'Play for $1. Eat other players to grow your balance. Cash out real money anytime. No download needed.',
  metadataBase: new URL('https://swallowme.ibuy.money'),
  openGraph: {
    title: 'Swallow Me | The Snake Game That Pays Real Money',
    description: 'Play for $1. Eat other players to grow your balance. Cash out real money straight to your wallet. No app download needed.',
    url: 'https://swallowme.ibuy.money',
    siteName: 'BuyMoney Games',
    type: 'website',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Swallow Me - Real Money Snake Game',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Swallow Me | The Snake Game That Pays Real Money',
    description: 'Play for $1. Eat other players. Cash out real money anytime. No download needed.',
    images: ['/og-image.png'],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Swallow Me",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Russo+One&display=swap" rel="stylesheet" />
      </head>
      <body className="bg-[#0a0a1a] text-white antialiased">
        <Providers>{children}</Providers>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
