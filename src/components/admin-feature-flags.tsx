"use client";

import { createContext, useContext } from "react";
import type {
  AdminFeatureKey,
  AdminFeatureSnapshot,
} from "@/lib/admin/feature-types";
import { DEFAULT_ADMIN_FEATURES } from "@/lib/admin/feature-types";

const AdminFeatureContext = createContext<AdminFeatureSnapshot>(
  DEFAULT_ADMIN_FEATURES,
);

export function AdminFeatureProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: AdminFeatureSnapshot;
}) {
  return (
    <AdminFeatureContext.Provider value={value}>
      {children}
    </AdminFeatureContext.Provider>
  );
}

export function useAdminFeature(key: AdminFeatureKey) {
  return useContext(AdminFeatureContext)[key];
}
