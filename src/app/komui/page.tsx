import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OzonImportTab } from "./ozon-import";

export const metadata = { title: "Админка Komui" };

export default function KomuiAdminPage() {
  return (
    <div>
      <PageHeader
        title="Админка Komui"
        description="Управление магазином komui.ru — отдельный сайт и бэкенд, не связанный с учётом Ozon"
      />
      <Tabs defaultValue="ozon-import">
        <TabsList>
          <TabsTrigger value="ozon-import">Импорт из Ozon</TabsTrigger>
        </TabsList>
        <TabsContent value="ozon-import">
          <OzonImportTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
