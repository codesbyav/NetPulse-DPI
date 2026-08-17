#!/usr/bin/env python3
"""Local HTTP bridge between the NetPulse web console and dpi_engine."""
from __future__ import annotations
import json, mimetypes, os, re, shutil, subprocess, threading, time, uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
RUNS_ROOT = ROOT / ".netpulse-runs"
MAX_UPLOAD_BYTES = 512 * 1024 * 1024
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.RLock()


def engine_path() -> Path | None:
    configured = os.environ.get("NETPULSE_ENGINE")
    candidates = [Path(configured)] if configured else []
    if os.name == "nt":
        candidates += [ROOT / "build" / "Release" / "dpi_engine.exe", ROOT / "build" / "dpi_engine.exe", ROOT / "dpi_engine.exe"]
    else:
        candidates += [ROOT / "build" / "dpi_engine", ROOT / "dpi_engine"]
    return next((p.resolve() for p in candidates if p and p.is_file()), None)


def safe_file_name(value: str, fallback: str) -> str:
    name = Path(value or fallback).name
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    return name or fallback


def parse_multipart(content_type: str, body: bytes) -> dict[str, tuple[str | None, bytes]]:
    match = re.search(r'boundary=(?:"([^"]+)"|([^;\s]+))', content_type)
    if not match:
        raise ValueError("Expected multipart/form-data")
    boundary = (match.group(1) or match.group(2)).encode()
    fields = {}
    for part in body.split(b"--" + boundary):
        if not part or part in (b"--\r\n", b"--"):
            continue
        if part.startswith(b"\r\n"): part = part[2:]
        if part.endswith(b"\r\n"): part = part[:-2]
        headers, separator, value = part.partition(b"\r\n\r\n")
        if not separator: continue
        text = headers.decode("utf-8", "replace")
        disposition = re.search(r'name="([^"]+)"', text)
        if not disposition: continue
        filename = re.search(r'filename="([^"]*)"', text)
        fields[disposition.group(1)] = (filename.group(1) if filename else None, value)
    return fields


def field_text(fields: dict, name: str, default: str = "") -> str:
    return fields.get(name, (None, default.encode()))[1].decode("utf-8", "replace")


def new_event(job_id: str, message: str, level: str = "info") -> None:
    with JOBS_LOCK:
        JOBS[job_id]["events"].append({"at": time.strftime("%H:%M:%S"), "message": message, "level": level})
        JOBS[job_id]["events"] = JOBS[job_id]["events"][-30:]


def number_after(label: str, log: str) -> int:
    match = re.search(re.escape(label) + r"\s*:?\s*(\d+)", log, re.I)
    return int(match.group(1)) if match else 0


def parse_report(log: str) -> dict:
    stats = {
        "total_packets": number_after("Total Packets", log),
        "total_bytes": number_after("Total Bytes", log),
        "tcp_packets": number_after("TCP Packets", log),
        "udp_packets": number_after("UDP Packets", log),
        "forwarded": number_after("Forwarded", log),
        "dropped": number_after("Dropped", log),
        "applications": [],
        "domains": [],
        "threads": [],
    }

    thread_section = re.search(r"THREAD STATISTICS(.*?)(?:APPLICATION BREAKDOWN|$)", log, re.S | re.I)
    if thread_section:
        for match in re.finditer(r"(?:LB|FP)\d+[^\n]*?:\s*([0-9]+)", thread_section.group(1), re.I):
            pass
        for line in thread_section.group(1).splitlines():
            m = re.search(r"\b(LB\d+|FP\d+)\s+(?:dispatched|processed):\s*(\d+)", line, re.I)
            if m:
                stats["threads"].append({"name": m.group(1), "metric": "dispatched" if "dispatched" in line.lower() else "processed", "value": int(m.group(2))})

    app_section = re.search(r"APPLICATION BREAKDOWN(.*?)(?:\[Detected Domains/SNIs\]|Detected Domains/SNIs|$)", log, re.S | re.I)
    if app_section:
        for line in app_section.group(1).splitlines():
            m = re.match(r"\s*([^\d\n][^\n]*?)\s+(\d+)\s+(\d+(?:\.\d+)?)%", line)
            if m:
                name = m.group(1).strip()
                if name and name.lower() not in {"application", "breakdown"}:
                    stats["applications"].append({"name": name, "count": int(m.group(2)), "percent": float(m.group(3))})

    domain_section = re.search(r"\[Detected Domains/SNIs\](.*?)(?:\n\s*Output written to:|$)", log, re.S | re.I)
    if domain_section:
        for line in domain_section.group(1).splitlines():
            m = re.match(r"\s*-\s*(.*?)\s*->\s*(.*)\s*$", line)
            if m:
                stats["domains"].append({"domain": m.group(1).strip(), "application": m.group(2).strip()})

    return stats


