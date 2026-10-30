import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist_Mono, Host_Grotesk } from "next/font/google";
import { AnalyticsRoot } from "@/components/analytics-root";
import { RegionNotice } from "@/components/region-notice";
import { OG_IMAGE, SITE_DEFAULT_DESCRIPTION, SITE_DEFAULT_TITLE, SITE_NAME, SITE_TITLE_TEMPLATE, SITE_X_HANDLE, siteMetadataBase } from "@/lib/seo";
import "./globals.css";

const display = Host_Grotesk({ subsets: ["latin"], variable: "--font-grotesk" });
const data = Geist_Mono({ subsets: ["latin"], variable: "--font-mono-data" });

export const metadata: Metadata = {
  metadataBase: siteMetadataBase(),
  title: { default: SITE_DEFAULT_TITLE, template: SITE_TITLE_TEMPLATE },
  description: SITE_DEFAULT_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    locale: "en_US",
    title: SITE_DEFAULT_TITLE,
    description: SITE_DEFAULT_DESCRIPTION,
    images: [{ ...OG_IMAGE }],
  },
  twitter: {
    card: "summary_large_image",
    site: SITE_X_HANDLE,
    title: SITE_DEFAULT_TITLE,
    description: SITE_DEFAULT_DESCRIPTION,
    images: [OG_IMAGE.url],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`h-full antialiased ${display.variable} ${data.variable} font-display`}>
      <body className="min-h-full flex flex-col bg-canvas text-cream">
        <Suspense fallback={null}>
          <AnalyticsRoot />
        </Suspense>
        <RegionNotice />
        {children}
      </body>
    </html>
  );
}
