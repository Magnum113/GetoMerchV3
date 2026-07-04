import { PageHeader } from "@/components/ui/page-header";
import { getKomuiConfigSummary } from "@/lib/komui/server";

export default function KomuiLayout({ children }: { children: React.ReactNode }) {
  const config = getKomuiConfigSummary();
  const isProd = config.target === "prod";

  return (
    <div>
      <PageHeader
        title="Админка Komui"
        description="Управление магазином komui.ru — отдельный сайт и бэкенд, не связанный с учётом Ozon"
      />
      <div
        className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
          isProd
            ? "border-emerald-200 bg-emerald-50 text-emerald-950"
            : "border-amber-200 bg-amber-50 text-amber-950"
        }`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">
            {isProd ? "PROD" : config.target.toUpperCase()}
          </span>
          <span className="text-muted-foreground">
            Komui API: {config.hostname || config.baseUrl}
          </span>
          {config.basicAuthConfigured && !config.basicAuthSent && (
            <span className="text-xs opacity-75">
              staging Basic Auth настроен, но не отправляется на prod
            </span>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
