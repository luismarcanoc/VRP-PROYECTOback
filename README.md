# VRP-PROYECTOback

Backend para Render, conectado a Neon.

## Comandos Render

- Build Command: `npm install`
- Start Command: `npm start`

## Variables de entorno (Render)

- `PORT` (Render la define automaticamente)
- `DATABASE_URL` (cadena de conexion de Neon)
- `GOOGLE_MAPS_API_KEY`
- `DISTRIBUTION_ORIGIN` (opcional)
- `FRONTEND_ORIGIN` (URL del frontend para CORS)
- `NEON_SOURCE_TABLE` (por defecto `DIRECCIONES Y RUTAS`)

### Auto deploy por cambios en DB (opcional)

Si quieres que el backend dispare un deploy automaticamente cuando detecta cambios en Neon:

- `AUTO_DEPLOY_ON_DB_CHANGE=true`
- `RENDER_DEPLOY_HOOK_URL=<tu deploy hook de render>`
- `DB_WATCH_INTERVAL_MS=120000` (cada 2 min)
- `AUTO_DEPLOY_COOLDOWN_MS=600000` (minimo 10 min entre deploys)
- `DB_CHANGE_WATCH_QUERY` (opcional, query SQL que retorne columna `signature`)

Nota: para evitar loops de redeploy, usa cooldown alto.

## Esquema en Neon

Ejecuta el SQL de:

- `db/schema.sql`

## Cargar datos iniciales desde Excel a Neon

1. Configura `DATABASE_URL` en tu terminal local.
2. Ejecuta:
   - `npm run import:excel`

Esto llena la tabla `clients` y desde ese momento el backend usa solo Neon.

## Endpoints

- `GET /api/health`
- `GET /api/routes`
- `GET /api/clients?route=...`
- `GET /api/errors`
- `PUT /api/clients/:key`
- `POST /api/optimize-route`