// netlify/functions/submission-created.js
import sg from "@sendgrid/mail";

// --- Configuration ---
// Ensure your environment variables are set in the Netlify UI:
// SENDGRID_API_KEY: Your SendGrid API key.
// FROM_EMAIL: A verified sender email address in your SendGrid account.
// TO_EMAIL: A comma-separated list of recipient email addresses.
const TO_EMAILS = (process.env.TO_EMAIL || "steve@quirkcars.com,gmcintosh@quirkcars.com,lmendez@quirkcars.com").split(',');
const FROM_EMAIL = process.env.FROM_EMAIL;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

sg.setApiKey(SENDGRID_API_KEY || "");

/**
 * Main function handler for the 'submission-created' event.
 */
export async function handler(event) {
  // 1. Check for required configuration
  if (!SENDGRID_API_KEY || !FROM_EMAIL || TO_EMAILS.length === 0) {
    console.error("Missing required environment variables (SENDGRID_API_KEY, FROM_EMAIL, TO_EMAIL).");
    return {
      statusCode: 500,
      body: "Server configuration error: Missing API keys or email configuration.",
    };
  }

  // 2. Safely parse the incoming submission data
  let payload;
  try {
    payload = JSON.parse(event.body || "{}").payload || {};
  } catch (error) {
    console.error("Invalid webhook payload:", error);
    return { statusCode: 400, body: "Invalid webhook payload" };
  }

  const data = payload.data || {};
  const files = payload.files || [];

  // 3. Generate email content from form data
  const { subject, htmlBody, textBody } = createEmailContent(data);

  // 4. Process and fetch file attachments
  let attachments = [];
  if (files.length > 0) {
    try {
      attachments = await processAttachments(files);
    } catch (error) {
      console.error("Failed to process attachments:", error);
      // Decide if you still want to send the email without attachments
      // For now, we'll continue and just log the error.
    }
  }

  const filesHtml = files.length > 0
    ? `<ul>${files.map(f => `<li><a href="${f.url}">${f.filename || f.url}</a></li>`).join("")}</ul>`
    : `<p>No photos uploaded.</p>`;

  // 5. Send the email using SendGrid
  try {
    await sg.send({
      to: TO_EMAILS,
      from: FROM_EMAIL,
      subject,
      text: `${textBody}\n\nPhotos:\n${files.map(f => f.url).join("\n") || "No photos uploaded."}`,
      html: `${htmlBody}<h3 style="margin-top:16px;">Photos</h3>${filesHtml}`,
      attachments: attachments.length ? attachments : undefined,
    });
  } catch (error) {
    // Log detailed error information from SendGrid
    console.error("SendGrid API Error:", JSON.stringify(error.response?.body || error.message, null, 2));
    return { statusCode: 502, body: "Failed to send email via provider." };
  }

  // 6. (Optional) Trigger backup webhook
  await triggerBackupWebhook(data, files);

  return { statusCode: 200, body: "ok" };
}


/**
 * Creates the subject, HTML body, and text body for the email.
 * @param {object} data - The form submission data.
 * @returns {{subject: string, htmlBody: string, textBody: string}}
 */
function createEmailContent(data) {
  const included = new Set(["form-name", "company", "bot-field", "honeypot"]);
  const rows = [];
  const hasVal = (v) => v !== undefined && v !== null && String(v).trim() !== "";

  // Sort keys for consistent email layout
  Object.keys(data).sort().forEach(k => {
    if (included.has(k)) return;
    const v = data[k];
    if (hasVal(v)) {
      rows.push([k, Array.isArray(v) ? v.join(", ") : String(v)]);
    }
  });

  const htmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const htmlBody = `
    <h2 style="margin:0 0 12px 0;font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial;">New Trade-In Lead</h2>
    <table cellpadding="6" cellspacing="0" border="0" style="border-collapse:collapse;">
      ${rows.map(([k, v]) => `
        <tr>
          <th align="left" style="text-transform:capitalize;font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial;font-size:14px;color:#111827;padding:6px 10px 6px 0;">${htmlEscape(k)}</th>
          <td style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial;font-size:14px;color:#111827;padding:6px 0;">${htmlEscape(v)}</td>
        </tr>
      `).join("")}
    </table>
  `;

  const textBody = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  const subject = `New Trade-In Lead – ${data.year || ""} ${data.make || ""} ${data.model || ""}`.replace(/\s+/g, " ").trim();

  return { subject, htmlBody, textBody };
}

/**
 * Fetches uploaded files and prepares them for SendGrid attachments.
 * @param {Array<object>} files - Array of file objects from Netlify.
 * @returns {Promise<Array<object>>} - A promise that resolves to an array of SendGrid attachment objects.
 */
async function processAttachments(files) {
  const MAX_ATTACH = 10;
  const MAX_EACH_MB = 7;
  const MAX_TOTAL_MB = 20;

  const attachments = [];
  let totalSize = 0;

  const fetchPromises = files.slice(0, MAX_ATTACH).map(async (file) => {
    try {
      const response = await fetch(file.url);
      if (!response.ok) {
        console.warn(`Failed to fetch attachment from ${file.url}, status: ${response.status}`);
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const size = buffer.byteLength;

      if (size > MAX_EACH_MB * 1024 * 1024) {
        console.warn(`Skipping attachment ${file.filename} as it exceeds the ${MAX_EACH_MB}MB limit.`);
        return null;
      }
      if (totalSize + size > MAX_TOTAL_MB * 1024 * 1024) {
        console.warn(`Skipping attachment ${file.filename} as it would exceed the total ${MAX_TOTAL_MB}MB limit.`);
        return null;
      }
      totalSize += size;

      return {
        // *** THIS IS THE FIX ***
        // The original code had `Buffer.from(buffer)`, which is incorrect.
        // `buffer` is already a Buffer, so we just need to Base64-encode it.
        content: buffer.toString("base64"),
        filename: file.filename,
        type: file.type || "application/octet-stream",
        disposition: "attachment",
      };
    } catch (error) {
      console.error(`Error processing attachment ${file.url}:`, error);
      return null;
    }
  });

  const results = await Promise.all(fetchPromises);
  return results.filter(Boolean); // Filter out any nulls from failed fetches/skips
}

/**
 * (Optional) Sends submission data to a backup service like Google Sheets.
 * @param {object} data - The form submission data.
 * @param {Array<object>} files - The array of file objects.
 */
async function triggerBackupWebhook(data, files) {
  if (!process.env.SHEETS_WEBHOOK_URL) return;

  try {
    const fileUrls = files.map(f => f.url);
    const lead = { ...data, fileUrls, _ts: new Date().toISOString() };
    const secret = process.env.SHEETS_SHARED_SECRET;
    let url = process.env.SHEETS_WEBHOOK_URL;
    if (secret) {
      url += `?secret=${encodeURIComponent(secret)}`;
    }

    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lead),
    });
  } catch (error) {
    // Log but do not fail the function if the backup fails
    console.warn("Backup webhook failed:", error);
  }
}
