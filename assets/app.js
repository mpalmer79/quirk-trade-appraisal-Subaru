/* assets/app.js
    Quirk Sight-Unseen Trade Tool — VIN decode + Netlify Forms submit
    - VIN decode (NHTSA VPIC) prefills Year/Make/Model/Trim
    - Auto-decodes when VIN reaches 17 chars; also on button click
    - Model loader for Make+Year (VPIC)
    - Case-insensitive select setting (adds missing option so value “sticks”)
    - Spanish toggle using sessionStorage ('quirk_lang') so language resets per tab
    - Logo SVG injection + recolor
*/

/* -------------------- Small utilities -------------------- */
const $ = (sel) => document.querySelector(sel);

function debounce(fn, wait = 500) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 15000, ...rest } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(resource, { ...rest, signal: controller.signal, mode: "cors", cache: "no-store" });
  } finally {
    clearTimeout(id);
  }
}

function validVin(v) {
  if (!v) return false;
  const s = String(v).trim().toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(s);
}

function setSelectValue(sel, val) {
  const el = typeof sel === "string" ? $(sel) : sel;
  if (!el) return;
  const v = String(val || "");
  const opts = Array.from(el.options);
  const found = opts.find((o) => o.value.toLowerCase() === v.toLowerCase());
  if (found) {
    el.value = found.value;
  } else if (v.trim()) {
    const opt = new Option(v, v, true, true);
    el.add(opt);
    el.value = v;
  }
}

function showToast(msg) {
  const t = $("#toast") || $("#modelStatus");
  if (t) { t.textContent = msg; }
}

/* -------------------- VIN Decode (robust) -------------------- */
// Primary: DecodeVinValuesExtended; Fallback: DecodeVin
async function decodeVin(vin) {
  const url1 = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`;
  const try1 = await fetchWithTimeout(url1);
  if (!try1.ok) throw new Error(`VIN decode failed (HTTP ${try1.status})`);
  const js1 = await try1.json();
  const r1 = js1 && js1.Results && js1.Results[0];
  if (r1) {
    const out = {
      year: r1.ModelYear || r1.Model_Year,
      make: r1.Make,
      model: r1.Model,
      trim: r1.Trim,
    };
    if (out.year || out.make || out.model || out.trim) return out;
  }

  // Fallback (rare)
  const url2 = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${encodeURIComponent(vin)}?format=json`;
  const try2 = await fetchWithTimeout(url2);
  if (!try2.ok) throw new Error(`VIN fallback failed (HTTP ${try2.status})`);
  const js2 = await try2.json();
  const r2 = js2 && js2.Results || [];
  const map = new Map(r2.map(x => [x.Variable, x.Value]));
  return {
    year: map.get("Model Year") || "",
    make: map.get("Make") || "",
    model: map.get("Model") || "",
    trim: map.get("Trim") || "",
  };
}

