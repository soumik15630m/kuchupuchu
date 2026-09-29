import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";

import { SessionProvider } from "@/lib/auth/SessionProvider";
import { AutoBackup } from "@/components/shell/AutoBackup";
import { PushBridge } from "@/components/shell/PushBridge";
import { LiveRegion } from "@/components/a11y/LiveRegion";
import { ThemeSync } from "@/components/shell/ThemeSync";
import { IncomingCall } from "@/components/call/IncomingCall";
import { LockGate } from "@/components/shell/LockGate";
import { DirectoryProvider } from "@/lib/directory/DirectoryProvider";
import { MessagingProvider } from "@/lib/messaging/MessagingProvider";
import { NO_FLASH_SCRIPT } from "@/lib/theme/apply";
import { ThemeProvider } from "@/lib/theme/ThemeProvider";

import "./globals.css";

export const metadata: Metadata = {
  title: "Kuchupuchu",
  description: "Private calls and messages",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // No maximumScale: locking zoom is a WCAG 1.4.4 failure. The iOS
  // zoom-on-focus it used to guard against is prevented by the composer's
  // inputs already computing to 16px, which is the actual fix.
  viewportFit: "cover",
  // Per scheme, so dark mode does not get light browser chrome. The single
  // hardcoded light value disagreed with the manifest's accent too.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f0f2f5" },
    { media: "(prefers-color-scheme: dark)", color: "#111b21" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Stamped by proxy.ts. The theme bootstrap below is an inline script, so
  // without the matching nonce the CSP blocks it and the app flashes the
  // wrong theme -- or, under the old policy, did not render at all.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <SessionProvider>
            <DirectoryProvider>
              <MessagingProvider>
                <AutoBackup />
                <PushBridge />
                <LiveRegion />
                <ThemeSync />
                <IncomingCall />
                <LockGate>{children}</LockGate>
              </MessagingProvider>
            </DirectoryProvider>
          </SessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
