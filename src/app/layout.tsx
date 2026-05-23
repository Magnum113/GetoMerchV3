import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Sidebar, MobileHeader } from "@/components/sidebar";
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
          <div className="flex-1 min-w-0 flex flex-col">
            <MobileHeader />
            <main className="flex-1 overflow-x-hidden">
              <div className="mx-auto w-full max-w-screen-2xl py-5 px-4 lg:py-8 lg:px-8">
                {children}
              </div>
            </main>
          </div>
        </div>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
