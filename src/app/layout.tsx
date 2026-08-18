import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { Toaster } from "@/components/ui/sonner";
import { getMaintenanceState } from "@/lib/maintenance";
import { getAdminFeatureSnapshot } from "@/lib/admin/features";

export const dynamic = "force-dynamic";

const inter = Inter({ subsets: ["latin", "cyrillic"] });

export const metadata: Metadata = {
  title: "GetoMerch — учёт мерча",
  description: "Управление складом футболок и худи с принтами и вышивкой",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const maintenance = getMaintenanceState();
  const features = await getAdminFeatureSnapshot();
  return (
    <html lang="ru" suppressHydrationWarning>
      <body className={inter.className}>
        <AppShell maintenance={maintenance} features={features}>
          {children}
        </AppShell>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
