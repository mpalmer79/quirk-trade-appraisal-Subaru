// netlify/functions/trade-appraisal.js
import sg from "@sendgrid/mail";
import Busboy from "busboy";

sg.setApiKey(process.env.SENDGRID_API_KEY || "");

/* ----------------- helpers ----------------- */
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

const safe   = (v) => (typeof v === "string" ? v.trim() : "");
const digits = (v) => safe(v).replace(/\D/g, "");
const escape = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Parse multipart/form-data into { fields, files[] }, skipping empty file parts */
async function parseMultipart(event) {
  const contentType =
    event.headers["content-type"] ||
    event.headers["Content-Type"] ||
    "";

  const busboy = Busboy({ headers: { "content-type": contentType } });

  const fields = {};
  const files = []; // { field, filename, mimetype, buffer, size }

  const body = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64")
    : Buffer.from(event.body || "", "utf8");

  return new Promise((resolve, reject) => {
    busboy.on("field", (name, val) => { fields[name] = val; });

    busboy.on("file", (name, file, info) => {
      const { filename, mimeType } = info || {};
      const cleanName = (filename || "").trim();

      let size = 0;
      const chunks = [];

      file.on("data", (d) => {
        size += d.length;
        chunks.push(d);
      });

      // If a file hits Busboy's size limit, drain it
      file.on("limit", () => file.resume());

      file.on("end", () => {
        // ✅ Keep only actual user uploads (has name AND >0 bytes)
        if (cleanName && size > 0) {
          files.push({
            field: name,
            filename: cleanName,
            mimetype: mimeType || "application/octet-stream",
            buffer: Buffer.concat(chunks),
            size,
          });
        }
        // else: skip zero-byte or unnamed parts entirely
      });
    });

    busboy.on("error", reject);
    busboy.on("finish", () => resolve({ fields, files }));
    busboy.end(body);
  });
}

/** Normalize to your schema */
function normalizeLead(src) {
  return {
    name:  safe(src.name),
    email: safe(src.email),
    phone: digits(src.phoneRaw || src.phone).slice(0, 15),
    vin:   safe((src.vin || "").toUpperCase()),
    year:  safe(src.year),
    make:  safe(src.make),
    model: safe(src.model),
    trim:  safe(src.trim),
    mileage: safe(src.mileage),
    extColor: safe(src.extColor),
    intColor: safe(src.intColor),
    referrer: safe(src.referrer),
    landingPage: safe(src.landingPage),
    submittedAt: new Date().toISOString(),
  };
}

/** Build HTML + text tables (includes all provided fields) */
function buildEmailBodies(lead, rawData) {
  const preferred = [
    "name","email","phone","vin","year","make","model","trim","mileage",
    "extColor","intColor","title","keys","owners","accident","accidentRepair",
    "warnings","mech","cosmetic","interior","mods","smells","service",
    "tires","brakes","wear","utmSource","utmMedium","utmCampaign","utmTerm","utmContent",
    "referrer","landingPage","submittedAt"
  ];

  const merged = { ...rawData, ...lead }; // preserve normalized
  const included = new Set();
  const rows = [];

  preferred.forEach((k) => {
    const v = merged[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      rows.push([k, String(v)]);
      included.add(k);
    }
  });

  Object.keys(merged)
    .filter((k) => !included.has(k))
    .sort()
    .forEach((k) => {
      const v = merged[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        rows.push([k, String(v)]);
      }
    });

  const html = `
    <h2 style="margin:0 0 12px;font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial;">New Trade-In Lead</h2>
    <p style="margin:0 0 16px;color:#374151;">
      ${[lead.year, lead.make, lead.model].filter(Boolean).join(" ")}${lead.trim ? ` – ${escape(lead.trim)}` : ""}
    </p>
    <table cellpadding="6" cellspacing="0" border="0" style="border-collapse:collapse;font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial;font-size:14px;">
      ${rows.map(([k,v]) => `
        <tr>
          <th align="left" style="text-transform:capitalize;vertical-align:top;color:#111827;padding:6px 10px 6px 0;">${escape(k)}</th>
          <td style="vertical-align:top;color:#111827;padding:6px 0;">${escape(v)}</td>
        </tr>
      `).join("")}
    </table>
    <p style="margin-top:16px;color:#6B7280;font-size:12px;">Submitted at ${escape(lead.submittedAt)}</p>
  `;
  const text = rows.map(([k,v]) => `${k}: ${v}`).join("\n");
  return { html, text };
}

