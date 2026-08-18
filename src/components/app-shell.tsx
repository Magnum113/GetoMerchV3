"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { LockKeyhole } from "lucide-react";
import { Sidebar, MobileHeader } from "@/components/sidebar";
import { AdminFeatureProvider } from "@/components/admin-feature-flags";
import type { AdminFeatureSnapshot } from "@/lib/admin/feature-types";
import type { MaintenanceState } from "@/lib/maintenance";

export function AppShell({
  children,
  maintenance,
  features,
}: {
  children: React.ReactNode;
  maintenance: MaintenanceState;
  features: AdminFeatureSnapshot;
}) {
  const pathname = usePathname();
  const [runtimeMaintenance, setRuntimeMaintenance] = useState(maintenance);
  const [runtimeFeatures, setRuntimeFeatures] = useState(features);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch("/api/admin/health", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = await response.json() as {
          data?: {
            maintenanceMode?: unknown;
            maintenanceReason?: unknown;
            features?: { chestny_znak?: unknown };
          };
        };
        const enabled = payload.data?.maintenanceMode === "read_only";
        setRuntimeMaintenance({
          mode: enabled ? "read_only" : "off",
          enabled,
          reason: typeof payload.data?.maintenanceReason === "string"
            ? payload.data.maintenanceReason
            : "Техническое обслуживание",
        });
        if (typeof payload.data?.features?.chestny_znak === "boolean") {
          setRuntimeFeatures({
            chestny_znak: payload.data.features.chestny_znak,
          });
        }
      } catch {
        // The page's own requests surface connectivity/auth failures.
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [pathname]);

  if (pathname === "/login") return <>{children}</>;

  return (
    <AdminFeatureProvider value={runtimeFeatures}>
      <div className="flex min-h-screen bg-muted/30">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <MobileHeader />
          {runtimeMaintenance.enabled ? (
            <div
              className="flex min-h-11 items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-950 lg:px-8"
              role="status"
            >
              <LockKeyhole className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Режим только для чтения: {runtimeMaintenance.reason}</span>
            </div>
          ) : null}
          <main className="flex-1 overflow-x-hidden">
            <div className="mx-auto w-full max-w-screen-2xl px-4 py-5 lg:px-8 lg:py-8">
              {children}
            </div>
          </main>
        </div>
      </div>
    </AdminFeatureProvider>
  );
}
