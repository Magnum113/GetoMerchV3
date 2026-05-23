"use client";

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
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Дашборд", icon: LayoutDashboard },
  { href: "/inventory", label: "Остатки", icon: WarehouseIcon },
  { href: "/products", label: "Каталог SKU", icon: Package },
  { href: "/workshop", label: "Заказы в цех", icon: Hammer },
  { href: "/transactions", label: "Журнал операций", icon: ArrowLeftRight },
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

// Mobile nav bar
export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav className="lg:hidden sticky bottom-0 z-40 bg-background border-t flex items-center justify-around py-2">
      {NAV.slice(0, 5).map((item) => {
        const active =
          item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex flex-col items-center gap-1 px-2 py-1 rounded-md text-xs",
              active ? "text-primary" : "text-muted-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
            <span className="truncate text-[10px]">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
