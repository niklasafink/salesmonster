import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFFont, PDFHexString, PDFName, PDFString, rgb } from "pdf-lib";
import type { InvoiceCustomer, InvoiceLine, InvoiceSettings } from "@/db/schema";
import { dLong } from "./dates";
import { eur, greeting, lineSum, totalOf } from "./invoice-calc";

export type InvoiceData = {
  number: string; issueDate: string; dueDate: string; serviceStart: string; serviceEnd: string;
  format: "zugferd" | "xrechnung"; leitweg: string;
  customer: InvoiceCustomer; lines: InvoiceLine[];
  contact: { name: string; phone: string; email: string };
  settings: InvoiceSettings;
};

const X = (s: string) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
const d102 = (iso: string) => iso.replace(/-/g, "");
const amt = (n: number) => n.toFixed(2);
const splitCity = (s: string) => { const m = s.match(/^(\d{4,5})\s+(.*)$/); return m ? { zip: m[1], city: m[2] } : { zip: "", city: s }; };
const EXEMPT = "Kleinunternehmer gemäß § 19 UStG";

/* UN/CEFACT CII, EN 16931. XRechnung 3.0 uses the same syntax with its own customization id. */
export function ciiXml(d: InvoiceData) {
  const s = d.settings.seller, c = d.customer, sc = splitCity(s.city);
  const items = d.lines.filter(l => !l.disc), allow = d.lines.filter(l => l.disc);
  const lineTotal = items.reduce((a, l) => a + lineSum(l), 0), allowTotal = -allow.reduce((a, l) => a + lineSum(l), 0), total = totalOf(d.lines);
  const guideline = d.format === "xrechnung" ? "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0" : "urn:cen.eu:en16931:2017";
  const tax = `<ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>E</ram:CategoryCode><ram:RateApplicablePercent>0</ram:RateApplicablePercent>`;
  const dt = (iso: string) => `<udt:DateTimeString format="102">${d102(iso)}</udt:DateTimeString>`;
  const buyerRef = d.leitweg || (d.format === "xrechnung" ? "n/a" : "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
<rsm:ExchangedDocumentContext>
<ram:BusinessProcessSpecifiedDocumentContextParameter><ram:ID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</ram:ID></ram:BusinessProcessSpecifiedDocumentContextParameter>
<ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>${guideline}</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter>
</rsm:ExchangedDocumentContext>
<rsm:ExchangedDocument>
<ram:ID>${X(d.number)}</ram:ID><ram:TypeCode>380</ram:TypeCode>
<ram:IssueDateTime>${dt(d.issueDate)}</ram:IssueDateTime>
<ram:IncludedNote><ram:Content>Gemäß § 19 UStG wird keine Umsatzsteuer ausgewiesen.</ram:Content></ram:IncludedNote>
</rsm:ExchangedDocument>
<rsm:SupplyChainTradeTransaction>
${items.map((l, i) => `<ram:IncludedSupplyChainTradeLineItem>
<ram:AssociatedDocumentLineDocument><ram:LineID>${i + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>
<ram:SpecifiedTradeProduct><ram:Name>${X(l.desc)}</ram:Name>${l.sub ? `<ram:Description>${X(l.sub)}</ram:Description>` : ""}</ram:SpecifiedTradeProduct>
<ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>${amt(l.unit)}</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
<ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="MON">${l.qty}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
<ram:SpecifiedLineTradeSettlement><ram:ApplicableTradeTax>${tax}</ram:ApplicableTradeTax>
<ram:BillingSpecifiedPeriod><ram:StartDateTime>${dt(d.serviceStart)}</ram:StartDateTime><ram:EndDateTime>${dt(d.serviceEnd)}</ram:EndDateTime></ram:BillingSpecifiedPeriod>
<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${amt(lineSum(l))}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation></ram:SpecifiedLineTradeSettlement>
</ram:IncludedSupplyChainTradeLineItem>`).join("\n")}
<ram:ApplicableHeaderTradeAgreement>
${buyerRef ? `<ram:BuyerReference>${X(buyerRef)}</ram:BuyerReference>` : ""}
<ram:SellerTradeParty><ram:Name>${X(s.name)}</ram:Name>
<ram:SpecifiedLegalOrganization><ram:ID>${X(`${s.hrb}, Amtsgericht ${s.court}`)}</ram:ID></ram:SpecifiedLegalOrganization>
<ram:DefinedTradeContact><ram:PersonName>${X(d.contact.name)}</ram:PersonName><ram:TelephoneUniversalCommunication><ram:CompleteNumber>${X(d.contact.phone)}</ram:CompleteNumber></ram:TelephoneUniversalCommunication><ram:EmailURIUniversalCommunication><ram:URIID>${X(d.contact.email)}</ram:URIID></ram:EmailURIUniversalCommunication></ram:DefinedTradeContact>
<ram:PostalTradeAddress><ram:PostcodeCode>${X(sc.zip)}</ram:PostcodeCode><ram:LineOne>${X(s.street)}</ram:LineOne><ram:CityName>${X(sc.city)}</ram:CityName><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress>
<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${X(s.email || d.contact.email)}</ram:URIID></ram:URIUniversalCommunication>
<ram:SpecifiedTaxRegistration><ram:ID schemeID="${/^[A-Z]{2}/.test(s.tax) ? "VA" : "FC"}">${X(s.tax.replace(/\s/g, ""))}</ram:ID></ram:SpecifiedTaxRegistration>
</ram:SellerTradeParty>
<ram:BuyerTradeParty><ram:Name>${X(c.co)}</ram:Name>
${c.attn ? `<ram:DefinedTradeContact><ram:PersonName>${X(c.attn)}</ram:PersonName></ram:DefinedTradeContact>` : ""}
<ram:PostalTradeAddress><ram:PostcodeCode>${X(c.zip)}</ram:PostcodeCode><ram:LineOne>${X(c.street)}</ram:LineOne><ram:CityName>${X(c.city)}</ram:CityName><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress>
${c.email ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${X(c.email)}</ram:URIID></ram:URIUniversalCommunication>` : ""}
${c.vat ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${X(c.vat.replace(/\s/g, ""))}</ram:ID></ram:SpecifiedTaxRegistration>` : ""}
</ram:BuyerTradeParty>
</ram:ApplicableHeaderTradeAgreement>
<ram:ApplicableHeaderTradeDelivery/>
<ram:ApplicableHeaderTradeSettlement>
<ram:PaymentReference>${X(d.number)}</ram:PaymentReference>
<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
<ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>58</ram:TypeCode><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>${X(s.iban.replace(/\s/g, ""))}</ram:IBANID></ram:PayeePartyCreditorFinancialAccount><ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>${X(s.bic)}</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution></ram:SpecifiedTradeSettlementPaymentMeans>
<ram:ApplicableTradeTax><ram:CalculatedAmount>0.00</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode><ram:ExemptionReason>${EXEMPT}</ram:ExemptionReason><ram:BasisAmount>${amt(total)}</ram:BasisAmount><ram:CategoryCode>E</ram:CategoryCode><ram:RateApplicablePercent>0</ram:RateApplicablePercent></ram:ApplicableTradeTax>
<ram:BillingSpecifiedPeriod><ram:StartDateTime>${dt(d.serviceStart)}</ram:StartDateTime><ram:EndDateTime>${dt(d.serviceEnd)}</ram:EndDateTime></ram:BillingSpecifiedPeriod>
${allow.map(l => `<ram:SpecifiedTradeAllowanceCharge><ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator><ram:ActualAmount>${amt(-lineSum(l))}</ram:ActualAmount><ram:ReasonCode>95</ram:ReasonCode><ram:Reason>${X(l.desc)}</ram:Reason><ram:CategoryTradeTax>${tax}</ram:CategoryTradeTax></ram:SpecifiedTradeAllowanceCharge>`).join("\n")}
<ram:SpecifiedTradePaymentTerms><ram:Description>Zahlbar ohne Abzug bis ${X(dLong(d.dueDate))}</ram:Description><ram:DueDateDateTime>${dt(d.dueDate)}</ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms>
<ram:SpecifiedTradeSettlementHeaderMonetarySummation>
<ram:LineTotalAmount>${amt(lineTotal)}</ram:LineTotalAmount><ram:ChargeTotalAmount>0.00</ram:ChargeTotalAmount><ram:AllowanceTotalAmount>${amt(allowTotal)}</ram:AllowanceTotalAmount>
<ram:TaxBasisTotalAmount>${amt(total)}</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="EUR">0.00</ram:TaxTotalAmount>
<ram:GrandTotalAmount>${amt(total)}</ram:GrandTotalAmount><ram:DuePayableAmount>${amt(total)}</ram:DuePayableAmount>
</ram:SpecifiedTradeSettlementHeaderMonetarySummation>
</ram:ApplicableHeaderTradeSettlement>
</rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`.replace(/\n\n+/g, "\n");
}

const asset = (f: string) => readFile(path.join(process.cwd(), "assets", f));

function xmp(title: string, created: Date) {
  const iso = created.toISOString().replace(/\.\d{3}Z$/, "Z");
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description>
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${X(title)}</rdf:li></rdf:Alt></dc:title></rdf:Description>
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:CreatorTool>Sales Portal</xmp:CreatorTool><xmp:CreateDate>${iso}</xmp:CreateDate><xmp:ModifyDate>${iso}</xmp:ModifyDate></rdf:Description>
<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"><pdf:Producer>Sales Portal</pdf:Producer></rdf:Description>
<rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#"><fx:DocumentType>INVOICE</fx:DocumentType><fx:DocumentFileName>factur-x.xml</fx:DocumentFileName><fx:Version>1.0</fx:Version><fx:ConformanceLevel>EN 16931</fx:ConformanceLevel></rdf:Description>
<rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
<pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">
<pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema><pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI><pdfaSchema:prefix>fx</pdfaSchema:prefix>
<pdfaSchema:property><rdf:Seq>
<rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentFileName</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>name of the embedded XML invoice file</pdfaProperty:description></rdf:li>
<rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentType</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>INVOICE</pdfaProperty:description></rdf:li>
<rdf:li rdf:parseType="Resource"><pdfaProperty:name>Version</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The actual version of the Factur-X XML schema</pdfaProperty:description></rdf:li>
<rdf:li rdf:parseType="Resource"><pdfaProperty:name>ConformanceLevel</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The conformance level of the embedded Factur-X data</pdfaProperty:description></rdf:li>
</rdf:Seq></pdfaSchema:property></rdf:li></rdf:Bag></pdfaExtension:schemas></rdf:Description>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
}

/* A4 page that mirrors the preview in the builder (1cqw = 5.953pt) */
export async function invoicePdf(d: InvoiceData, xml: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [reg, semi, serif] = await Promise.all([asset("Geist-Regular.ttf"), asset("Geist-SemiBold.ttf"), asset("serif-italic.woff")]);
  const F = await pdf.embedFont(reg, { subset: true }), B = await pdf.embedFont(semi, { subset: true }), I = await pdf.embedFont(serif, { subset: true });
  const W = 595.28, H = 841.89, cq = W / 100, page = pdf.addPage([W, H]);
  const L = 11.5 * cq, R = W - 10.5 * cq, fs = 1.55 * cq, lh = fs * 1.45, ink = rgb(0.106, 0.106, 0.106), grey = rgb(0.33, 0.33, 0.33), rule = rgb(0.87, 0.87, 0.87);
  const s = d.settings.seller, c = d.customer;
  const text = (t: string, x: number, y: number, o: { font?: PDFFont; size?: number; align?: "l" | "r" | "c"; color?: ReturnType<typeof rgb> } = {}) => {
    const font = o.font || F, size = o.size || fs, w = font.widthOfTextAtSize(t, size);
    const xx = o.align === "r" ? x - w : o.align === "c" ? x - w / 2 : x;
    page.drawText(t, { x: xx, y, size, font, color: o.color || ink });
  };
  const wrap = (t: string, width: number, font = F, size = fs) => {
    const out: string[] = []; let cur = "";
    for (const w of t.split(/\s+/)) { const n = cur ? `${cur} ${w}` : w; if (font.widthOfTextAtSize(n, size) > width && cur) { out.push(cur); cur = w; } else cur = n; }
    if (cur) out.push(cur); return out;
  };

  let y = H - 6.5 * cq - 4 * cq * 0.8;
  /* Logo: "vergabe" + italic "hero" */
  const [l1, l2] = d.settings.logo.split("|"), ls = 4 * cq;
  const w2 = l2 ? I.widthOfTextAtSize(l2, ls) : 0;
  text(l1, R - w2, y, { font: B, size: ls, align: "r" });
  if (l2) text(l2, R, y, { font: I, size: ls, align: "r" });
  y -= 3.5 * cq + lh;

  const top = y;
  [s.name, s.street, s.city].forEach((t, i) => text(t, L, top - i * lh));
  const kx = R - Math.max(...[d.contact.name, d.contact.phone, d.contact.email, "Kontakt"].map(t => F.widthOfTextAtSize(t, fs)));
  text("Kontakt", kx, top, { font: B });
  [d.contact.name, d.contact.phone, d.contact.email].forEach((t, i) => text(t, kx, top - (i + 1) * lh));
  y = top - 4 * lh - 4 * cq;

  const addr = [c.co, ...(c.attn ? [`z.H. ${c.attn}`] : []), c.street, `${c.zip} ${c.city}`, "Deutschland"];
  addr.forEach((t, i) => text(t, L, y - i * lh));
  y -= Math.max(addr.length * lh, 10 * cq) + 5 * cq;

  text(d.settings.title, L, y, { font: B });
  const meta = [`Rechnung: ${d.number}`, `Datum: ${dLong(d.issueDate)}`, `Fällig am: ${dLong(d.dueDate)}`,
    ...(d.leitweg ? [`Leitweg-ID: ${d.leitweg}`] : []), ...(c.vat ? [`USt-IdNr. Kunde: ${c.vat}`] : [])];
  const my = y - 1.8 * cq;
  meta.forEach((t, i) => text(t, R, my - i * lh, { align: "r" }));
  y = Math.min(y, my - (meta.length - 1) * lh) - 3.5 * cq - lh;

  text(greeting(c.salut), L, y); y -= 2 * lh;
  for (const ln of wrap("vielen Dank für Ihren Auftrag, vereinbarungsgemäß berechnen wir Ihnen hiermit folgende Leistungen:", R - L)) { text(ln, L, y); y -= lh; }
  y -= 2.6 * cq - lh * 0.6;

  /* Table */
  const ts = 1.5 * cq, tl = ts * 1.45, cw = [0.07, 0.43, 0.12, 0.19, 0.19].map(f => f * (R - L)), cx: number[] = [];
  cw.reduce((x, w) => (cx.push(x), x + w), L);
  const mid = (i: number) => cx[i] + cw[i] / 2, line = (yy: number) => page.drawLine({ start: { x: L, y: yy }, end: { x: R, y: yy }, thickness: 0.15 * cq, color: rule });
  line(y); y -= 1.1 * cq + ts * 0.8;
  ["Pos.", "Bezeichnung", "Menge", "Einzelpreis", "Gesamtpreis"].forEach((h, i) => text(h, mid(i), y, { font: B, size: ts, align: "c" }));
  y -= 1.1 * cq + ts * 0.3; line(y);
  let pos = 0;
  for (const l of d.lines) {
    y -= (l.disc ? 0.4 : 1.4) * cq + ts * 0.8;
    const descW = cw[1] - 1.6 * cq, rows = wrap(l.desc, descW, B, ts), sub = l.sub ? wrap(l.sub, descW, B, ts) : [];
    const all = [...rows, ...sub], blockH = (all.length - 1) * tl, cy = y - blockH / 2;
    const col = l.disc ? grey : ink;
    if (!l.disc) text(String(++pos), mid(0), cy, { size: ts, align: "c", color: col });
    all.forEach((t, i) => text(t, cx[1] + 0.8 * cq, y - i * tl, { font: B, size: ts, color: col }));
    text(String(l.qty), mid(2), cy, { size: ts, align: "c", color: col });
    text(eur(l.unit), mid(3), cy, { size: ts, align: "c", color: col });
    text(eur(lineSum(l)), mid(4), cy, { size: ts, align: "c", color: col });
    y -= blockH + 1.4 * cq * 0.6;
  }
  y -= 0.6 * cq; line(y);
  y -= 2 * cq + fs * 0.8;
  text(`Gesamtbetrag: ${eur(totalOf(d.lines))}`, R, y, { font: B, align: "r" }); y -= lh;
  text("Gemäß § 19 UStG wird keine Umsatzsteuer ausgewiesen.", R, y, { align: "r" });
  y -= 4.5 * cq + lh * 0.4;

  const pay = [`Bitte begleichen Sie den Rechnungsbetrag bis zum ${dLong(d.dueDate)}. Bitte überweisen Sie den Betrag auf das in der Fußzeile angegebene Konto und geben Sie als Verwendungszweck „${d.number}“ an.`,
    "Bei Rückfragen stehe ich jederzeit gerne zur Verfügung.", "Mit freundlichen Grüßen", s.gf];
  for (const p of pay) { for (const ln of wrap(p, R - L)) { text(ln, L, y); y -= lh; } y -= 1.6 * cq; }

  const ff = [s.name, `Handelsregister: ${s.hrb}, Registergericht: ${s.court}`, `Geschäftsführer: ${s.gf} | Steuernummer/USt-IdNr.: ${s.tax}`, `IBAN: ${s.iban} | BIC: ${s.bic}`];
  const fz = 1.4 * cq, fl = fz * 1.5;
  ff.forEach((t, i) => text(t, W / 2, 4 * cq + (ff.length - 1 - i) * fl, { size: fz, align: "c" }));

  /* PDF/A-3 + Factur-X: metadata, output intent, embedded XML */
  const now = new Date(), title = `Rechnung ${d.number}`, ctx = pdf.context;
  pdf.setTitle(title); pdf.setProducer("Sales Portal"); pdf.setCreator("Sales Portal"); pdf.setCreationDate(now); pdf.setModificationDate(now);
  const icc = await asset("srgb.icc");
  const iccRef = ctx.register(ctx.flateStream(icc, { N: 3 }));
  pdf.catalog.set(PDFName.of("OutputIntents"), ctx.obj([ctx.obj({ Type: "OutputIntent", S: "GTS_PDFA1", OutputConditionIdentifier: PDFString.of("sRGB IEC61966-2.1"), Info: PDFString.of("sRGB IEC61966-2.1"), DestOutputProfile: iccRef })]));
  const meta2 = ctx.stream(xmp(title, now), { Type: "Metadata", Subtype: "XML" });
  pdf.catalog.set(PDFName.of("Metadata"), ctx.register(meta2));
  const xmlBytes = new TextEncoder().encode(xml);
  const efRef = ctx.register(ctx.flateStream(xmlBytes, { Type: "EmbeddedFile", Subtype: "text/xml", Params: { Size: xmlBytes.length, ModDate: PDFString.fromDate(now) } }));
  const fsRef = ctx.register(ctx.obj({ Type: "Filespec", F: PDFString.of("factur-x.xml"), UF: PDFHexString.fromText("factur-x.xml"), EF: { F: efRef, UF: efRef }, Desc: PDFString.of("Factur-X Rechnung"), AFRelationship: "Alternative" }));
  pdf.catalog.set(PDFName.of("AF"), ctx.obj([fsRef]));
  pdf.catalog.set(PDFName.of("Names"), ctx.obj({ EmbeddedFiles: { Names: [PDFHexString.fromText("factur-x.xml"), fsRef] } }));
  pdf.catalog.set(PDFName.of("MarkInfo"), ctx.obj({ Marked: true }));
  const id = createHash("md5").update(d.number + now.toISOString()).digest("hex");
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(id), PDFHexString.of(id)]);
  return pdf.save({ useObjectStreams: false });
}
