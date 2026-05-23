"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Package,
  Warehouse as WarehouseIcon,
  ArrowLeftRight,
  Hammer,
  Palette,
  Settings,
  Shirt,
  Menu,
  X,
  ShoppingBag,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Дашборд", icon: LayoutDashboard },
  { href: "/orders", label: "Заказы Ozon", icon: ShoppingBag },
  { href: "/inventory", label: "Остатки", icon: WarehouseIcon },
  { href: "/products", label: "Каталог SKU", icon: Package },
  { href: "/workshop", label: "Заказы в цех", icon: Hammer },
  { href: "/transactions", label: "Журнал", icon: ArrowLeftRight },
  { href: "/designs", label: "Дизайны", icon: Palette },
  { href: "/settings", label: "Справочники", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden lg:flex w-64 flex-col border-r bg-background sticky top-0 h-screen">
      <div className="flex items-center gap-2 px-6 h-16 border-b">
        <div className="rounded-lg bg-primary p-1.5 text-primary-foreground">
          <Shirt className="h-5 w-5" />
        </div>
        <div className="font-semibold tracking-tight">GetoMerch</div>
      </div>

      <nav className="flex-1 overflow-y-auto p-3 space-y-0.5">
        {NAV.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t p-4 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">Учёт мерча</div>
        <div className="mt-1">v0.1 · Supabase</div>
      </div>
    </aside>
  );
}

// Mobile top bar with hamburger menu (lg-)
export function MobileHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      <header className="lg:hidden sticky top-0 z-40 flex items-center justify-between gap-3 h-14 px-4 bg-background/95 backdrop-blur border-b">
        <Link href="/" className="flex items-center gap-2" onClick={() => setOpen(false)}>
          <div className="rounded-md bg-primary p-1 text-primary-foreground">
            <Shirt className="h-4 w-4" />
          </div>
          <span className="font-semibold tracking-tight">GetoMerch</span>
        </Link>
        <button
          onClick={() => setOpen((v) => !v)}
          className="rounded-md p-2 hover:bg-accent active:bg-accent/70 transition"
          aria-label={open ? "Закрыть меню" : "Открыть меню"}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </header>

      {/* Slide-down menu */}
      {open && (
        <>
          <div
            className="lg:hidden fixed inset-0 top-14 z-30 bg-black/40 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <nav className="lg:hidden fixed top-14 left-0 right-0 z-40 bg-background border-b shadow-lg p-2 space-y-0.5 max-h-[calc(100vh-3.5rem)] overflow-y-auto">
            {NAV.map((item) => {
              const active =
                item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-4 py-3 text-sm font-medium transition-colors",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-foreground hover:bg-accent",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </>
      )}
    </>
  );
}
