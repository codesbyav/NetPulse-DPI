const apps = [];
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
const escapeHtml = (value) => String(value).replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
const palette = ["#51e6d5", "#48a9ff", "#8f7dff", "#ffbf69", "#ff6b8a", "#79d36f", "#b98cff", "#6fd8ff"];

function setActiveNav() {
  const hash = location.hash || "#overview";
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.classList.toggle("active", link.getAttribute("href") === hash);
  });
}

function setEngineState(state, detail, status = "idle") {
  const card = document.querySelector(".scan-state");
  card.classList.toggle("running", status === "running");
  card.classList.toggle("failed", status === "failed");
  $("scan-label").textContent = state;
  $("scan-detail").textContent = detail;
}

function renderChart(points = [], label = "Average throughput") {
  const svg = $("traffic-chart");
  if (!points.length) {
    svg.innerHTML = "<text x='360' y='108' text-anchor='middle' fill='#71899f' font-size='13'>Throughput data appears after an inspection</text>";
    return;
  }
  const width = 720, height = 220, pad = 8, max = Math.max(...points, 0.01) * 1.12;
  const coords = points.map((value, index) => [(index / Math.max(points.length - 1, 1) * width).toFixed(1), (height - pad - value / max * (height - pad * 2)).toFixed(1)]);
  const line = coords.map((point) => point.join(",")).join(" ");
  const area = `M ${coords[0].join(" ")} L ${coords.map((point) => point.join(" ")).join(" L ")} L ${width} ${height} L 0 ${height} Z`;
  const last = coords.at(-1);
  svg.innerHTML = `<defs><linearGradient id="chart-gradient" x1="0" x2="0" y1="0" y2="1"><stop stop-color="#51e6d5" stop-opacity=".30"/><stop offset="1" stop-color="#51e6d5" stop-opacity="0"/></linearGradient></defs><path class="chart-fill" d="${area}"/><polyline class="chart-line" points="${line}"/><circle class="chart-dot" cx="${last[0]}" cy="${last[1]}" r="5"/><text x="12" y="20" fill="#71899f" font-size="11">${escapeHtml(label)}</text>`;
}

function renderApps() {
  const total = apps.reduce((sum, app) => sum + app.count, 0);
  const normalized = total ? apps : [{ name: "No data", count: 0, percent: 100, color: "#2b4056" }];
  $("app-legend").innerHTML = normalized.slice(0, 8).map((app, index) => `<li><i style="background:${app.color || palette[index % palette.length]}"></i><span>${escapeHtml(app.name.replace(/^\|+\s*/, ""))}</span><b>${app.percent.toFixed(1)}%</b></li>`).join("");
  const classified = apps.filter((app) => app.name.replace(/^\|+\s*/, "").toLowerCase() !== "unknown").reduce((sum, app) => sum + app.count, 0);
  $("classified-percent").textContent = `${total ? Math.round(classified / total * 100) : 0}%`;
  let position = 0;
  const segments = normalized.map((app, index) => { const start = position; position += app.percent; return `${app.color || palette[index % palette.length]} ${start}% ${position}%`; });
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
  $("event-list").innerHTML = events.slice().reverse().map((event) => {
    const raw = String(event.message || "");
    const message = raw.startsWith("Output written to:") ? "Filtered capture generated successfully" : raw;
    return `<li class="${event.level === "error" ? "blocked" : ""}"><time>${escapeHtml(event.at)}</time>${escapeHtml(message)}</li>`;
  }).join("") || "<li><time>Waiting</time>No engine events yet.</li>";
}

function renderStats(stats, status, job = null) {
  const clientElapsed = Math.max((Date.now() - startedAt) / 1000, 0.001);
  const jobElapsed = job?.finished_at && job?.started_at ? Math.max(job.finished_at - job.started_at, 0.001) : clientElapsed;
  const total = stats.total_packets || 0;
  const mbps = stats.total_bytes ? (stats.total_bytes * 8 / (status === "completed" ? jobElapsed : clientElapsed) / 1_000_000) : 0;
  $("packet-count").textContent = formatNumber(total);
  $("throughput").innerHTML = `${mbps.toFixed(2)} <small>Mb/s</small>`;
  $("flow-count").textContent = formatNumber(stats.forwarded || 0);
  $("blocked-count").textContent = formatNumber(stats.dropped || 0);
  $("packet-change").textContent = status === "completed" ? `${formatNumber(stats.tcp_packets)} TCP · ${formatNumber(stats.udp_packets)} UDP` : status === "running" ? "Engine processing capture" : "Ready to analyze";
  $("throughput-change").textContent = stats.total_bytes ? `${formatNumber(stats.total_bytes)} bytes processed` : "Available during inspection";
  $("flow-change").textContent = "Forwarded packets";
  $("blocked-change").textContent = "Engine rule matches";
  if (status === "completed" && mbps > 0) renderChart(Array(6).fill(mbps), "Average throughput · Mbps");
}

