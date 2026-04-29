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