def run_engine(job_id: str, command: list[str], output_file: Path) -> None:
    new_event(job_id, "Starting dpi_engine")
    try:
        process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        output_lines = []
        assert process.stdout is not None
        for line in process.stdout:
            line = line.rstrip()
            if line:
                output_lines.append(line)
                new_event(job_id, line, "error" if "error" in line.lower() else "info")
        exit_code = process.wait()
        log = "\n".join(output_lines)
        stats = parse_report(log)
        with JOBS_LOCK:
            job = JOBS[job_id]
            job["log"] = log[-12000:]
            job["stats"] = stats
            job["exit_code"] = exit_code
            job["finished_at"] = time.time()
            if exit_code == 0 and output_file.is_file():
                job["status"] = "completed"
                job["output_url"] = f"/api/inspections/{job_id}/output"
                new_event(job_id, f"Inspection complete · {output_file.name}")
            else:
                job["status"] = "failed"
                job["error"] = "dpi_engine did not create an output capture."
                new_event(job_id, job["error"], "error")
    except Exception as error:
        with JOBS_LOCK:
            JOBS[job_id]["status"] = "failed"
            JOBS[job_id]["error"] = str(error)
            JOBS[job_id]["finished_at"] = time.time()
        new_event(job_id, str(error), "error")


class NetPulseHandler(BaseHTTPRequestHandler):
    server_version = "NetPulseDPI/1.0"
    def log_message(self, *_): return

    def send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            engine = engine_path()
            self.send_json({"engine_ready": bool(engine), "engine_path": str(engine) if engine else None}); return
        match = re.fullmatch(r"/api/inspections/([a-f0-9-]+)(/output)?", parsed.path)
        if match:
            with JOBS_LOCK: job = dict(JOBS.get(match.group(1), {})) if match.group(1) in JOBS else None
            if not job:
                self.send_json({"error": "Inspection not found"}, HTTPStatus.NOT_FOUND); return
            if match.group(2):
                output_file = Path(job["output_file"])
                if not output_file.is_file(): self.send_json({"error": "Output is not available"}, HTTPStatus.NOT_FOUND); return
                self.send_response(HTTPStatus.OK); self.send_header("Content-Type", "application/vnd.tcpdump.pcap"); self.send_header("Content-Length", str(output_file.stat().st_size)); self.send_header("Content-Disposition", f'attachment; filename="{output_file.name}"'); self.end_headers()
                with output_file.open("rb") as stream: shutil.copyfileobj(stream, self.wfile)
            else:
                job.pop("input_file", None); job.pop("output_file", None); self.send_json(job)
            return
        self.serve_static(parsed.path)

    def do_POST(self):
        if urlparse(self.path).path != "/api/inspections": self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND); return
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= MAX_UPLOAD_BYTES: self.send_json({"error": "Choose a PCAP file smaller than 512 MB."}, HTTPStatus.BAD_REQUEST); return
        engine = engine_path()
        if not engine: self.send_json({"error": "dpi_engine was not found. Build it first with CMake or set NETPULSE_ENGINE."}, HTTPStatus.SERVICE_UNAVAILABLE); return
        try:
            fields = parse_multipart(self.headers.get("Content-Type", ""), self.rfile.read(length))
            uploaded_name, capture = fields.get("capture", (None, b""))
            if not uploaded_name or not capture: raise ValueError("A capture file is required.")
            if not uploaded_name.lower().endswith((".pcap", ".pcapng")): raise ValueError("Capture must have a .pcap or .pcapng extension.")
            rules = json.loads(field_text(fields, "rules", "[]"))
            if not isinstance(rules, list): raise ValueError("Rules must be a list.")
            lbs = max(1, min(32, int(field_text(fields, "lbs", "2"))))
            fps = max(1, min(32, int(field_text(fields, "fps", "2"))))
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST); return
        job_id = str(uuid.uuid4()); run_dir = RUNS_ROOT / job_id; run_dir.mkdir(parents=True, exist_ok=True)
        input_file = run_dir / safe_file_name(uploaded_name, "capture.pcap")
        output_file = run_dir / safe_file_name(field_text(fields, "output_name", "filtered-output.pcap"), "filtered-output.pcap")
        if output_file.suffix.lower() != ".pcap": output_file = output_file.with_suffix(".pcap")
        input_file.write_bytes(capture)
        command = [str(engine), str(input_file), str(output_file), "--lbs", str(lbs), "--fps", str(fps)]
        for rule in rules:
            if not isinstance(rule, dict): continue
            value = str(rule.get("value", "")).strip(); flag = {"domain": "--block-domain", "ip": "--block-ip", "app": "--block-app"}.get(rule.get("type"))
            if flag and value: command.extend((flag, value))
        with JOBS_LOCK:
            JOBS[job_id] = {"id": job_id, "status": "queued", "started_at": time.time(), "finished_at": None, "events": [], "stats": {}, "error": None, "log": "", "output_file": str(output_file), "command": command}
        threading.Thread(target=run_engine, args=(job_id, command, output_file), daemon=True).start()
        self.send_json({"id": job_id, "status": "queued"}, HTTPStatus.ACCEPTED)

    def serve_static(self, request_path):
        relative = unquote(request_path.lstrip("/")) or "index.html"; target = (WEB_ROOT / relative).resolve()
        if WEB_ROOT not in target.parents and target != WEB_ROOT: self.send_error(HTTPStatus.FORBIDDEN); return
        if target.is_dir(): target /= "index.html"
        if not target.is_file(): self.send_error(HTTPStatus.NOT_FOUND); return
        data = target.read_bytes(); self.send_response(HTTPStatus.OK); self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

if __name__ == "__main__":
    RUNS_ROOT.mkdir(exist_ok=True); address = ("127.0.0.1", int(os.environ.get("NETPULSE_PORT", "8765")))
    print(f"NetPulse UI: http://{address[0]}:{address[1]}"); print("Engine:", engine_path() or "not built (run CMake first)"); ThreadingHTTPServer(address, NetPulseHandler).serve_forever()
