"use strict";
/* MediMap Twin Cities: Overpass API (facilities) + Nominatim (place search). No API keys. */
const MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const AREAS = { both: [33.40, 72.80, 33.90, 73.35], isb: [33.45, 72.80, 33.90, 73.35], rwp: [33.45, 72.90, 33.75, 73.20] }; // S,W,N,E
const TYPES = {
  hospital: { l: "Hospital", p: "Hospitals", c: "#d62839", s: 34 },
  clinic: { l: "Clinic", p: "Clinics", c: "#0b8f8c", s: 28 },
  pharmacy: { l: "Pharmacy", p: "Pharmacies", c: "#2e9e5b", s: 28 },
  doctors: { l: "Doctor", p: "Doctors", c: "#7e57c2", s: 28 },
  dentist: { l: "Dentist", p: "Dentists", c: "#e08a00", s: 28 },
  laboratory: { l: "Laboratory", p: "Laboratories", c: "#2478c9", s: 28 }
};
/* White glyphs drawn on a 24x24 grid (no icon library needed) */
const GLYPH = {
  hospital: '<path d="M9.5 3.5h5v6h6v5h-6v6h-5v-6h-6v-5h6z"/>',
  clinic: '<path d="M12 20.5S3.5 15.4 3.5 9.6A4.6 4.6 0 0 1 12 7.2a4.6 4.6 0 0 1 8.5 2.4c0 5.8-8.5 10.9-8.5 10.9z"/>',
  pharmacy: '<g transform="rotate(-45 12 12)"><rect x="2.8" y="7.6" width="18.4" height="8.8" rx="4.4"/><path d="M12 7.6v8.8" stroke="currentColor" stroke-width="1.8"/></g>',
  doctors: '<circle cx="12" cy="7.4" r="3.9"/><path d="M4.2 21c0-4.6 3.4-7.2 7.8-7.2s7.8 2.6 7.8 7.2z"/>',
  dentist: '<path d="M12 5.2C10.3 3.6 5 3.3 4.3 8c-.5 3.2 1.4 4.9 1.8 8 .3 2.5.7 5 2.3 5 1.9 0 1.3-5.6 3.6-5.6s1.7 5.6 3.6 5.6c1.6 0 2-2.5 2.3-5 .4-3.1 2.3-4.8 1.8-8-.7-4.7-6-4.4-7.7-2.8z"/>',
  laboratory: '<path d="M9 3h6v2h-1v4.8l5.3 9.1A2 2 0 0 1 17.6 22H6.4a2 2 0 0 1-1.7-3.1L10 9.8V5H9z"/>'
};
const svg = (k, s) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="#fff" style="color:${TYPES[k].c}" aria-hidden="true">${GLYPH[k]}</svg>`;
const ico = (k, s) => `<span class="ico" style="background:${TYPES[k].c}">${svg(k, s || 13)}</span>`;
const ICONS = {};
for (const k in TYPES) { const s = TYPES[k].s; ICONS[k] = L.divIcon({ className: "", html: `<div class="pin-in" style="background:${TYPES[k].c}">${svg(k, s * .55)}</div>`, iconSize: [s, s] }); }

const KEEP = ["name:en", "operator", "phone", "contact:phone", "website", "contact:website", "opening_hours", "healthcare:speciality", "emergency", "wheelchair", "addr:housenumber", "addr:street", "addr:suburb", "addr:city"];
const CACHE_MS = 12 * 3600e3, LIST_MAX = 150, CKEY = "mm3_";

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const active = new Set(Object.keys(TYPES));
let all = [], shown = [], ctrl = null, center = null, centerMarker = null, ring = null, timer;

/* ---------- Map ---------- */
const map = L.map("map").setView([33.65, 73.05], 11);
const base = {
  "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }),
  "Esri Streets": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Tiles © Esri" }),
  "Satellite": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Tiles © Esri" }),
  "Topographic": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { subdomains: "abc", maxZoom: 17, attribution: "© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)" })
};
base["OpenStreetMap"].addTo(map);
L.control.layers(base, null, { position: "topright" }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);
const cluster = L.markerClusterGroup({
  chunkedLoading: true, maxClusterRadius: 55, disableClusteringAtZoom: 17,
  iconCreateFunction: c => { const n = c.getChildCount(), s = n < 10 ? 36 : n < 100 ? 44 : 54; return L.divIcon({ className: "", html: `<div class="cl" style="width:${s}px;height:${s}px">${n}</div>`, iconSize: [s, s] }); }
}).addTo(map);

/* ---------- Legend ---------- */
const legend = L.control({ position: "bottomright" });
legend.onAdd = () => { const d = L.DomUtil.create("details", "legend"); d.open = innerWidth > 800; L.DomEvent.disableClickPropagation(d); return d; };
legend.addTo(map);
function updateLegend(n) {
  legend.getContainer().innerHTML = "<summary>Legend</summary>" + Object.entries(TYPES).map(([k, t]) => `<div>${ico(k, 12)}${t.p}<b>${n[k] || 0}</b></div>`).join("");
}

/* ---------- Sidebar open/close ---------- */
const mq = matchMedia("(max-width:800px)");
function side(open) {
  document.body.classList.toggle("side-open", open);
  $("toggle").setAttribute("aria-expanded", open);
  setTimeout(() => map.invalidateSize(), 300);
}
$("toggle").addEventListener("click", () => side(!document.body.classList.contains("side-open")));
$("scrim").addEventListener("click", () => side(false));
mq.addEventListener("change", e => side(!e.matches));
side(!mq.matches);

/* ---------- UI helpers ---------- */
function busy(on) { $("bar").classList.toggle("on", on); }
function status(msg, err, retry) {
  const s = $("status");
  if (!msg) { s.style.display = "none"; return; }
  s.className = err ? "err" : ""; s.textContent = msg; s.style.display = "block";
  if (retry) { const b = document.createElement("button"); b.textContent = "Retry"; b.onclick = () => load(true); s.appendChild(b); }
}
function buildChips() {
  const n = {}; all.forEach(f => n[f.type] = (n[f.type] || 0) + 1);
  $("chips").innerHTML = Object.entries(TYPES).map(([k, t]) =>
    `<label class="chip"><input type="checkbox" value="${k}" ${active.has(k) ? "checked" : ""}>${ico(k)}${t.l} <b>${n[k] || 0}</b></label>`).join("");
  updateLegend(n);
}

/* ---------- Fetch (fastest mirror wins) ---------- */
function race(query, signal) {
  const cs = MIRRORS.map(() => new AbortController());
  signal.addEventListener("abort", () => cs.forEach(c => c.abort()));
  return Promise.any(MIRRORS.map((u, i) =>
    fetch(u, { method: "POST", body: "data=" + encodeURIComponent(query), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: cs[i].signal })
      .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(j => { cs.forEach((c, k) => k !== i && c.abort()); return j; })));
}
/* ---------- Parse ---------- */
const HC = { doctor: "doctors", centre: "clinic" };
const NAME_RULES = [["laboratory", /laborator|diagnostic|patholog|\blab\b/i], ["dentist", /dental|dentist|orthodon/i], ["pharmacy", /pharm|chemist|medicos|medical store/i],
  ["hospital", /hospital/i], ["clinic", /clinic|dispensary|surgery|maternity|medical|health|shifa/i]];
function classify(t) {
  if (t.amenity in TYPES) return t.amenity;
  if (t.healthcare) return HC[t.healthcare] || (t.healthcare in TYPES ? t.healthcare : "clinic");
  if (t.shop === "chemist") return "pharmacy";
  if (t.building === "hospital") return "hospital";
  // name-based fallback for places mapped without health tags (skip roads, stops, shops, etc.)
  if (!t.name || t.amenity || t.highway || t.railway || t.public_transport || t.leisure || t.tourism || t.place || t.landuse || t.boundary || (t.shop && t.shop !== "medical_supply")) return null;
  for (const [k, re] of NAME_RULES) if (re.test(t.name)) return k;
  return null;
}
function parse(json) {
  const out = [], seen = {};
  for (const el of json.elements || []) {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon, t = el.tags || {}, type = classify(t);
    if (lat == null || lon == null || !type) continue;
    if (t.name) { // drop duplicates (e.g. building outline + point for the same place)
      const k = type + "|" + t.name.toLowerCase(), a = seen[k] || (seen[k] = []);
      if (a.some(p => Math.abs(p[0] - lat) < .0007 && Math.abs(p[1] - lon) < .0007)) continue;
      a.push([lat, lon]);
    }
    const tags = {}; KEEP.forEach(k => t[k] && (tags[k] = t[k]));
    out.push({ id: el.type + "/" + el.id, lat, lon, type, name: t.name || t["name:en"] || "Unnamed " + TYPES[type].l.toLowerCase(), er: t.emergency === "yes", t: tags });
  }
  return out;
}
/* ---------- Cache ---------- */
const readCache = k => { try { const c = JSON.parse(localStorage.getItem(CKEY + k)); return c && c.d ? c : null; } catch { return null; } };
const writeCache = (k, d) => { try { localStorage.setItem(CKEY + k, JSON.stringify({ t: Date.now(), d })); } catch { } };
function setAge(t) {
  const m = Math.round((Date.now() - t) / 60000);
  $("age").textContent = m < 1 ? "Updated just now" : m < 90 ? `Updated ${m} min ago` : `Updated ${Math.round(m / 60)} h ago`;
}

async function load(force) {
  const key = $("area").value, cached = readCache(key);
  ctrl && ctrl.abort(); const my = ctrl = new AbortController();
  if (cached && !force && Date.now() - cached.t < CACHE_MS) { use(cached.d, cached.t, true); status(); return; }
  const [s, w, n, e] = AREAS[key], b = `(${s},${w},${n},${e})`;
  const nm = "hospital|clinic|pharm|medical|medicos|dispensary|diagnostic|laborator|dental|dentist|surgery|maternity|shifa|chemist|health";
  const q = `[out:json][timeout:60];(nwr["amenity"~"^(hospital|clinic|pharmacy|doctors|dentist)$"]${b};nwr["healthcare"]${b};nwr["building"="hospital"]${b};nwr["shop"="chemist"]${b};nwr["name"~"${nm}",i]${b};);out center tags;`;
  busy(true); status("Loading healthcare facilities…");
  try {
    const data = parse(await race(q, my.signal));
    if (my.signal.aborted) return;
    writeCache(key, data); use(data, Date.now(), true);
    data.length ? status() : status("No facilities found for this area.", true, true);
  } catch (err) {
    if (my.signal.aborted) return;
    if (cached) { use(cached.d, cached.t, true); status("Server busy. Showing saved data."); setTimeout(status, 4000); }
    else status("Could not load data. Check your connection, then retry.", true, true);
  } finally { if (!my.signal.aborted) busy(false); }
}
function use(data, t, fit) { all = data; setAge(t); buildChips(); render(fit); }

/* ---------- Filter & render ---------- */
function render(fit) {
  const q = $("q").value.trim().toLowerCase(), er = $("er").checked, r = +$("radius").value * 1000;
  shown = [];
  for (const f of all) {
    f.d = center ? map.distance(center, [f.lat, f.lon]) : null;
    if (active.has(f.type) && (!er || f.er) && (!q || f.name.toLowerCase().includes(q)) && (!center || !r || f.d <= r)) shown.push(f);
  }
  shown.sort(center ? (a, b) => a.d - b.d : (a, b) => a.name.localeCompare(b.name));
  cluster.clearLayers();
  cluster.addLayers(shown.map(f => f.m || (f.m = L.marker([f.lat, f.lon], { icon: ICONS[f.type], title: f.name, riseOnHover: true }).bindPopup(() => popup(f), { maxWidth: 280 }))));
  ring && ring.remove(); ring = null;
  if (center && r) ring = L.circle(center, { radius: r, color: "#d62839", weight: 1, fillOpacity: .05, interactive: false }).addTo(map);
  $("total").textContent = all.length;
  $("count").textContent = `Showing ${shown.length} of ${all.length}`;
  $("list").innerHTML = shown.slice(0, LIST_MAX).map((f, i) =>
    `<li tabindex="0" data-i="${i}">${ico(f.type, 13)}<div><b>${esc(f.name)}</b><span class="t">${TYPES[f.type].l}${f.er ? " · Emergency" : ""}${f.d != null ? " · " + (f.d / 1000).toFixed(1) + " km" : ""}</span></div></li>`).join("")
    + (shown.length > LIST_MAX ? `<li class="more">Showing first ${LIST_MAX}. Zoom the map or filter to see more.</li>` : "");
  if (fit === true && shown.length) map.fitBounds(L.latLngBounds(shown.map(f => [f.lat, f.lon])), { padding: [40, 40], maxZoom: 16 });
}

function popup(f) {
  const t = f.t, addr = [t["addr:housenumber"], t["addr:street"], t["addr:suburb"], t["addr:city"]].filter(Boolean).join(", ");
  const site = t.website || t["contact:website"], phone = t.phone || t["contact:phone"];
  const rows = [["Speciality", t["healthcare:speciality"]], ["Operator", t.operator], ["Emergency", f.er ? "Yes" : t.emergency], ["Address", addr], ["Phone", phone],
    ["Hours", t.opening_hours === "24/7" ? "Open 24 hours" : t.opening_hours], ["Wheelchair", t.wheelchair], ["Distance", f.d != null && (f.d / 1000).toFixed(1) + " km"]]
    .filter(r => r[1]).map(r => `<tr><td>${r[0]}</td><td>${esc(r[1])}</td></tr>`).join("");
  return `<div class="pop"><h3>${esc(f.name)}</h3><span class="badge" style="background:${TYPES[f.type].c}">${TYPES[f.type].l}</span>
    ${rows ? `<table>${rows}</table>` : "<small>No extra details are mapped for this facility.</small>"}
    <div class="acts"><a href="https://www.google.com/maps/dir/?api=1&destination=${f.lat},${f.lon}" target="_blank" rel="noopener">Directions</a>
    ${phone ? `<a class="alt" href="tel:${esc(phone.split(";")[0].replace(/\s/g, ""))}">Call</a>` : ""}
    ${/^https?:\/\//.test(site || "") ? `<a class="alt" href="${esc(site)}" target="_blank" rel="noopener">Website</a>` : ""}
    <a class="alt" href="https://www.openstreetmap.org/${f.id}" target="_blank" rel="noopener">OSM</a></div></div>`;
}

/* ---------- Interactions ---------- */
function setCenter(ll, label) {
  center = L.latLng(ll); centerMarker && centerMarker.remove();
  centerMarker = L.marker(center).addTo(map).bindTooltip(esc(label)).openTooltip();
  render(); if (mq.matches) side(false);
  const r = +$("radius").value * 1000;
  r ? map.fitBounds(center.toBounds(r * 2), { maxZoom: 17 }) : map.setView(center, 15);
}
$("chips").addEventListener("change", e => { e.target.checked ? active.add(e.target.value) : active.delete(e.target.value); render(); });
function searchZoom() {
  render(true);
  if (shown.length === 1) cluster.zoomToShowLayer(shown[0].m, () => shown[0].m.openPopup());
}
$("q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(searchZoom, 250); });
$("q").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); searchZoom(); if (mq.matches) side(false); } });
$("er").addEventListener("change", () => render());
$("radius").addEventListener("change", () => { render(); if (center) { const r = +$("radius").value * 1000; if (r) map.fitBounds(center.toBounds(r * 2), { maxZoom: 17 }); } });
$("area").addEventListener("change", () => { center = null; centerMarker && centerMarker.remove(); load(); });
$("refresh").addEventListener("click", () => load(true));
$("list").addEventListener("click", e => {
  const li = e.target.closest("li[data-i]"); if (!li) return;
  const f = shown[li.dataset.i]; if (mq.matches) side(false);
  setTimeout(() => cluster.zoomToShowLayer(f.m, () => f.m.openPopup()), mq.matches ? 300 : 0);
});
$("list").addEventListener("keydown", e => e.key === "Enter" && e.target.click());
$("place").addEventListener("submit", async e => {
  e.preventDefault(); const v = $("placeq").value.trim(); if (!v) return;
  status("Finding place…"); busy(true);
  try {
    const r = await (await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=pk&viewbox=72.8,33.9,73.35,33.4&q=" + encodeURIComponent(v + ", Islamabad Rawalpindi"))).json();
    if (!r.length) return status("Place not found. Try a sector or area name.", true);
    status(); setCenter([+r[0].lat, +r[0].lon], r[0].display_name.split(",")[0]);
  } catch { status("Place search failed. Try again.", true); } finally { busy(false); }
});
$("locate").addEventListener("click", () => {
  if (!navigator.geolocation) return status("Location is not supported in this browser.", true);
  status("Getting your location…");
  navigator.geolocation.getCurrentPosition(p => { status(); setCenter([p.coords.latitude, p.coords.longitude], "You are here"); },
    () => status("Location blocked. Allow access or use the place search.", true), { timeout: 10000 });
});

load();