/* -------------------- Models for Make+Year -------------------- */
async function loadModelsFor(make, year) {
  const status = $("#modelStatus");
  const modelSel = $("#model");
  if (!modelSel) return;

  // Reset options
  modelSel.innerHTML = `<option value="" data-i18n="selectModel">Select Model</option>`;
  if (status) status.textContent = "";

  if (!make || !year) return;

  try {
    if (status) status.textContent = "Loading models…";
    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${encodeURIComponent(year)}?format=json`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const list = (data.Results || [])
      .map((r) => r.Model_Name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    for (const m of list) modelSel.add(new Option(m, m));
    if (status) status.textContent = list.length ? "" : "No models found for that Make/Year.";
  } catch (e) {
    if (status) status.textContent = "Could not load models.";
    console.error("Model load failed:", e);
  }
}

/* -------------------- Year/Make bootstrap (if blank in HTML) -------------------- */
function populateYearsIfEmpty() {
  const yearSel = $("#year");
  if (!yearSel || yearSel.options.length > 1) return;

  const thisYear = new Date().getFullYear();
  const min = thisYear - 30;
  yearSel.add(new Option("Select Year", ""), undefined);
  for (let y = thisYear + 1; y >= min; y--) {
    yearSel.add(new Option(String(y), String(y)));
  }
}

function bootstrapCommonMakesIfEmpty() {
  const makeSel = $("#make");
  if (!makeSel || makeSel.options.length > 1) return;

  const common = [
    "Chevrolet","GMC","Ford","Ram","Toyota","Honda","Nissan","Hyundai","Kia",
    "Jeep","Volkswagen","Subaru","Mazda","BMW","Mercedes-Benz","Audi","Dodge",
    "Chrysler","Buick","Cadillac","Lincoln","Volvo"
  ];
  makeSel.add(new Option("Select Make", ""), undefined);
  for (const m of common) makeSel.add(new Option(m, m));
}

/* -------------------- Wire up events on DOM ready -------------------- */
document.addEventListener("DOMContentLoaded", () => {
  // Global sentinel for VIN auto-decode (so we can reset it on Clear)
  window.__lastVin = "";

  // Bootstrap selects if needed
  populateYearsIfEmpty();
  bootstrapCommonMakesIfEmpty();

  const yearSel = $("#year");
  const makeSel = $("#make");
  const modelSel = $("#model");
  const trimInput = $("#trim");
  const vinInput = $("#vin");
  const decodeBtn = $("#decodeVinBtn");

  // When year/make change, refresh models
  if (yearSel && makeSel) {
    const refreshModels = debounce(() => loadModelsFor(makeSel.value, yearSel.value), 250);
    yearSel.addEventListener("change", refreshModels);
    makeSel.addEventListener("change", refreshModels);
  }

  async function doDecode() {
    const vin = (vinInput && vinInput.value || "").trim().toUpperCase();
    if (!validVin(vin)) {
      showToast("Enter a valid 17-character VIN.");
      if (vinInput) vinInput.focus();
      return;
    }

    const btnText = decodeBtn ? decodeBtn.textContent : "";
    if (decodeBtn) { decodeBtn.disabled = true; decodeBtn.textContent = "Decoding…"; }
    showToast("");

    try {
      const { year, make, model, trim } = await decodeVin(vin);

      if (year) setSelectValue("#year", year);
      if (make) setSelectValue("#make", make);

      if (make && year) {
        await loadModelsFor(make, year);
      }
      if (model) setSelectValue("#model", model);
      if (trim && trimInput) trimInput.value = trim || "";

      if (!year && !make && !model && !trim) {
        showToast("VIN decoded, but details are limited. Please fill fields manually.");
      } else {
        showToast("");
      }
    } catch (e) {
      console.error("VIN decode failed:", e);
      showToast("Could not decode VIN. Please fill fields manually.");
    } finally {
      if (decodeBtn) { decodeBtn.disabled = false; decodeBtn.textContent = btnText; }
    }
  }

  // Button click
  if (decodeBtn) decodeBtn.addEventListener("click", doDecode);

  // Auto-decode when VIN becomes valid (17 chars)
  if (vinInput) {
    vinInput.addEventListener("input", debounce(() => {
      const v = (vinInput.value || "").toUpperCase().replace(/\s+/g, "");
      if (v !== window.__lastVin) {
        window.__lastVin = v;
        if (validVin(v)) doDecode();
      }
    }, 300));
  }
});

/* -------------------- Logo injection & recolor -------------------- */
(async function injectAndRecolorQuirkLogo() {
  const slot = document.getElementById("quirkBrand");
  if (!slot) return;

  const BRAND_GREEN = "#0b7d2e";
  try {
    const res = await fetch("assets/quirk-logo.svg", { cache: "no-store" });
    if (!res.ok) throw new Error(`Logo HTTP ${res.status}`);
    const svgText = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgText, "image/svg+xml");
    const svg = doc.documentElement;
    svg.querySelectorAll("[fill]").forEach((node) => node.setAttribute("fill", BRAND_GREEN));
    if (!svg.getAttribute("viewBox")) {
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      if (!svg.getAttribute("width"))  svg.setAttribute("width", 260);
      if (!svg.getAttribute("height")) svg.setAttribute("height", 64);
    }
    slot.innerHTML = "";
    slot.appendChild(svg);
  } catch (err) {
    console.error("Logo load/recolor failed:", err);
    const img = document.createElement("img");
    img.src = "assets/quirk-logo.svg";
    img.alt = "Quirk Auto";
    img.style.height = "64px";
    img.style.width  = "auto";
    slot.innerHTML = "";
    slot.appendChild(img);
  }
})();

/* -------------------- Full i18n: English <-> Spanish -------------------- */
(function i18nFull(){
  const LANG_KEY = "quirk_lang";
  const STORAGE = window.sessionStorage; // per tab

  const MAP_EN_ES = new Map([
    ["title", "Tasación de intercambio sin inspección"],
    ["welcome", "Bienvenido al programa de tasación sin inspección de Quirk Auto Dealers"],
    ["aboutYou", "Cuéntenos sobre usted"],
    ["instructions", "Complete este formulario con información precisa y completa sobre su vehículo. El valor de intercambio que le proporcionemos será válido siempre que la condición del vehículo coincida con sus respuestas."],
    ["decodeVinBtn", "Decodificar VIN y autocompletar"],
    ["clearBtn", "Borrar formulario"],
    ["nameLabel", "Nombre completo"],
    ["phoneLabel", "Número de teléfono"],
    ["phoneHint", "Formato: (###) ###-####"],
    ["emailLabel", "Correo electrónico"],
    ["vinLabel", "VIN (obligatorio)"],
    ["vinHint", "El VIN se escribe en mayúsculas automáticamente; las letras I, O, Q no son válidas."],
    ["mileageLabel", "Kilometraje actual"],
    ["yearLabel", "Año"],
    ["makeLabel", "Marca"],
    ["modelLabel", "Modelo"],
    ["trimLabel", "Nivel de equipamiento (si se conoce)"],
    ["extColorLabel", "Color exterior"],
    ["intColorLabel", "Color interior"],
    ["keysLabel", "Número de llaves incluidas"],
    ["titleStatus", "Estado del título"],
    ["ownersLabel", "Número de propietarios (estimado OK)"],
    ["accidentLabel", "¿Ha estado el vehículo involucrado en un accidente?"],
    ["accidentRepair", "Si es así, ¿fue reparado profesionalmente?"],
    ["vehDetails", "Detalles del vehículo"],
    ["vehCondition", "Condición del vehículo"],
    ["warnings", "¿Alguna luz de advertencia en el tablero?"],
    ["mech", "Problemas mecánicos"],
    ["cosmetic", "Problemas cosméticos"],
    ["interior", "¿Interior limpio y sin daños?"],
    ["mods", "¿Piezas o modificaciones no originales?"],
    ["smells", "¿Olores inusuales?"],
    ["service", "¿Mantenimientos al día?"],
    ["tires", "Estado de los neumáticos"],
    ["brakes", "Estado de los frenos"],
    ["wearOther", "Otros elementos de desgaste (¿problemas?)"],
    ["photos", "Fotos (opcional)"],
    ["photosExterior", "Fotos del exterior"],
    ["photosInterior", "Fotos del interior"],
    ["photosDash", "Tablero / Odómetro"],
    ["photosDamage", "Daños / defectos"],
    ["photoHint", "Máx 10MB por archivo; 24 archivos en total."],
    ["finalDisclaimerTitle", "Aviso final"],
    ["finalDisclaimer", "Confirmo que la información proporcionada es correcta a mi leal saber y entender. Entiendo que el valor de tasación puede cambiar si la condición real del vehículo no coincide con los detalles anteriores."],
    ["agreeLabel", "Acepto y confirmo"],
    ["submit", "Obtener mi tasación"],
    ["submitAnother", "Enviar otro vehículo"],
    ["backToDealer", "Volver a Quirk Subaru Braintree"],
    ["successTitle", "¡Gracias! - Quirk Subaru Braintree"],
    ["successHeading", "¡Gracias!"],
    ["successMessage", "Hemos recibido los detalles de su intercambio. Un especialista de Quirk Subaru Braintree se pondrá en contacto con usted en breve."]
  ]);

  function translateDoc(lang) {
    if (lang !== "es") return;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (MAP_EN_ES.has(key)) {
        const val = MAP_EN_ES.get(key);
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
          el.placeholder = val;
        } else if (el.tagName === "TITLE") {
          document.title = val;
        } else {
          el.textContent = val;
        }
      }
    });
  }

  let lang = STORAGE.getItem(LANG_KEY);
  if (!lang) { lang = "en"; STORAGE.setItem(LANG_KEY, lang); }
  if (lang === "es") translateDoc("es");

  const btn = document.getElementById("langToggle");
  if (btn) {
    btn.addEventListener("click", () => {
      const next = STORAGE.getItem(LANG_KEY) === "es" ? "en" : "es";
      STORAGE.setItem(LANG_KEY, next);
      location.reload();
    });
  }
})();

/* -------------------- Clear Form wiring -------------------- */
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("tradeForm");
  const clearBtn = document.getElementById("clearBtn");
  if (clearBtn && form) {
    clearBtn.addEventListener("click", () => {
      form.reset();

      ["year","make","model","trim"].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.selectedIndex = 0;
          el.dispatchEvent(new Event("change"));
        }
      });

      ["photoExterior","photoInterior","photoDash","photoDamage"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = "";
      });
      ["prevExterior","prevInterior","prevDash","prevDamage"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = "";
      });

      ["toast","vinStatus","modelStatus","phoneHint"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = "";
      });

      ["referrer","landingPage","utmSource","utmMedium","utmCampaign","utmTerm","utmContent","phoneRaw"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = "";
      });

      // Reset VIN auto-decode sentinel so the same VIN re-triggers after clearing
      window.__lastVin = "";

      if (typeof applyI18n === "function") {
        const lang = sessionStorage.getItem("quirk_lang") || "en";
        applyI18n(lang);
      }

      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }
});
