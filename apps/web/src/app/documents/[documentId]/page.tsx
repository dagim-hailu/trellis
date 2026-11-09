import { CanvasDocumentPage } from "@/components/CanvasDocumentPage";

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const { documentId } = await params;
  return <CanvasDocumentPage documentId={documentId} />;
}
