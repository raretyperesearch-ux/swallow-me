import type { Metadata, Viewport } from "next";
import "./globals.css";

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
      <body className="bg-[#0a0a1a] text-white antialiased">
        {children}
      </body>
    </html>
  );
}
