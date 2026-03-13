import { ImageResponse } from 'next/og';

export const runtime = 'edge';

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '1200px',
          height: '630px',
          display: 'flex',
          background: '#0c0610',
          fontFamily: 'sans-serif',
        }}
      >
        {/* Left side */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            padding: '56px',
          }}
        >
          <div style={{ fontSize: '18px', letterSpacing: '4px', color: '#FF69B4', marginBottom: '16px' }}>
            REAL MONEY GAMING
          </div>
          <div style={{ fontSize: '72px', fontWeight: 900, color: '#ffffff', letterSpacing: '3px', lineHeight: 1.1 }}>
            SWALLOW
          </div>
          <div style={{ fontSize: '72px', fontWeight: 900, color: '#FF69B4', letterSpacing: '3px', lineHeight: 1.1, marginBottom: '24px' }}>
            ME
          </div>
          <div style={{ fontSize: '24px', color: '#888888', lineHeight: 1.6, marginBottom: '28px' }}>
            Play for $1. Eat snakes to grow your
          </div>
          <div style={{ fontSize: '24px', color: '#888888', lineHeight: 1.6, marginBottom: '28px', marginTop: '-16px' }}>
            balance. Cash out real money.
          </div>
          <div
            style={{
              background: 'linear-gradient(90deg, #FF69B4, #FF1493)',
              padding: '14px 36px',
              borderRadius: '12px',
              fontSize: '22px',
              fontWeight: 800,
              color: '#ffffff',
              letterSpacing: '1px',
              display: 'flex',
              alignSelf: 'flex-start',
            }}
          >
            PLAY NOW — $1 TO START
          </div>
        </div>

        {/* Right pink panel */}
        <div
          style={{
            width: '380px',
            background: 'linear-gradient(180deg, #C71585, #FF1493, #FF69B4)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '36px',
            padding: '40px',
          }}
        >
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ fontSize: '56px', fontWeight: 900, color: '#ffffff' }}>$1</div>
            <div style={{ fontSize: '16px', color: 'rgba(255,255,255,0.7)', letterSpacing: '2px' }}>TO PLAY</div>
          </div>

          <div style={{ width: '60px', height: '2px', background: 'rgba(255,255,255,0.2)' }} />

          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ fontSize: '26px', fontWeight: 800, color: '#ffffff', lineHeight: 1.3 }}>CASH OUT</div>
            <div style={{ fontSize: '26px', fontWeight: 800, color: '#ffffff', lineHeight: 1.3 }}>ANYTIME</div>
            <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.7)', letterSpacing: '2px', marginTop: '6px' }}>REAL MONEY</div>
          </div>

          <div style={{ width: '60px', height: '2px', background: 'rgba(255,255,255,0.2)' }} />

          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ fontSize: '26px', fontWeight: 800, color: '#ffffff', lineHeight: 1.3 }}>REFER &</div>
            <div style={{ fontSize: '26px', fontWeight: 800, color: '#ffffff', lineHeight: 1.3 }}>EARN</div>
            <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.7)', letterSpacing: '2px', marginTop: '6px' }}>30% BACK</div>
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}
