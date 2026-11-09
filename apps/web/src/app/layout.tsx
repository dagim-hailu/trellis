import type { Metadata, Viewport } from "next";

import { ThemeProvider } from "@/components/ThemeProvider";

import "./globals.css";

export const metadata: Metadata = {
  title: "Trellis · Realtime canvas",
  description:
    "A local-first, realtime collaborative canvas built with Yjs, PostgreSQL, and Redis.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#080d1a",
};

const THEME_BOOTSTRAP = `(function(){try{var k='trellis.theme.v1';var s=localStorage.getItem(k);var t=(s==='light'||s==='dark'||s==='rust')?s:'dark';document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t==='light'?'light':'dark';}catch(e){document.documentElement.dataset.theme='dark';}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
