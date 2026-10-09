## Mise à jour v1.5 - logo officiel + remise à zéro des essais

Le ZIP v1.5 remplace les anciennes versions. Exécuter `update_termux.sh` depuis le dossier extrait. Puis ouvrir `reset-tests.html` sur la page GitHub Pages après déploiement, copier et exécuter le SQL.

Ne lancer le SQL que si **les quatre factures 000001 à 000004 sont réellement des essais**. Le script stoppe si les données attendues ne correspondent pas. Il nettoie aussi les ventes rapides de test de l'espace sélectionné (max 20), mais conserve les 389 produits, le QR permanent, le compte, les événements et les réglages.

Le logo horizontal original est livré dans `public/logo-ldj.png`.
Les nouveaux PDF sont enregistrés avec un suffixe UUID pour éviter des collisions avec de vieux PDF de tests encore physiquement présents dans le Storage privé Supabase.

---

# Facturier Foires — Lézard du Jardin v1.5

Application PWA terrain pour les foires et salons, avec catalogue **389 produits** et QR `LDJ:P:<id_product>`.

## Principe v1.4

La vente courante est désormais une **vente rapide**, pas une facture systématique.

### Vente rapide
1. Scanner les QR produits ou rechercher un article.
2. Ajuster quantité, prix/remise si nécessaire.
3. Choisir le règlement.
4. Appuyer sur **Enregistrer la vente**.

La vente est enregistrée avec date, heure, foire, règlement, articles, quantités, prix HT/TVA/TTC. **Aucun client, PDF ou e-mail n'est demandé.**

### Facture uniquement à la demande
Si le client veut une facture, utiliser **Le client veut une facture**. Le panier reste intact et le mode facture permet :
- QR client temporaire ;
- QR permanent sur affiche ;
- file **Clients en attente** ;
- génération PDF ;
- archivage Supabase ;
- envoi e-mail via Resend.

### QR permanent
Plusieurs clients peuvent remplir leurs coordonnées en même temps. Chaque scan crée une session indépendante. Le vendeur choisit ensuite le bon client dans **Clients en attente**.

### Suivi journée
L'onglet **Journée** additionne :
- ventes rapides ;
- factures demandées ;
- nombre d'articles ;
- CA HT / TVA / TTC ;
- panier moyen ;
- répartition des règlements ;
- détail chronologique heure / produit / quantité / prix ;
- export CSV.

Une facture réalisée à la demande n'est pas enregistrée en plus comme vente rapide : il n'y a donc pas de double comptage.

## Mise à jour depuis la version actuelle

Télécharger `facturier-foires-lezard-du-jardin-v1.4.zip` dans Android/Download puis exécuter :

```bash
cd ~/storage/downloads && rm -rf facturier-ldj-v1.4 && mkdir facturier-ldj-v1.4 && unzip -o facturier-foires-lezard-du-jardin-v1.4.zip -d facturier-ldj-v1.4 && bash facturier-ldj-v1.4/update_termux.sh
```

Le script conserve le `.env`, copie la mise à jour, installe/vérifie les dépendances, lance le build puis pousse sur GitHub si le dépôt local est présent.

## Migration Supabase

Dans **Supabase > SQL Editor**, exécuter une seule fois :

```text
supabase/migrations/005_ldj_v1_4.sql
```

La migration **005 est cumulative** : si la v1.3 n'a pas été installée, ne pas lancer 004 avant.

Elle ajoute notamment :
- QR permanent multi-clients ;
- traçabilité produit des factures ;
- tables `sales` / `sale_lines` pour les ventes rapides ;
- RPC atomique `record_quick_sale` ;
- journal d'audit associé.

## Envoi e-mail des factures

La fonction Edge reste `supabase/functions/send-invoice/index.ts`. Les secrets Supabase requis sont :
- `RESEND_API_KEY`
- `MAIL_FROM`

Le domaine `lezarddujardin.fr` doit rester vérifié dans Resend.

## Catalogue

- `src/catalogue.json` : 389 produits embarqués.
- `public/products/` : miniatures.
- `catalogue_389.csv` : copie contrôlable.

## Important

Cette application contient désormais une fonction de mémorisation des ventes et règlements. Avant de l'utiliser comme **logiciel ou système de caisse** au sens fiscal, vérifier les obligations françaises applicables à ton entreprise (inaltérabilité, sécurisation, conservation, archivage et justificatif de conformité).