function renderReport(job) {
  if (!job || job.status !== "completed") return;
  const stats = job.stats || {};
  const appsReport = (stats.applications || []).slice().sort((a, b) => b.count - a.count);
  const domains = stats.domains || [];
  const threads = stats.threads || [];
  const totalBytes = stats.total_bytes || 0;
  const elapsed = Math.max(((job.finished_at || Date.now()) - (job.started_at || Date.now())), 0.001);
  const mbps = totalBytes * 8 / elapsed / 1_000_000;
  const captureName = $("pcap-file").files[0]?.name || "Uploaded capture";
  const ruleCount = rules.length;
  $("report-status").textContent = `${formatNumber(stats.total_packets)} packets analyzed · report generated successfully`;
  $("report-download").href = job.output_url || "#";
  $("report-download").hidden = !job.output_url;
  $("report-content").innerHTML = `
    <div class="report-summary-grid">
      <div><span>Total packets</span><strong>${formatNumber(stats.total_packets)}</strong></div>
      <div><span>Total bytes</span><strong>${formatNumber(totalBytes)}</strong></div>
      <div><span>TCP / UDP</span><strong>${formatNumber(stats.tcp_packets)} / ${formatNumber(stats.udp_packets)}</strong></div>
      <div><span>Forwarded</span><strong>${formatNumber(stats.forwarded)}</strong></div>
      <div><span>Blocked</span><strong>${formatNumber(stats.dropped)}</strong></div>
      <div><span>Avg. throughput</span><strong>${mbps.toFixed(2)} <small>Mb/s</small></strong></div>
    </div>
    <div class="report-details">
      <div><span>Capture</span><b>${escapeHtml(captureName)}</b></div>
      <div><span>Status</span><b class="report-ok">Completed</b></div>
      <div><span>Load balancers</span><b>${escapeHtml($("lb-count").value)}</b></div>
      <div><span>Fast paths / LB</span><b>${escapeHtml($("fp-count").value)}</b></div>
      <div><span>Rules applied</span><b>${formatNumber(ruleCount)}</b></div>
    </div>
    <div class="report-columns">
      <div class="report-block"><h3>Application breakdown</h3>${appsReport.length ? `<div class="report-table">${appsReport.map((app) => `<div><span>${escapeHtml(app.name.replace(/^\|+\s*/, ""))}</span><b>${formatNumber(app.count)}</b><em>${app.percent.toFixed(1)}%</em></div>`).join("")}</div>` : `<p class="report-muted">No application classifications reported.</p>`}</div>
      <div class="report-block"><h3>Detected domains / SNI</h3>${domains.length ? `<div class="report-table">${domains.map((item) => `<div><span>${escapeHtml(item.domain)}</span><b>${escapeHtml(item.application)}</b></div>`).join("")}</div>` : `<p class="report-muted">No domains or SNI entries reported.</p>`}</div>
    </div>
    <div class="report-block"><h3>Thread statistics</h3>${threads.length ? `<div class="report-table">${threads.map((thread) => `<div><span>${escapeHtml(thread.name)}</span><b>${escapeHtml(thread.metric)}</b><em>${formatNumber(thread.value)}</em></div>`).join("")}</div>` : `<p class="report-muted">No thread-level statistics reported by this engine build.</p>`}</div>`;
}

function updateAnalytics(stats) {
  apps.length = 0;
  (stats.applications || []).forEach((app, index) => apps.push({ ...app, color: palette[index % palette.length], name: app.name.replace(/^\|+\s*/, "") }));
  renderApps();
  const domainEvents = (stats.domains || []).slice(0, 12).map((item) => ({ at: "SNI", message: `${item.domain} → ${item.application}`, level: "info" }));
  if (domainEvents.length && (!$("event-list").textContent || $("event-list").textContent.includes("No engine events"))) renderEvents(domainEvents);
}

async function pollJob() {
  try {
    const response = await fetch(`/api/inspections/${jobId}`);
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || "Could not read inspection status.");
    renderEvents(job.events || []);
    renderStats(job.stats || {}, job.status, job);
    updateAnalytics(job.stats || {});
    if (job.status === "completed") {
      clearInterval(pollTimer); pollTimer = null;
      setEngineState("Inspection complete", `${formatNumber(job.stats?.total_packets)} packets analyzed`);
      $("engine-state").textContent = "Ready";
      $("run-button").disabled = false;
      $("run-button").innerHTML = "<span>▶</span> Start inspection";
      $("output-link").href = job.output_url; $("output-link").hidden = false;
      renderReport(job);
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
    $("report-status").textContent = "Inspection running… report will appear when complete.";
    $("report-content").innerHTML = "<div class='report-empty'>Analyzing the capture and collecting engine results…</div>";
    $("report-download").hidden = true;
    setEngineState("Inspection in progress", `${$("lb-count").value} load balancers · ${$("fp-count").value} fast paths each`, "running");
    $("engine-state").textContent = "Processing";
    $("run-button").innerHTML = "<span>◌</span> Inspection running";
    renderChart();
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
$("refresh-traffic").addEventListener("click", renderApps);
window.addEventListener("hashchange", setActiveNav);
setActiveNav();
setInterval(() => { $("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }, 1000);
renderChart(); renderApps(); renderRules(); renderEvents([]); renderStats({}, "idle");