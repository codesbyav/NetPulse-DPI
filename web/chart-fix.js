(() => {
  const originalRenderChart = window.renderChart;
  let capturePoints = null;

  function readU32(view, offset, little) {
    return view.getUint32(offset, little);
  }

  function parseClassicPcap(buffer) {
    if (buffer.byteLength < 24) return null;
    const view = new DataView(buffer);
    const magic = view.getUint32(0, false);
    const little = magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1;
    const nano = magic === 0xa1b23c4d || magic === 0x4d3cb2a1;
    const valid = magic === 0xa1b2c3d4 || magic === 0xd4c3b2a1 || magic === 0xa1b23c4d || magic === 0x4d3cb2a1;
    if (!valid) return null;

    const packets = [];
    let offset = 24;
    const fractionScale = nano ? 1e9 : 1e6;
    while (offset + 16 <= view.byteLength && packets.length < 200000) {
      const sec = readU32(view, offset, little);
      const frac = readU32(view, offset + 4, little);
      const incl = readU32(view, offset + 8, little);
      if (!Number.isFinite(incl) || incl > view.byteLength - offset - 16) break;
      packets.push({ time: sec + frac / fractionScale, bytes: incl });
      offset += 16 + incl;
    }
    return packets;
  }

  function parsePcapNg(buffer) {
    if (buffer.byteLength < 12) return null;
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x0a0d0d0a) return null;
    const interfaces = [];
    const packets = [];
    let offset = 0;

    while (offset + 12 <= view.byteLength && packets.length < 200000) {
      const type = view.getUint32(offset, true);
      const blockLength = view.getUint32(offset + 4, true);
      if (blockLength < 12 || offset + blockLength > view.byteLength) break;

      if (type === 0x00000001 && blockLength >= 20) {
        let tsResolution = 1e-6;
        let opt = offset + 16;
        const end = offset + blockLength - 4;
        while (opt + 4 <= end) {
          const code = view.getUint16(opt, true);
          const len = view.getUint16(opt + 2, true);
          opt += 4;
          if (code === 0) break;
          if (opt + len > end) break;
          if (code === 9 && len >= 1) {
            const value = view.getUint8(opt);
            tsResolution = (value & 0x80) ? Math.pow(2, -(value & 0x7f)) : Math.pow(10, -(value & 0x7f));
          }
          opt += Math.ceil(len / 4) * 4;
        }
        interfaces.push(tsResolution);
      } else if (type === 0x00000006 && blockLength >= 32) {
        const interfaceId = view.getUint32(offset + 8, true);
        const tsHigh = view.getUint32(offset + 12, true);
        const tsLow = view.getUint32(offset + 16, true);
        const capLen = view.getUint32(offset + 20, true);
        const resolution = interfaces[interfaceId] || 1e-6;
        const timestamp = tsHigh * 4294967296 + tsLow;
        packets.push({ time: timestamp * resolution, bytes: capLen });
      }
      offset += blockLength;
    }
    return packets;
  }

  function buildSeries(packets) {
    if (!packets || packets.length < 2) return null;
    packets.sort((a, b) => a.time - b.time);
    const start = packets[0].time;
    const end = packets[packets.length - 1].time;
    const duration = end - start;
    if (!(duration > 0)) return null;

    const bucketCount = Math.min(12, Math.max(4, Math.ceil(duration)));
    const bucketDuration = duration / bucketCount;
    const buckets = Array(bucketCount).fill(0);
    for (const packet of packets) {
      const index = Math.min(bucketCount - 1, Math.floor((packet.time - start) / bucketDuration));
      buckets[index] += packet.bytes * 8;
    }
    return buckets.map((bits) => bits / bucketDuration / 1e6);
  }

  function renderMeasuredChart(points) {
    const svg = document.getElementById("traffic-chart");
    if (!svg || !points?.length) return;
    const width = 720, height = 220, pad = 8;
    const max = Math.max(...points, 0.01) * 1.12;
    const coords = points.map((value, index) => [
      (index / Math.max(points.length - 1, 1) * width).toFixed(1),
      (height - pad - value / max * (height - pad * 2)).toFixed(1),
    ]);
    const line = coords.map((point) => point.join(",")).join(" ");
    const area = `M ${coords[0].join(" ")} L ${coords.map((point) => point.join(" ")).join(" L ")} L ${width} ${height} L 0 ${height} Z`;
    const last = coords.at(-1);
    svg.innerHTML = `<defs><linearGradient id="chart-gradient" x1="0" x2="0" y1="0" y2="1"><stop stop-color="#51e6d5" stop-opacity=".30"/><stop offset="1" stop-color="#51e6d5" stop-opacity="0"/></linearGradient></defs><path class="chart-fill" d="${area}"/><polyline class="chart-line" points="${line}"/><circle class="chart-dot" cx="${last[0]}" cy="${last[1]}" r="5"/><text x="12" y="20" fill="#71899f" font-size="11">Capture throughput · Mbps</text>`;
  }

  window.renderChart = function(points = [], label = "Average throughput") {
    if (capturePoints?.length) {
      renderMeasuredChart(capturePoints);
      return;
    }
    originalRenderChart(points, label);
  };

  const input = document.getElementById("pcap-file");
  if (!input) return;
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    capturePoints = null;
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const packets = parseClassicPcap(buffer) || parsePcapNg(buffer);
      capturePoints = buildSeries(packets);
      if (capturePoints?.length) window.renderChart(capturePoints, "Capture throughput · Mbps");
    } catch (_) {
      capturePoints = null;
    }
  });
})();
