import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Swallow Me | Real-Money Snake PvP",
  description: "Stake USDC. Eat snakes. Cash out. A BuyMoney game.",
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
