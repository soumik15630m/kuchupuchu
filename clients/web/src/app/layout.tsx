import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";

import { SessionProvider } from "@/lib/auth/SessionProvider";
import { AutoBackup } from "@/components/shell/AutoBackup";
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
  // A chat composer that zooms the page on focus is unusable on a phone.
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#f0f2f5",
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
                <LockGate>{children}</LockGate>
              </MessagingProvider>
            </DirectoryProvider>
          </SessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
