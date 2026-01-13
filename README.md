# Precipitation / Météo GRIB2 → PNG (React + Leaflet)

Démo locale pour afficher des champs météo issus de fichiers **GRIB2** (Météo-France Open Data ou équivalent) sous forme d’**overlay PNG** sur une carte **Leaflet**.

Le projet est un monorepo :

- `client/` : application React + Vite + React-Leaflet
- `server/` : API Express qui convertit GRIB2 → NetCDF → GeoTIFF → PNG (cache disque)

## Fonctionnalités

- **Carte Leaflet** avec overlay raster (PNG) recalé sur la France.
- **Sélection d’heure** via un slider (08H → 15H).
- **Animation Play/Pause** (boucle sur 08H → 15H) avec transitions (fondu) et préchargement.
- **Sélection du paramètre (liste déroulante)** :
  - `CAPE` — Orages, pluie intense
  - `RPRATE` — Pluie liquide (Cumuls)
  - `SPRATE` — Neige (Total précip)
  - `GPRATE` — Grésil (Spécifique)
  - `LCDC` — Nuages bas
  - `PRES` — Pression
- **Cache disque** : génération d’un PNG **par variable et par heure** dans `server/cache/`.
- **Mode “offline” (sans backend)** : si des PNG existent déjà dans `server/cache/`, le client peut les charger via l’URL `/local-cache/...` servie par Vite.

## previsualisation
<img width="1168" height="902" alt="image" src="https://github.com/user-attachments/assets/456e86ef-6fcb-40f4-95d8-3abd32232649" />


## Structure des fichiers

### GRIB horaires (entrée)

Place tes fichiers GRIB2 dans :

- `server/data/08H.grib2`
- …
- `server/data/15H.grib2`

Le serveur peut aussi utiliser `server/data/precip.grib2` comme fichier par défaut.

### PNG de sortie (cache)

Les fichiers générés sont stockés dans :

- `server/cache/<var>_<HH>H_color.png`

Exemples :

- `server/cache/rprate_08H_color.png`
- `server/cache/cape_10H_color.png`
- `server/cache/lcdc_15H_color.png`

## Prérequis

- Node.js (npm)
- **Pour la conversion GRIB2 → PNG** (backend) :
  - `wgrib2`
  - `gdalwarp`, `gdaldem`, `gdalinfo` (GDAL)

Le projet inclut un `wgrib2.exe` dans `wgrib2/` (selon ton installation), mais GDAL doit être disponible dans le `PATH` (ou via variables d’environnement).

## Installation

Depuis la racine :

```bash
npm install
npm --prefix client install
npm --prefix server install
```

## Développement

### 1) Lancer uniquement le client (recommandé)

```bash
npm run dev
```

- Client : http://localhost:5173
- Le client tente d’utiliser le backend via `/api/...`.
- Si le backend est indisponible mais que des PNG existent dans `server/cache/`, le client peut basculer en mode offline (chargement via `/local-cache/...`).

### 2) Lancer uniquement le serveur

```bash
npm run dev:server
```

Serveur : http://localhost:3001

### 3) Lancer client + serveur

```bash
npm run dev:all
```

## Build (client)

Le build Vite se fait dans `client/dist/`.

Depuis la racine :

```bash
npm --prefix client run build
```

Prévisualiser le build :

```bash
npm --prefix client run preview
```

## API (backend)

### Meta

```text
GET /api/precip/meta?hour=08&var=RPRATE
```

Retourne : `updatedAt`, `bounds`, `message`, etc.

### Overlay PNG

```text
GET /api/precip/overlay.png?hour=08&var=RPRATE
```

## Variables d’environnement utiles (backend)

- `PORT` : port du serveur (défaut `3001`)
- `GRIB_FILE` : fichier GRIB par défaut (défaut `server/data/precip.grib2`)
- `DEFAULT_VAR` : variable par défaut (défaut `RPRATE`)
- `GRIB_MATCHES` : liste de `-match` pour `wgrib2` (séparée par des virgules). Utilisé comme fallback générique.

Notes :

- Pour `RPRATE`, le serveur tente automatiquement `:RPRATE:` puis `:PRATE:` puis `:APCP:`.

## Dépannage

- Si le backend ne génère pas de PNG :
  - vérifier que `wgrib2` et GDAL sont installés et accessibles
  - regarder le champ `message` retourné par `/api/precip/meta`
- Si le mode offline ne trouve pas les fichiers :
  - vérifier que `server/cache/<var>_<HH>H_color.png` existe
  - tester directement : `http://localhost:5173/local-cache/rprate_08H_color.png`
