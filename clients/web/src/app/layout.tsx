import type { Metadata, Viewport } from "next";

import { SessionProvider } from "@/lib/auth/SessionProvider";
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <SessionProvider>
            <MessagingProvider>{children}</MessagingProvider>
          </SessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
