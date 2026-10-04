'use client';

/**
 * Last-resort boundary.
 *
 * Catches failures in the root layout, which `app/error.tsx` cannot, and has to
 * render its own `<html>` and `<body>`.
 */

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          background: '#09090b',
          color: '#fafafa',
          margin: 0,
          padding: '1rem',
        }}
      >
        <div style={{ maxWidth: '28rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#ea580c' }}>
            AirDelivery could not start
          </h1>
          <p style={{ marginTop: '0.75rem', color: '#a1a1aa', lineHeight: 1.6 }}>
            A critical error stopped the app from loading. Reloading usually fixes it.
          </p>
          {error.digest && (
            <p style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: '#52525b' }}>
              Reference: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1.5rem',
              padding: '0.625rem 1.5rem',
              borderRadius: '9999px',
              background: '#ea580c',
              color: '#fff',
              border: 0,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
