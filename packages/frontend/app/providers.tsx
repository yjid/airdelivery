'use client';

/**
 * Client providers.
 *
 * Order matters: `SocketProvider` owns the connection and must wrap
 * `WebRTCProvider`, which reads it. Previously `providers.tsx` mounted only
 * `WebRTCProvider`, and `SocketProvider` was mounted separately in
 * `layout.tsx` — two entry points for the same context, easy to get wrong and
 * impossible to reason about from one file.
 */

import type { ReactNode } from 'react';
import { SocketProvider } from '@/context/socketContext';
import { WebRTCProvider } from '@/context/WebRTCContext';

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <SocketProvider>
      <WebRTCProvider>{children}</WebRTCProvider>
    </SocketProvider>
  );
}
