import type { Metadata, Viewport } from 'next';
import { Inter, Geist_Mono } from 'next/font/google';
import Script from 'next/script';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';
import Providers from './providers';
import Header from '@/components/header';
import FooterStrip from '@/components/footer';

const SITE_URL = 'https://airdelivery.site';
const GA_ID = process.env.NEXT_PUBLIC_GA_ID;
const ADSENSE_ID = process.env.NEXT_PUBLIC_ADSENSE_ID;

const inter = Inter({ variable: '--font-sans', subsets: ['latin'], display: 'swap' });
const geistMono = Geist_Mono({ variable: '--font-mono', subsets: ['latin'], display: 'swap' });

const DESCRIPTION =
  'Send files instantly and privately, peer to peer over WebRTC. No uploads, no sign-up, no size limits. Your files never touch a server.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'AirDelivery — Private P2P File Transfer', template: '%s | AirDelivery' },
  description: DESCRIPTION,
  applicationName: 'AirDelivery',
  keywords: [
    'send large files',
    'peer to peer file sharing',
    'p2p file transfer',
    'webrtc file transfer',
    'airdrop alternative',
    'sharedrop alternative',
    'snapdrop alternative',
    'wormhole alternative',
    'file transfer without cloud',
    'private file sharing',
    'no signup file transfer',
    'large file transfer online',
    'encrypted file sharing',
    'anonymous file sharing',
    'open source file sharing',
  ],
  alternates: { canonical: SITE_URL },
  openGraph: {
    type: 'website',
    siteName: 'AirDelivery',
    locale: 'en_US',
    url: SITE_URL,
    title: 'AirDelivery — Private P2P File Transfer',
    description: DESCRIPTION,
    images: [{ url: '/og-banner.png', width: 1200, height: 630, alt: 'AirDelivery' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AirDelivery — Private P2P File Transfer',
    description: DESCRIPTION,
    images: ['/og-banner.png'],
  },
  icons: {
    icon: [{ url: '/favicon.ico' }, { url: '/icons/192.png', type: 'image/png', sizes: '192x192' }],
    apple: '/icons/apple.png',
  },
  manifest: '/manifest.json',
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#09090b' },
  ],
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebApplication',
      name: 'AirDelivery',
      url: `${SITE_URL}/`,
      applicationCategory: 'UtilitiesApplication',
      operatingSystem: 'Any',
      browserRequirements: 'Requires JavaScript and WebRTC',
      description: DESCRIPTION,
      license: 'https://opensource.org/licenses/MIT',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      featureList: [
        'Peer-to-peer WebRTC transfers',
        'No accounts required',
        'No server-side file storage',
        'Progress, pause and resume',
        'SHA-256 integrity verification',
      ],
    },
    {
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'Does the server ever see my files?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'No. The server only relays the WebRTC handshake so the two browsers can connect directly. File data never reaches it.',
          },
        },
        {
          '@type': 'Question',
          name: 'Why will it not connect on my network?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Some campus and corporate networks block the peer-to-peer connections WebRTC needs. A TURN relay has to be configured on the server for those networks to work. Home and local networks are unaffected.',
          },
        },
      ],
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="manifest" href="/manifest.json" />
        <script
          type="application/ld+json"
          // Static, developer-authored JSON. No user input reaches this string.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className={`${inter.variable} ${geistMono.variable} font-sans antialiased`}>
        <Providers>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:absolute focus:z-[60] focus:m-2 focus:rounded-lg focus:bg-orange-600 focus:px-4 focus:py-2 focus:text-white"
          >
            Skip to content
          </a>
          <Header />
          {children}
          <FooterStrip />
        </Providers>

        {GA_ID && (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
              strategy="afterInteractive"
            />
            <Script id="google-analytics" strategy="afterInteractive">
              {`
                window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                gtag('js', new Date());
                gtag('config', '${GA_ID}', { anonymize_ip: true });
              `}
            </Script>
          </>
        )}

        {/*
          Auto-ads requires an actual script tag. The previous markup rendered a
          bare <amp-auto-ads> element with no loader, which React treated as an
          unknown DOM node and which never initialised AdSense at all.
        */}
        {ADSENSE_ID && (
          <Script
            id="adsense-auto-ads"
            strategy="afterInteractive"
            dangerouslySetInnerHTML={{
              __html: `
                (adsbygoogle = window.adsbygoogle || []).push({
                  google_ad_client: "${ADSENSE_ID}",
                  enable_page_level_ads: true
                });
                (function(){
                  var s = document.createElement('script');
                  s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_ID}";
                  s.async = true;
                  document.head.appendChild(s);
                })();
              `,
            }}
          />
        )}

        <Analytics />
        <Script id="register-sw" strategy="afterInteractive">
          {`
            if ('serviceWorker' in navigator && location.protocol === 'https:') {
              window.addEventListener('load', function () {
                navigator.serviceWorker.register('/sw.js').catch(function () {
                  // Registration is an optimisation. Failing to register must
                  // never surface to the user.
                });
              });
            }
          `}
        </Script>
      </body>
    </html>
  );
}
