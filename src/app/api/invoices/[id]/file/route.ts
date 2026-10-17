import { route } from "@/lib/api";
import { invoiceFile, loadInvoice } from "@/lib/invoice-store";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }, me) => {
  const { data } = await loadInvoice(Number((await params).id), me);
  const f = await invoiceFile(data);
  return new Response(new Uint8Array(f.content), { headers: { "content-type": f.contentType, "content-disposition": `attachment; filename="${f.filename}"` } });
});
