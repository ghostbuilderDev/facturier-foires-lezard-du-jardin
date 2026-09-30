# Facturier Foires — Lézard du Jardin v1.0

Application PWA de facturation terrain pour les foires et salons.

Cette version intègre directement le catalogue **389 produits Lézard du Jardin** issu du catalogue de repérage et associe chaque produit au QR `LDJ:P:<id_product>` des étiquettes foire.

## Ce qui est prêt

- Catalogue intégré : **389 produits**, référence, nom, catégorie, prix TTC, QR produit.
- **387 miniatures** intégrées ; 2 références sans image exploitable affichent un placeholder LDJ.
- Scanner QR produit avec la caméra du téléphone (Chrome/Android via `BarcodeDetector`).
- Un second scan du même produit augmente automatiquement la quantité.
- Recherche ultra-rapide par nom, référence, catégorie, n° catalogue ou ID.
- Catalogue local utilisable avec réseau faible / hors connexion après chargement de la PWA.
- Brouillon de vente persistant en local.
- QR client temporaire : le client saisit lui-même identité, adresse, e-mail, téléphone et adresse de livraison.
- Gestion des foires ; la foire sélectionnée reste mémorisée pour les ventes suivantes.
- Paiements : CB, espèces, chèque, virement, PayPal, plusieurs fois, autre.
- Remise par ligne, TVA, livraison / emporté / retrait.
- Numérotation chronologique atomique côté Supabase.
- PDF facture, stockage privé, empreinte SHA-256 et journal d'audit.
- Envoi automatique de la facture au client + copie entreprise via Resend.
- Historique, CA du jour et panier moyen.
- Partage du PDF depuis Android lorsque le navigateur le permet.
- PWA installable sur Android / iPhone / PC.

## Important : facturier, pas logiciel de caisse

Le projet est conçu comme **facturier de vente**. Il ne gère pas de fond de caisse, tiroir-caisse, clôture Z ou comptage d'espèces. Si son périmètre évolue vers un logiciel de caisse, la conformité correspondante doit être traitée séparément.

---

## Installation rapide avec Termux

Place le ZIP dans `Download`, puis :

```bash
termux-setup-storage
pkg update -y
pkg install -y nodejs-lts unzip git

cd ~/storage/downloads
unzip -o facturier-foires-lezard-du-jardin-v1.0.zip -d ~/facturier-ldj
cd ~/facturier-ldj/facturier-foires-lezard-du-jardin

npm install
cp .env.example .env
nano .env
```

Renseigne :

```env
VITE_SUPABASE_URL=https://VOTRE-PROJET.supabase.co
VITE_SUPABASE_ANON_KEY=VOTRE_CLE_ANON
```

Puis :

```bash
npm run dev -- --host 0.0.0.0
```

Sur le téléphone, ouvre l'URL locale affichée par Vite.

---

## Configuration Supabase — première installation

Dans le SQL Editor de Supabase, exécute :

```text
supabase/migrations/001_init.sql
```

Dans **Authentication**, active Email / Password et crée les comptes vendeurs nécessaires.

### Si la v0.1 avait déjà été installée

Exécute ensuite :

```text
supabase/migrations/002_upgrade_v1.sql
```

---

## Envoi automatique des factures

La fonction Edge est dans :

```text
supabase/functions/send-invoice/index.ts
```

Installation CLI et déploiement :

```bash
npm install -g supabase
supabase login
supabase link --project-ref VOTRE_PROJECT_REF
supabase secrets set RESEND_API_KEY=re_xxxxxxxxx
supabase secrets set MAIL_FROM="Lézard du Jardin <factures@votre-domaine.fr>"
supabase functions deploy send-invoice
```

Le domaine d'envoi doit être validé chez Resend.

---

## Déploiement GitHub Pages

Un workflow est fourni :

```text
.github/workflows/deploy-pages.yml
```

Créer dans GitHub → **Settings → Secrets and variables → Actions** :

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Puis activer GitHub Pages avec **Source = GitHub Actions**.

Le site doit être servi en HTTPS pour que l'accès caméra fonctionne correctement.

---

## Utilisation sur une foire

### Avant l'ouverture

1. Ouvrir l'application une fois avec Internet.
2. Choisir la foire dans l'onglet **Foires**.
3. Vérifier les mentions légales et l'e-mail de copie dans **Réglages**.
4. Scanner 2 ou 3 étiquettes QR pour vérifier caméra + prix.
5. Faire une facture test puis vérifier l'e-mail et le PDF.

### Pendant une vente

1. **Scanner QR produit**.
2. Re-scanner le même QR pour augmenter la quantité si nécessaire.
3. Afficher le **QR client** pour qu'il saisisse ses coordonnées.
4. Vérifier le panier, règlement, remise / livraison.
5. Appuyer sur **Facturer et envoyer**.
6. Le PDF est archivé et envoyé au client + copie entreprise.

Si le réseau tombe, continuer à scanner les produits et préparer le brouillon. La finalisation attend le retour de la connexion pour préserver la numérotation.

---

## Catalogue intégré

Fichiers :

- `src/catalogue.json` — catalogue embarqué dans l'application.
- `public/products/` — miniatures produit.
- `catalogue_389.csv` — copie lisible / contrôlable du catalogue intégré.

Le QR produit contient seulement un identifiant stable du type :

```text
LDJ:P:1907
```

Le nom et le prix sont lus dans le catalogue local. Une évolution de tarif nécessite donc une mise à jour du catalogue, pas du principe de scan.

## Deux images non intégrées

Les références suivantes étaient présentes dans le catalogue PDF sans image exploitable lors de l'extraction :

- `LDJ102879` — Bain à oiseau sur pied patiné bleu
- `LDJ748521` — Banc fer forgé fonte 2 places - patine gris vieilli

Elles restent parfaitement recherchables et scannables ; seule la vignette est remplacée par le placeholder LDJ.

---

## Vérification obligatoire avant utilisation réelle

Compléter dans **Réglages** : raison sociale, adresse, SIREN/SIRET, TVA intracommunautaire le cas échéant, téléphone, e-mail, e-mail de copie, préfixe de facture et mentions légales exactes.

Faire ensuite une facture test complète avant la première foire.


## QR client : adresse publique obligatoire (v1.1)

Un QR scanné par un autre téléphone ne doit jamais pointer vers `127.0.0.1` ou `localhost`, car ces adresses désignent le téléphone du client lui-même.

Dans `.env`, renseigner :

```env
VITE_PUBLIC_APP_URL=https://VOTRE_COMPTE.github.io/facturier-foires-lezard-du-jardin/
```

Pour un test temporaire avec deux téléphones connectés au **même Wi-Fi**, il est possible d'utiliser l'adresse réseau affichée par Vite, par exemple :

```env
VITE_PUBLIC_APP_URL=http://192.168.1.25:5173/
```

Puis redémarrer `npm run dev`. Pour une foire, utiliser l'URL HTTPS GitHub Pages afin que le QR fonctionne quel que soit le réseau du client.
