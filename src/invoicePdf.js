import { jsPDF } from 'jspdf'

const euro = n => `${Number(n || 0).toFixed(2).replace('.', ',')} €`
const dateFr = value => value ? new Date(value).toLocaleDateString('fr-FR') : ''

// Logo original repris du site officiel Lézard du Jardin.
// Le fichier doit rester dans public/logo-ldj.png.
let logoPromise = null
function readLogoAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
function loadLdJLogo() {
  if (!logoPromise) {
    logoPromise = fetch(new URL('./logo-ldj.png', window.location.href))
      .then(response => {
        if (!response.ok) throw new Error('Logo introuvable')
        return response.blob()
      })
      .then(readLogoAsDataURL)
      .catch(() => null)
  }
  return logoPromise
}

export async function createInvoicePdf({ invoice, company, lines }) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const left = 16, right = 194
  let y = 17
  const addText = (txt, x, yy, opts={}) => doc.text(String(txt ?? ''), x, yy, opts)

  // Logo officiel : conserver les proportions de l'image, sans étirement.
  // Si l'image ne charge pas, la facture reste utilisable avec l'ancien cartouche.
  const originalLogo = await loadLdJLogo()
  let logoAdded = false
  if (originalLogo) {
    try {
      const img = doc.getImageProperties(originalLogo)
      const scale = Math.min(92 / img.width, 18 / img.height)
      doc.addImage(originalLogo, 'PNG', 15, 13, img.width * scale, img.height * scale)
      logoAdded = true
    } catch (error) {
      console.warn('Logo Lézard du Jardin non lisible, retour au cartouche texte', error)
    }
  }
  if (!logoAdded) {
    doc.setFillColor(36, 75, 58); doc.roundedRect(15, 12, 58, 18, 4, 4, 'F')
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(12)
    addText(company.trade_name || company.name || 'Lézard du Jardin', 18, 23)
  }
  doc.setTextColor(32,49,40)
  doc.setFontSize(23); doc.setFont('helvetica','bold'); addText(invoice.kind === 'credit_note' ? 'AVOIR' : 'FACTURE', right, 21, {align:'right'})
  doc.setFontSize(10); doc.setFont('helvetica','normal'); addText(invoice.number, right, 28, {align:'right'})
  y = 43

  doc.setFont('helvetica','bold'); doc.setFontSize(10); addText('ÉMETTEUR', left, y)
  doc.setFont('helvetica','normal'); y += 6
  const seller = [
    company.legal_name || company.name || 'LEZARD DU JARDIN',
    company.address,
    `${company.postal_code || ''} ${company.city || ''}`.trim(),
    company.country || 'France',
    company.siren ? `SIREN : ${company.siren}` : '',
    company.siret ? `SIRET : ${company.siret}` : '',
    company.siren ? `RCS Saintes : ${company.siren}` : '',
    company.vat_number ? `TVA intracom. : ${company.vat_number}` : '',
    company.email || '',
    company.phone || ''
  ].filter(Boolean)
  seller.forEach(t => { addText(t,left,y); y += 4.7 })

  const c = invoice.customer_json || {}
  let cy = 40
  doc.setFont('helvetica','bold'); addText('CLIENT', 112, cy); doc.setFont('helvetica','normal'); cy += 6
  const name = c.customer_type === 'company' ? (c.company_name || `${c.first_name||''} ${c.last_name||''}`.trim()) : `${c.first_name||''} ${c.last_name||''}`.trim()
  const cust = [
    name,
    c.customer_type === 'company' && c.siren ? `SIREN : ${c.siren}` : '',
    c.customer_type === 'company' && c.vat_number ? `TVA intracom. : ${c.vat_number}` : '',
    c.address,
    `${c.postal_code||''} ${c.city||''}`.trim(),
    c.country || 'France',
    c.email || '',
    c.phone || ''
  ].filter(Boolean)
  cust.forEach(t => { addText(t,112,cy); cy += 4.7 })
  y = Math.max(y, cy) + 6

  doc.setDrawColor(222,216,202); doc.line(left,y,right,y); y+=7
  doc.setFontSize(9)
  addText(`Date d'émission : ${dateFr(invoice.issued_at)}`, left, y)
  addText(`Date de vente : ${dateFr(invoice.sale_date)}`, 80, y)
  y += 5
  addText('Nature de l’opération : livraison de biens', left, y)
  if(invoice.payment_method) addText(`Règlement : ${invoice.payment_method}`, right, y, {align:'right'})
  y += 9

  const columns = [
    {x:16,w:72,label:'Désignation'}, {x:89,w:14,label:'Qté'}, {x:105,w:26,label:'PU HT'},
    {x:133,w:18,label:'TVA'}, {x:153,w:18,label:'Remise'}, {x:173,w:21,label:'Total TTC'}
  ]
  const header = () => {
    doc.setFillColor(238,243,239); doc.rect(15,y-5,180,8,'F'); doc.setFont('helvetica','bold'); doc.setFontSize(8)
    columns.forEach(col => addText(col.label,col.x,y))
    doc.setFont('helvetica','normal'); y += 6
  }
  header()
  lines.forEach(l => {
    if (y > 252) { doc.addPage(); y=20; header() }
    const qty = Number(l.quantity||0), priceTtc = Number(l.unit_price_ttc||0), disc = Number(l.discount_percent||0), vat = Number(l.vat_rate||0)
    const unitHt = vat === -100 ? priceTtc : priceTtc/(1+vat/100)
    const totalTtc = qty*priceTtc*(1-disc/100)
    const descText = `${l.sku ? l.sku+' — ' : ''}${l.description || ''}`
    const desc = doc.splitTextToSize(descText, 70)
    const h = Math.max(7, desc.length*4.2)
    addText(desc,16,y)
    addText(qty.toString().replace('.',','), 101,y,{align:'right'})
    addText(euro(unitHt),130,y,{align:'right'})
    addText(`${vat.toFixed(1).replace('.0','')} %`,150,y,{align:'right'})
    addText(`${disc.toFixed(0)} %`,170,y,{align:'right'})
    addText(euro(totalTtc),194,y,{align:'right'})
    y += h
    doc.setDrawColor(240,236,228); doc.line(15,y-2,195,y-2)
  })
  y += 5
  if (y > 220) { doc.addPage(); y=25 }
  const tx=130
  doc.setFontSize(10); doc.setFont('helvetica','normal')
  addText('Total HT',tx,y); addText(euro(invoice.total_ht),right,y,{align:'right'}); y+=6
  addText('TVA',tx,y); addText(euro(invoice.total_vat),right,y,{align:'right'}); y+=7
  doc.setFont('helvetica','bold'); doc.setFontSize(13); addText('TOTAL TTC',tx,y); addText(euro(invoice.total_ttc),right,y,{align:'right'}); y+=10

  doc.setFontSize(8); doc.setFont('helvetica','normal')
  if(invoice.delivery_mode) { addText(`Remise / livraison : ${invoice.delivery_mode}`,left,y); y+=5 }
  if(c.delivery_same === false && c.delivery_address) { const dl=doc.splitTextToSize(`Adresse de livraison : ${c.delivery_address}, ${c.delivery_postal_code||''} ${c.delivery_city||''}`,175); addText(dl,left,y); y+=dl.length*4+1 }
  if(invoice.notes) { const nt=doc.splitTextToSize(`Note : ${invoice.notes}`,175); addText(nt,left,y); y += nt.length*4+2 }

  const payment = company.payment_terms || 'Paiement comptant à la vente. Aucun escompte pour paiement anticipé.'
  const pt=doc.splitTextToSize(`Conditions de paiement : ${payment}`,175); addText(pt,left,y); y+=pt.length*4+2
  if(c.customer_type === 'company'){
    const pro=doc.splitTextToSize('Clients professionnels : pénalités de retard exigibles dès le lendemain de l’échéance au taux BCE de refinancement le plus récent majoré de 10 points. Indemnité forfaitaire pour frais de recouvrement : 40 €.',175)
    addText(pro,left,y); y+=pro.length*4+2
  }
  if(company.legal_footer){ const ft=doc.splitTextToSize(company.legal_footer,175); addText(ft,left,y); y+=ft.length*4+2 }
  doc.setTextColor(109,117,111)
  addText(`Document généré par Facturier Foires Lézard du Jardin • Empreinte : ${(invoice.integrity_hash||'').slice(0,24)}`, left, 289)
  return doc.output('blob')
}
