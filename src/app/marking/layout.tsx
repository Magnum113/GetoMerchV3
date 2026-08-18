import { notFound } from "next/navigation";
import { isAdminFeatureEnabled } from "@/lib/admin/features";

export const dynamic = "force-dynamic";

export default async function MarkingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!await isAdminFeatureEnabled("chestny_znak")) notFound();
  return children;
}
