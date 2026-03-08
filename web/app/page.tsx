import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center text-center px-4">
      <h1 className="text-7xl font-black mb-4 bg-gradient-to-r from-green-400 to-emerald-300 bg-clip-text text-transparent">
        SWALLOW ME
      </h1>
      <p className="text-xl text-gray-400 mb-2">
        Real-money snake PvP on Solana
      </p>
      <p className="text-gray-600 mb-10">
        Stake USDC → Eat other snakes → Cash out your winnings
      </p>

      <Link
        href="/play"
        className="bg-green-500 hover:bg-green-400 text-black font-bold text-2xl px-16 py-5 rounded-xl transition-all hover:scale-105"
      >
        PLAY NOW
      </Link>

      <div className="flex gap-8 mt-12 text-gray-500 text-sm">
        <div className="text-center">
          <div className="text-2xl font-bold text-white">$1 / $5 / $20</div>
          <div>Stake tiers</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-white">USDC</div>
          <div>Stable stakes</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-white">Instant</div>
          <div>Cash out</div>
        </div>
      </div>

      <p className="text-gray-700 text-xs mt-16">
        A <a href="https://ibuy.money" className="text-gray-500 hover:text-white">BuyMoney</a> game • 18+
      </p>
    </div>
  );
}
