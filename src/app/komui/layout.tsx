"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/komui/import", label: "Импорт из Ozon" },
  { href: "/komui/runtime", label: "Production runtime" },
];

export default function KomuiLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div>
      <PageHeader
        title="Админка Komui"
        description="Управление магазином komui.ru — отдельный сайт и бэкенд, не связанный с учётом Ozon"
      />
      <div className="flex flex-wrap gap-1.5 mb-5">
        {TABS.map((t) => {
          const active = pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                "inline-flex items-center gap-1.5 border rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                active
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background hover:bg-accent",
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
      {children}
    </div>
  );
}
