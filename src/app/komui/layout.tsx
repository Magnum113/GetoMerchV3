import { PageHeader } from "@/components/ui/page-header";

export default function KomuiLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <PageHeader
        title="Админка Komui"
        description="Управление магазином komui.ru — отдельный сайт и бэкенд, не связанный с учётом Ozon"
      />
      {children}
    </div>
  );
}
