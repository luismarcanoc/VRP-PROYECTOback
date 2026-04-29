const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const DISTRIBUTION_ORIGIN = process.env.DISTRIBUTION_ORIGIN || "Planta Bello Campo, Caracas, Venezuela";

const DATABASE_URL = process.env.DATABASE_URL || "";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

if (!DATABASE_URL) {
    throw new Error("Falta DATABASE_URL para conectar con Neon.");
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(cors({ origin: FRONTEND_ORIGIN === "*" ? true : FRONTEND_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

function normalizeHeader(value) {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

function normalizeText(value) {
    return String(value || "").trim();
}

function mapClientRow(row) {
    return {
        key: row.client_key,
        sheet: row.sheet_name,
        rowNumber: row.row_number,
        clientId: row.client_id,
        name: row.name,
        address: row.address,
        route: row.route_name,
        transport: row.transport
    };
}

async function getClients(route) {
    const values = [];
    let where = "";
    if (route) {
        values.push(route);
        where = `WHERE route_name = $1`;
    }
    const query = `
        SELECT client_key, sheet_name, row_number, client_id, name, address, route_name, transport
        FROM clients
        ${where}
        ORDER BY route_name, name
    `;
    const result = await pool.query(query, values);
    return result.rows.map(mapClientRow);
}

function isClientWithErrors(client) {
    const route = normalizeHeader(client.route);
    const missingFields = !client.clientId || !client.name || !client.address || !client.route;
    return missingFields || route.includes("revisar manualmente");
}

async function routeStats() {
    const query = `
        SELECT route_name AS route, COUNT(*)::int AS "totalClients"
        FROM clients
        GROUP BY route_name
        ORDER BY route_name
    `;
    const result = await pool.query(query);
    return result.rows;
}

async function getDistance(origin, destination) {
    if (!GOOGLE_MAPS_API_KEY) {
        throw new Error("Falta GOOGLE_MAPS_API_KEY en variables de entorno.");
    }
    const params = new URLSearchParams({
        origins: origin,
        destinations: destination,
        key: GOOGLE_MAPS_API_KEY,
        language: "es"
    });
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google API HTTP ${response.status}`);
    const payload = await response.json();
    const element = payload?.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK") {
        throw new Error(`Google API sin resultado para: ${destination}`);
    }
    return {
        meters: element.distance.value,
        distanceText: element.distance.text,
        durationText: element.duration.text
    };
}

async function optimizeRoute(clients, originAddress) {
    const pending = clients
        .filter((c) => c.address)
        .slice(0, 22)
        .map((client) => ({ ...client }));

    const optimized = [];
    let currentOrigin = originAddress;
    let totalMeters = 0;

    while (pending.length > 0) {
        const distances = await Promise.all(
            pending.map(async (client) => {
                const distance = await getDistance(currentOrigin, client.address);
                return { client, distance };
            })
        );

        distances.sort((a, b) => a.distance.meters - b.distance.meters);
        const best = distances[0];
        totalMeters += best.distance.meters;
        optimized.push({
            ...best.client,
            legDistanceMeters: best.distance.meters,
            legDistanceText: best.distance.distanceText,
            legDurationText: best.distance.durationText
        });

        currentOrigin = best.client.address;
        const removeIndex = pending.findIndex((client) => client.key === best.client.key);
        pending.splice(removeIndex, 1);
    }

    return {
        origin: originAddress,
        totalClients: optimized.length,
        totalDistanceKm: Number((totalMeters / 1000).toFixed(2)),
        sequence: optimized
    };
}

app.get("/api/health", async (_, res) => {
    try {
        await pool.query("SELECT 1");
        res.json({ ok: true, service: "vrp-proyectoback", db: "connected" });
    } catch (error) {
        res.status(500).json({ ok: false, error: String(error.message || error) });
    }
});

app.get("/api/routes", async (_, res) => {
    try {
        res.json({ routes: await routeStats() });
    } catch (error) {
        res.status(500).json({ ok: false, error: String(error.message || error) });
    }
});

app.get("/api/clients", async (req, res) => {
    try {
        const route = normalizeText(req.query.route);
        const clients = await getClients(route);
        res.json({ total: clients.length, clients });
    } catch (error) {
        res.status(500).json({ ok: false, error: String(error.message || error) });
    }
});

app.get("/api/errors", async (_, res) => {
    try {
        const clients = (await getClients("")).filter(isClientWithErrors);
        res.json({ total: clients.length, clients });
    } catch (error) {
        res.status(500).json({ ok: false, error: String(error.message || error) });
    }
});

app.put("/api/clients/:key", async (req, res) => {
    try {
        const key = decodeURIComponent(req.params.key);
        const { name, address, route, transport } = req.body || {};
        await pool.query(
            `UPDATE clients
             SET name = $2, address = $3, route_name = $4, transport = $5, updated_at = NOW()
             WHERE client_key = $1`,
            [key, normalizeText(name), normalizeText(address), normalizeText(route), normalizeText(transport)]
        );
        res.json({ ok: true, key });
    } catch (error) {
        res.status(500).json({ ok: false, error: String(error.message || error) });
    }
});

app.post("/api/optimize-route", async (req, res) => {
    try {
        const route = normalizeText(req.body?.route);
        const origin = normalizeText(req.body?.origin) || DISTRIBUTION_ORIGIN;
        if (!route) {
            res.status(400).json({ ok: false, error: "Debes enviar route." });
            return;
        }

        const clients = (await getClients(route)).filter((client) => client.address);
        if (!clients.length) {
            res.status(404).json({ ok: false, error: `No hay clientes con direccion para la ruta ${route}.` });
            return;
        }

        const optimized = await optimizeRoute(clients, origin);
        res.json({ ok: true, route, optimized });
    } catch (error) {
        res.status(500).json({ ok: false, error: String(error.message || error) });
    }
});

app.listen(PORT, () => {
    console.log(`VRP backend activo en puerto ${PORT}`);
});
