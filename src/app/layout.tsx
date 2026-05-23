import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { Toaster } from "@/components/ui/sonner";

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
  return (
    <html lang="ru" suppressHydrationWarning>
      <body className={inter.className}>
        <div className="flex min-h-screen bg-muted/30">
          <Sidebar />
          <main className="flex-1 overflow-x-hidden">
            <div className="container max-w-screen-2xl py-8 px-4 lg:px-8">
              {children}
            </div>
          </main>
        </div>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
