# VRP-PROYECTOback

Backend para Render, conectado a la base PostgreSQL central del proyecto.

## Comandos Render

- Build Command: `npm install`
- Start Command: `npm start`

## Variables de entorno (Render)

- `PORT` (Render la define automaticamente)
- `DATABASE_URL` (cadena de conexion PostgreSQL; soporta `sslmode=disable`)
- `NODE_ENV` (`development` o `production`)
- `GOOGLE_MAPS_SERVER_API_KEY` (Routes API)
- `GOOGLE_MAPS_BROWSER_API_KEY` (Maps JavaScript API)
- `GOOGLE_MAPS_API_KEY` (compatibilidad opcional para clave de servidor)
- `DISTRIBUTION_ORIGIN` (opcional)
- `FRONTEND_ORIGIN` (URL del frontend para CORS)
- `SOURCE_TABLE` (por defecto `hojas_ruta_exportadas`)

### Auto deploy por cambios en DB (opcional)

Si quieres que el backend dispare un deploy automaticamente cuando detecta cambios en la tabla fuente:

- `AUTO_DEPLOY_ON_DB_CHANGE=true`
- `RENDER_DEPLOY_HOOK_URL=<tu deploy hook de render>`
- `DB_WATCH_INTERVAL_MS=120000` (cada 2 min)
- `AUTO_DEPLOY_COOLDOWN_MS=600000` (minimo 10 min entre deploys)
- `DB_CHANGE_WATCH_QUERY` (opcional, query SQL que retorne columna `signature`)

Nota: para evitar loops de redeploy, usa cooldown alto.

## Esquema

La fuente de rutas es `hojas_ruta_exportadas`; cada parada se lee desde `facturas[].direccion_texto`.
El backend crea automaticamente `client_overrides` cuando necesita guardar correcciones.

Para el esquema auxiliar histórico, consulta:

- `db/schema.sql`

## Cargar datos iniciales desde Excel

1. Configura `DATABASE_URL` en tu terminal local.
2. Ejecuta:
   - `npm run import:excel`

Este comando llena la tabla histórica `clients` en PostgreSQL; el grafo operativo usa `hojas_ruta_exportadas`.

## Endpoints

- `GET /api/health`
- `GET /api/routes`
- `GET /api/clients?route=...`
- `GET /api/errors`
- `PUT /api/clients/:key`
- `POST /api/optimize-route`
