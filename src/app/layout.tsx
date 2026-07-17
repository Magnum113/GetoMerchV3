import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { Toaster } from "@/components/ui/sonner";
import { getMaintenanceState } from "@/lib/maintenance";

const inter = Inter({ subsets: ["latin", "cyrillic"] });

export const metadata: Metadata = {
  title: "GetoMerch — учёт мерча",
  description: "Управление складом футболок и худи с принтами и вышивкой",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const maintenance = getMaintenanceState();
  return (
    <html lang="ru" suppressHydrationWarning>
      <body className={inter.className}>
        <AppShell maintenance={maintenance}>{children}</AppShell>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
