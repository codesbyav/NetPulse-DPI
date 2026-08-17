const apps = [
  { name: "HTTPS", value: 0, color: "#51e6d5" },
  { name: "YouTube", value: 0, color: "#48a9ff" },
  { name: "DNS", value: 0, color: "#8f7dff" },
  { name: "Facebook", value: 0, color: "#ffbf69" },
  { name: "Other", value: 100, color: "#2b4056" },
];
const rules = [
  { type: "domain", value: "youtube.com" },
  { type: "app", value: "BitTorrent" },
  { type: "ip", value: "192.168.1.50" },
];
let jobId = null;
let pollTimer = null;
let startedAt = 0;

const $ = (id) => document.getElementById(id);
const formatNumber = (value) => new Intl.NumberFormat().format(Math.round(value || 0));
const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);

function setEngineState(state, detail, status = "idle") {
  const card = document.querySelector(".scan-state");
  card.classList.toggle("running", status === "running");
  card.classList.toggle("failed", status === "failed");
  $("scan-label").textContent = state;
  $("scan-detail").textContent = detail;
}

function renderChart(points = []) {
  const svg = $("traffic-chart");
  if (!points.length) {
    svg.innerHTML = "<text x='360' y='108' text-anchor='middle' fill='#71899f' font-size='13'>Throughput is available while an inspection runs</text>";
    return;
  }
  const width = 720, height = 220, pad = 8, max = Math.max(...points, 1) * 1.12;
  const coords = points.map((value, index) => [(index / Math.max(points.length - 1, 1) * width).toFixed(1), (height - pad - value / max * (height - pad * 2)).toFixed(1)]);
  const line = coords.map((point) => point.join(",")).join(" ");
  const area = `M ${coords[0].join(" ")} L ${coords.map((point) => point.join(" ")).join(" L ")} L ${width} ${height} L 0 ${height} Z`;
  const last = coords.at(-1);
  svg.innerHTML = `<defs><linearGradient id="chart-gradient" x1="0" x2="0" y1="0" y2="1"><stop stop-color="#51e6d5" stop-opacity=".30"/><stop offset="1" stop-color="#51e6d5" stop-opacity="0"/></linearGradient></defs><path class="chart-fill" d="${area}"/><polyline class="chart-line" points="${line}"/><circle class="chart-dot" cx="${last[0]}" cy="${last[1]}" r="5"/>`;
}

function renderApps() {
  $("app-legend").innerHTML = apps.map((app) => `<li><i style="background:${app.color}"></i><span>${app.name}</span><b>${app.value}%</b></li>`).join("");
  const classified = 100 - apps.find((app) => app.name === "Other").value;
  $("classified-percent").textContent = `${classified}%`;
  let position = 0;
  const segments = apps.map((app) => { const start = position; position += app.value; return `${app.color} ${start}% ${position}%`; });
  $("donut").style.background = `conic-gradient(${segments.join(",")})`;
}

function renderRules() {
  $("rule-list").replaceChildren();
  rules.forEach((rule, index) => {
    const element = $("rule-template").content.firstElementChild.cloneNode(true);
    element.querySelector(".rule-kind").textContent = rule.type;
    element.querySelector(".rule-value").textContent = rule.value;
    element.querySelector("button").addEventListener("click", () => { rules.splice(index, 1); renderRules(); });
    $("rule-list").append(element);
  });
  $("rule-total").textContent = `${rules.length} active`;
}

function renderEvents(events) {
  $("event-list").innerHTML = events.slice().reverse().map((event) => `<li class="${event.level === "error" ? "blocked" : ""}"><time>${escapeHtml(event.at)}</time>${escapeHtml(event.message)}</li>`).join("") || "<li><time>Waiting</time>No engine events yet.</li>";
}

