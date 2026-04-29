const path = require("path");
const XLSX = require("xlsx");
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "";
const WORKBOOK_PATH = process.env.WORKBOOK_PATH || path.join(__dirname, "..", "DIRECCIONES Y RUTAS (1).xlsx");

if (!DATABASE_URL) {
    throw new Error("Falta DATABASE_URL.");
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

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

function detectColumns(row) {
    const map = {};
    Object.keys(row).forEach((key) => {
        map[normalizeHeader(key)] = key;
    });
    return {
        id: map.clientes || map.cientes || "CLIENTES",
        name: map["nombre o razon social"] || "NOMBRE O RAZON SOCIAL",
        address: map.direccion || "DIRECCION",
        route: map["ruta asignada"] || map.ruta || "RUTA",
        transport: map.transporte || "TRANSPORTE"
    };
}

async function run() {
    const workbook = XLSX.readFile(WORKBOOK_PATH);
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("DELETE FROM clients");

        for (const sheetName of workbook.SheetNames) {
            const ws = workbook.Sheets[sheetName];
            const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

            for (let idx = 0; idx < rows.length; idx += 1) {
                const row = rows[idx];
                const columns = detectColumns(row);
                const clientId = normalizeText(row[columns.id]) || `SIN_ID_${sheetName}_${idx + 2}`;
                const key = `${sheetName}::${clientId}`;
                await client.query(
                    `INSERT INTO clients (
                        client_key, sheet_name, row_number, client_id, name, address, route_name, transport
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                    [
                        key,
                        sheetName,
                        idx + 2,
                        clientId,
                        normalizeText(row[columns.name]),
                        normalizeText(row[columns.address]),
                        normalizeText(row[columns.route]),
                        normalizeText(row[columns.transport])
                    ]
                );
            }
        }

        await client.query("COMMIT");
        console.log("Importacion a Neon completada.");
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error importando Excel:", error.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

run();
