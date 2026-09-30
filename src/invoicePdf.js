import { jsPDF } from 'jspdf'

const euro = n => `${Number(n || 0).toFixed(2).replace('.', ',')} €`
const dateFr = value => value ? new Date(value).toLocaleDateString('fr-FR') : ''

export function createInvoicePdf({ invoice, company, lines }) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const left = 16, right = 194
  let y = 17
  const addText = (txt, x, yy, opts={}) => doc.text(String(txt ?? ''), x, yy, opts)

  doc.setFillColor(36, 75, 58); doc.roundedRect(15, 12, 53, 18, 4, 4, 'F')
  doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(12)
  addText(company.trade_name || company.name || 'Lézard du Jardin', 18, 23)
  doc.setTextColor(32,49,40)
  doc.setFontSize(23); doc.setFont('helvetica','bold'); addText(invoice.kind === 'credit_note' ? 'AVOIR' : 'FACTURE', right, 21, {align:'right'})
  doc.setFontSize(10); doc.setFont('helvetica','normal'); addText(invoice.number, right, 28, {align:'right'})
  y = 40

  doc.setFont('helvetica','bold'); doc.setFontSize(10); addText('ÉMETTEUR', left, y)
  doc.setFont('helvetica','normal'); y += 6
  const seller = [company.legal_name || company.name, company.address, `${company.postal_code || ''} ${company.city || ''}`.trim(), company.country || 'France', company.siret ? `SIRET : ${company.siret}` : '', company.vat_number ? `TVA : ${company.vat_number}` : '', company.email || ''].filter(Boolean)
  seller.forEach(t => { addText(t,left,y); y += 5 })

  const c = invoice.customer_json || {}
  let cy = 40
  doc.setFont('helvetica','bold'); addText('CLIENT', 112, cy); doc.setFont('helvetica','normal'); cy += 6
  const name = c.customer_type === 'company' ? (c.company_name || `${c.first_name||''} ${c.last_name||''}`.trim()) : `${c.first_name||''} ${c.last_name||''}`.trim()
  const cust = [name, c.siren ? `SIREN : ${c.siren}` : '', c.address, `${c.postal_code||''} ${c.city||''}`.trim(), c.country || 'France', c.email || '', c.phone || ''].filter(Boolean)
  cust.forEach(t => { addText(t,112,cy); cy += 5 })
  y = Math.max(y, cy) + 7

  doc.setDrawColor(222,216,202); doc.line(left,y,right,y); y+=7
  doc.setFontSize(9)
  addText(`Date d'émission : ${dateFr(invoice.issued_at)}`, left, y)
  addText(`Date de vente : ${dateFr(invoice.sale_date)}`, 80, y)
  y += 5
  addText('Nature de l’opération : livraison de biens', left, y)
  if(invoice.payment_method) addText(`Règlement : ${invoice.payment_method}`, right, y, {align:'right'})
  y += 9

  const columns = [
    {x:16,w:74,label:'Désignation'}, {x:91,w:16,label:'Qté'}, {x:108,w:25,label:'PU TTC'},
    {x:134,w:18,label:'TVA'}, {x:153,w:18,label:'Remise'}, {x:172,w:22,label:'Total TTC'}
  ]
  const header = () => {
    doc.setFillColor(238,243,239); doc.rect(15,y-5,180,8,'F'); doc.setFont('helvetica','bold'); doc.setFontSize(8)
    columns.forEach(col => addText(col.label,col.x,y))
    doc.setFont('helvetica','normal'); y += 6
  }
  header()
  lines.forEach((l, idx) => {
    if (y > 257) { doc.addPage(); y=20; header() }
    const qty = Number(l.quantity||0), price = Number(l.unit_price_ttc||0), disc = Number(l.discount_percent||0)
    const total = qty*price*(1-disc/100)
    const desc = doc.splitTextToSize(l.description || '', 72)
    const h = Math.max(7, desc.length*4.2)
    addText(desc,16,y)
    addText(qty.toString().replace('.',','), 98,y,{align:'right'})
    addText(euro(price),131,y,{align:'right'})
    addText(`${Number(l.vat_rate||0).toFixed(1).replace('.0','')} %`,150,y,{align:'right'})
    addText(`${disc.toFixed(0)} %`,169,y,{align:'right'})
    addText(euro(total),194,y,{align:'right'})
    y += h
    doc.setDrawColor(240,236,228); doc.line(15,y-2,195,y-2)
  })
  y += 5
  if (y > 235) { doc.addPage(); y=25 }
  const tx=130
  doc.setFontSize(10); doc.setFont('helvetica','normal')
  addText('Total HT',tx,y); addText(euro(invoice.total_ht),right,y,{align:'right'}); y+=6
  addText('TVA',tx,y); addText(euro(invoice.total_vat),right,y,{align:'right'}); y+=7
  doc.setFont('helvetica','bold'); doc.setFontSize(13); addText('TOTAL TTC',tx,y); addText(euro(invoice.total_ttc),right,y,{align:'right'}); y+=10

  doc.setFontSize(8); doc.setFont('helvetica','normal')
  if(invoice.delivery_mode) { addText(`Remise / livraison : ${invoice.delivery_mode}`,left,y); y+=5 }
  if(c.delivery_same === false && c.delivery_address) { addText(`Adresse de livraison : ${c.delivery_address}, ${c.delivery_postal_code||''} ${c.delivery_city||''}`,left,y); y+=5 }
  if(invoice.notes) { const nt=doc.splitTextToSize(`Note : ${invoice.notes}`,175); addText(nt,left,y); y += nt.length*4+2 }
  if(company.legal_footer){ const ft=doc.splitTextToSize(company.legal_footer,175); addText(ft,left,y); y+=ft.length*4+2 }
  if(company.payment_terms) { const pt=doc.splitTextToSize(company.payment_terms,175); addText(pt,left,y); y+=pt.length*4+2 }
  doc.setTextColor(109,117,111)
  addText(`Document généré par Facturier Foires Lézard du Jardin • Empreinte : ${(invoice.integrity_hash||'').slice(0,24)}`, left, 289)
  return doc.output('blob')
}