/** Convert parsed files to SendGrid attachments (cap 8), skipping empty/unnamed */
function toAttachments(files) {
  return files
    .filter(f =>
      f &&
      f.buffer &&
      f.buffer.length > 0 &&
      f.filename &&
      String(f.filename).trim()
    )
    .slice(0, 8)
    .map((f) => ({
      content: f.buffer.toString("base64"),
      filename: f.filename,
      type: f.mimetype || "application/octet-stream",
      disposition: "attachment",
    }));
}

/* ----------------- handler ----------------- */
export async function handler(event) {
  // CORS / method guards
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "ok" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: "Method Not Allowed" };
  }

  const ct = event.headers["content-type"] || event.headers["Content-Type"] || "";
  const isMultipart = ct.startsWith("multipart/form-data");

  let rawData = {};
  let uploads = [];

  // Parse body
  try {
    if (isMultipart) {
      const { fields, files } = await parseMultipart(event);
      rawData = fields;
      uploads = files;
    } else {
      rawData = JSON.parse(event.body || "{}");
    }
  } catch {
    return { statusCode: 400, headers, body: "Invalid request body" };
  }

  // Honeypot — silent success
  if ((safe(rawData.company) || "").trim()) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, silent: true }) };
  }

  // Normalize + required
  const lead = normalizeLead(rawData);
  if (!lead.name || !lead.email || !lead.phone || !lead.vin) {
    return { statusCode: 400, headers, body: "Missing required fields" };
  }

  // Build email
  const { html, text } = buildEmailBodies(lead, rawData);
  const att = toAttachments(uploads);
  const attachments = att.length ? att : undefined; // ✅ only include if there are real files
  const subjectLine = `New Trade-In Lead – ${lead.name} – ${[lead.year, lead.make, lead.model].filter(Boolean).join(" ")}`.trim();

  // Send email
  try {
    // allow comma-separated list in TO_EMAIL
    const recipients = (process.env.TO_EMAIL || "mpalmer@quirkcars.com, steve.obrien@quirkcars.com, jlombard@quirkcars.com, msalihovic@quirkcars.com, nway@quirkcars.com, gmcintosh@quirkcars.com, lmendez@quirkcars.com")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    await sg.send({
      to: recipients,                    // ✅ now uses TO_EMAIL from Netlify
      from: process.env.FROM_EMAIL,      // must be a verified sender in SendGrid
      subject: subjectLine,
      text,
      html,
      attachments,                       // photos ride along if present
      // replyTo: "sales@quirkcars.com",
    });
  } catch (e) {
    return { statusCode: 502, headers, body: "Failed to send lead" };
  }

  // Optional: Sheets backup
  try {
    if (process.env.SHEETS_WEBHOOK_URL) {
      const u = process.env.SHEETS_SHARED_SECRET
        ? `${process.env.SHEETS_WEBHOOK_URL}?secret=${encodeURIComponent(process.env.SHEETS_SHARED_SECRET)}`
        : process.env.SHEETS_WEBHOOK_URL;

      await fetch(u, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lead),
      });
    }
  } catch {
    // ignore backup errors
  }

  // --- Success response ---
  const wantsJson =
    (event.headers["accept"] || "").includes("application/json") ||
    (event.headers["x-requested-with"] || "").toLowerCase() === "xmlhttprequest";

  if (wantsJson) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, files: (attachments ? attachments.length : 0) }) };
  }
  return {
    statusCode: 303,
    headers: { ...headers, Location: "/success/index.html" },
    body: "",
  };
}
