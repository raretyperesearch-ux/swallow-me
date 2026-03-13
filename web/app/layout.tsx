import type { Metadata, Viewport } from "next";
import "./globals.css";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "Swallow Me | Real-Money Snake PvP",
  description: "Stake USDC. Eat snakes. Cash out. A BuyMoney game.",
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
      </body>
    </html>
  );
}
