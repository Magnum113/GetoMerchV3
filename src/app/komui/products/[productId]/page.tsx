import { ProductEditor } from "./product-editor";

export const metadata = { title: "Товар сайта — Komui" };

export default async function KomuiProductEditorPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  const { productId } = await params;
  return <ProductEditor productId={productId} />;
}