function renderStats(stats, status) {
  const elapsed = Math.max((Date.now() - startedAt) / 1000, 1);
  const total = stats.total_packets || 0;
  const throughput = status === "running" ? ((stats.total_bytes || 0) * 8 / elapsed / 1_000_000).toFixed(2) : "—";
  $("packet-count").textContent = formatNumber(total);
  $("throughput").innerHTML = `${throughput} <small>Mb/s</small>`;
  $("flow-count").textContent = formatNumber(stats.forwarded || 0);
  $("blocked-count").textContent = formatNumber(stats.dropped || 0);
  $("packet-change").textContent = status === "completed" ? "Engine report complete" : status === "running" ? "Engine processing capture" : "Ready to analyze";
  $("throughput-change").textContent = status === "running" ? "Calculated from engine report" : "Available during inspection";
  $("flow-change").textContent = "Forwarded packets";
  $("blocked-change").textContent = "Engine rule matches";
}

async function pollJob() {
  try {
    const response = await fetch(`/api/inspections/${jobId}`);
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || "Could not read inspection status.");
    renderEvents(job.events || []);
    renderStats(job.stats || {}, job.status);
    if (job.status === "completed") {
      clearInterval(pollTimer); pollTimer = null;
      setEngineState("Inspection complete", "Filtered capture is ready");
      $("engine-state").textContent = "Ready";
      $("run-button").disabled = false;
      $("run-button").innerHTML = "<span>▶</span> Start inspection";
      $("output-link").href = job.output_url; $("output-link").hidden = false;
    } else if (job.status === "failed") {
      clearInterval(pollTimer); pollTimer = null;
      setEngineState("Inspection failed", job.error || "Check the engine log", "failed");
      $("engine-state").textContent = "Error";
      $("run-button").disabled = false;
      $("run-button").innerHTML = "<span>▶</span> Start inspection";
    }
  } catch (error) {
    clearInterval(pollTimer); pollTimer = null;
    setEngineState("Connection error", error.message, "failed");
    $("run-button").disabled = false;
    $("run-button").innerHTML = "<span>▶</span> Start inspection";
  }
}

async function runInspection() {
  const capture = $("pcap-file").files[0];
  if (!capture) { setEngineState("Choose a capture", "Select a .pcap file before starting", "failed"); return; }
  if (location.protocol === "file:") { setEngineState("Start the local server", "Run python server.py, then open http://127.0.0.1:8765", "failed"); return; }
  $("run-button").disabled = true;
  $("run-button").innerHTML = "<span>◌</span> Starting engine";
  $("output-link").hidden = true;
  try {
    const form = new FormData();
    form.append("capture", capture);
    form.append("output_name", $("output-file").value);
    form.append("lbs", $("lb-count").value);
    form.append("fps", $("fp-count").value);
    form.append("rules", JSON.stringify(rules));
    const response = await fetch("/api/inspections", { method: "POST", body: form });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not start inspection.");
    jobId = payload.id; startedAt = Date.now();
    setEngineState("Inspection in progress", `${$("lb-count").value} load balancers · ${$("fp-count").value} fast paths each`, "running");
    $("engine-state").textContent = "Processing";
    $("run-button").innerHTML = "<span>◌</span> Inspection running";
    renderChart([2, 5, 4, 7, 6, 9]);
    await pollJob();
    pollTimer = setInterval(pollJob, 800);
  } catch (error) {
    setEngineState("Could not start engine", error.message, "failed");
    $("run-button").disabled = false;
    $("run-button").innerHTML = "<span>▶</span> Start inspection";
  }
}

$("pcap-file").addEventListener("change", (event) => {
  const file = event.target.files[0]; if (!file) return;
  $("file-name").textContent = file.name;
  $("file-status").textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB capture selected`;
  setEngineState("Capture ready", "Ready for engine inspection");
});
$("rule-form").addEventListener("submit", (event) => {
  event.preventDefault(); const value = $("rule-value").value.trim(); if (!value) return;
  rules.unshift({ type: $("rule-type").value, value }); $("rule-value").value = ""; renderRules();
});
$("run-button").addEventListener("click", runInspection);
$("refresh-traffic").addEventListener("click", () => renderApps());
setInterval(() => { $("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }, 1000);
renderChart(); renderApps(); renderRules(); renderEvents([]); renderStats({}, "idle");
