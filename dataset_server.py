#!/usr/bin/env python3
"""
Reverse-proxy + Dataset Import server for Label Studio.

Sits in front of Label Studio on port 8080 so that:
  - http://localhost:8080/             → Label Studio (proxied from backend)
  - http://localhost:8080/projects/…   → Label Studio (proxied from backend)
  - http://localhost:8080/?dataset_dir=NAME  → import dataset, redirect to project
  - http://localhost:8080/import       → Web UI for importing datasets
  - http://localhost:8080/api/import?dataset_dir=NAME → JSON import API

No API key or S3 credentials needed from the user — everything is embedded.

Usage:
    python dataset_server.py                                    # proxy on 8080, LS at 8081
    python dataset_server.py --port 8080 --backend 8081

Architecture:
    Browser  →  :8080 (this proxy)  →  :8081 (Label Studio Docker)
"""

import argparse
import http.client
import json
import os
import re
import sys
import threading
import time
import traceback
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs, urlencode

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from create_tasks import (
    Config,
    create_label_config,
    derive_project_name,
    import_lerobot_tasks,
    ensure_export_storage,
)
from label_studio_sdk import LabelStudio as LabelStudioClient

# =============================================================================
# Embedded Configuration (users don't need to provide these)
# =============================================================================

S3_CREDENTIALS = {
    "AWS_ACCESS_KEY_ID": "jiashenggu:AUTH_team-gear",
    "AWS_SECRET_ACCESS_KEY": "a950a4265f9d79628dc188ebb3a0eb4d",
    "AWS_DEFAULT_REGION": "us-east-1",
    "AWS_ENDPOINT_URL": "https://pdx.s8k.io",
    "S3_ENDPOINT_URL": "https://pdx.s8k.io",
}

API_KEY_PROD = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJ0b2tlbl90eXBlIjoicmVmcmVzaCIsImV4cCI6ODA3MDYzNDg2MCwiaWF0IjoxNzYzNDM0ODYwLCJqdGkiOiJkMzQ3MDlkMWY4MDk0YTg0YmUwMGNhYTAxOGQwODVmMyIsInVzZXJfaWQiOiI0In0."
    "OT8fXRdhod6MOWJl6UUS_m1wIOMoPj_KkTxAR8Mz4AE"
)

DEFAULT_S3_PREFIX = "s3://GrootDatasets/yam_lerobot_v5/"
DEFAULT_FPS = 30.0

# Headers we should NOT forward from the backend response
HOP_BY_HOP = frozenset(
    h.lower()
    for h in [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
    ]
)

# =============================================================================
# Import History (in-memory)
# =============================================================================

import_history: list = []
import_lock = threading.Lock()


def add_to_history(entry: dict):
    with import_lock:
        import_history.insert(0, entry)
        if len(import_history) > 200:
            import_history.pop()


# =============================================================================
# Core Import Logic
# =============================================================================


def check_label_studio(backend_host: str, backend_port: int) -> bool:
    """Check if the Label Studio backend is reachable."""
    try:
        conn = http.client.HTTPConnection(backend_host, backend_port, timeout=3)
        conn.request("GET", "/health")
        resp = conn.getresponse()
        conn.close()
        return resp.status == 200
    except Exception:
        return False


def expand_dataset_dir(dataset_dir: str) -> str:
    """Expand short dataset name to full S3 path if needed."""
    dataset_dir = dataset_dir.strip().strip('"').strip("'")
    if not dataset_dir:
        return dataset_dir
    if dataset_dir.startswith("s3://") or dataset_dir.startswith("/"):
        return dataset_dir
    return DEFAULT_S3_PREFIX + dataset_dir


def do_import(dataset_dir: str, ls_url: str, api_key: str) -> dict:
    """Import a dataset into Label Studio. Returns dict with results."""
    start_time = time.time()

    # Set S3 environment variables
    for key, val in S3_CREDENTIALS.items():
        os.environ[key] = val

    full_dataset_dir = expand_dataset_dir(dataset_dir)

    # Create config — point SDK at the *backend* LS port
    cfg = Config(
        api_key=api_key,
        base_url=ls_url,
        dataset_dir=full_dataset_dir,
        fps=DEFAULT_FPS,
    )

    client = LabelStudioClient(base_url=cfg.base_url, api_key=cfg.api_key)

    # Verify connection
    try:
        user_info = client.users.whoami()
        email = user_info.email if hasattr(user_info, "email") else "User"
    except Exception as e:
        return {
            "success": False,
            "error": f"Failed to authenticate with Label Studio backend: {e}",
            "dataset_dir": full_dataset_dir,
        }

    # Create project
    label_config = create_label_config(cfg.fps)
    project_name = derive_project_name(full_dataset_dir, max_len=50)
    project = client.projects.create(title=project_name, label_config=label_config)

    # Import tasks
    task_count = import_lerobot_tasks(cfg, client, project)

    # Setup export storage
    try:
        ensure_export_storage(cfg, client, project.id)
    except Exception as e:
        print(f"Warning: Could not setup export storage: {e}")

    elapsed = time.time() - start_time

    result = {
        "success": True,
        "project_id": project.id,
        "project_name": project.title,
        "task_count": task_count,
        "dataset_dir": full_dataset_dir,
        "elapsed_seconds": round(elapsed, 1),
        "timestamp": datetime.now().isoformat(),
        "user": email,
    }
    add_to_history(result)
    return result


# =============================================================================
# HTML Templates
# =============================================================================

IMPORT_PAGE_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Import Dataset — Label Studio</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f7fa;color:#333;min-height:100vh}
        .container{max-width:1100px;margin:0 auto;padding:2rem 1rem}
        .header{text-align:center;margin-bottom:2rem}
        .header h1{font-size:1.8rem;color:#1a1a2e;margin-bottom:.5rem}
        .header p{color:#666;font-size:.95rem}
        .nav{text-align:center;margin-bottom:1.5rem}
        .nav a{color:#4361ee;text-decoration:none;font-weight:600;margin:0 .75rem}
        .nav a:hover{text-decoration:underline}
        .status-bar{display:flex;align-items:center;gap:.5rem;padding:.75rem 1rem;background:#fff;border-radius:8px;margin-bottom:1.5rem;box-shadow:0 1px 3px rgba(0,0,0,.08)}
        .status-dot{width:10px;height:10px;border-radius:50%;background:#ccc}
        .status-dot.online{background:#4caf50}.status-dot.offline{background:#f44336}
        .status-text{font-size:.9rem;color:#555}
        .card{background:#fff;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem;box-shadow:0 2px 8px rgba(0,0,0,.06)}
        .card h2{font-size:1.1rem;color:#1a1a2e;margin-bottom:1rem}
        .input-group{display:flex;gap:.75rem}
        .input-group input{flex:1;padding:.75rem 1rem;border:2px solid #e0e0e0;border-radius:8px;font-size:.95rem;outline:none;transition:border-color .2s}
        .input-group input:focus{border-color:#4361ee}
        .btn{padding:.75rem 1.5rem;background:#4361ee;color:#fff;border:none;border-radius:8px;font-size:.95rem;font-weight:600;cursor:pointer;transition:background .2s;white-space:nowrap}
        .btn:hover{background:#3651d4}.btn:disabled{background:#a0a0a0;cursor:not-allowed}
        .hint{margin-top:.75rem;font-size:.82rem;color:#888}
        .hint code{background:#f0f0f0;padding:.15rem .4rem;border-radius:4px;font-size:.8rem}
        .result{display:none;margin-top:1rem;padding:1rem;border-radius:8px}
        .result.success{display:block;background:#e8f5e9;border:1px solid #a5d6a7}
        .result.error{display:block;background:#ffebee;border:1px solid #ef9a9a}
        .result h3{font-size:1rem;margin-bottom:.5rem}
        .result p{font-size:.9rem;margin:.3rem 0}
        .result a{color:#4361ee;text-decoration:none;font-weight:600}
        .result a:hover{text-decoration:underline}
        .spinner{display:none;margin-top:1rem;text-align:center;padding:1.5rem}
        .spinner.active{display:block}
        .spinner-icon{display:inline-block;width:32px;height:32px;border:3px solid #e0e0e0;border-top-color:#4361ee;border-radius:50%;animation:spin .8s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
        .spinner p{margin-top:.75rem;color:#666;font-size:.9rem}
        .table-wrap{overflow-x:auto;margin:0 -.5rem;padding:0 .5rem}
        .history-table{width:100%;border-collapse:collapse;font-size:.85rem;table-layout:fixed}
        .history-table th{text-align:left;padding:.5rem;border-bottom:2px solid #e0e0e0;color:#555;font-weight:600;white-space:nowrap}
        .history-table td{padding:.5rem;border-bottom:1px solid #f0f0f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .history-table .col-name{width:40%}.history-table .col-st{width:8%}.history-table .col-tasks{width:8%}.history-table .col-proj{width:24%}.history-table .col-src{width:8%}.history-table .col-time{width:12%}
        .history-table a{color:#4361ee;text-decoration:none}
        .history-table a:hover{text-decoration:underline}
        .badge{display:inline-block;padding:.15rem .5rem;border-radius:12px;font-size:.75rem;font-weight:600}
        .badge.ok{background:#e8f5e9;color:#2e7d32}.badge.fail{background:#ffebee;color:#c62828}
        .empty-state{text-align:center;color:#999;padding:1.5rem;font-size:.9rem}
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>Import Dataset</h1>
        <p>Import LeRobot datasets into Label Studio</p>
    </div>
    <div class="nav">
        <a href="/">← Back to Label Studio</a>
    </div>
    <div class="status-bar">
        <div class="status-dot" id="statusDot"></div>
        <span class="status-text" id="statusText">Checking Label Studio…</span>
    </div>
    <div class="card">
        <h2>Import Dataset</h2>
        <form id="importForm" onsubmit="handleImport(event)">
            <div class="input-group">
                <input type="text" id="datasetDir" name="dataset_dir"
                       placeholder="e.g. xdof.assembly_2026-02-06_10-45-09_firetruck_v4_USA"
                       autocomplete="off" required />
                <button type="submit" class="btn" id="importBtn">Import</button>
            </div>
        </form>
        <div class="hint">
            Enter a dataset name (auto-expands to <code>%%S3_PREFIX%%NAME</code>)<br>
            or a full S3 path like <code>s3://bucket/path/dataset</code>
        </div>
        <div class="spinner" id="spinner">
            <div class="spinner-icon"></div>
            <p>Importing dataset… This may take a few seconds.</p>
        </div>
        <div id="result"></div>
    </div>
    <div class="card">
        <h2>Recent Imports</h2>
        <div id="historyContainer"><div class="empty-state">No imports yet</div></div>
    </div>
</div>
<script>
async function checkStatus(){
    try{
        const r=await fetch('/api/import_status');
        const d=await r.json();
        const dot=document.getElementById('statusDot');
        const txt=document.getElementById('statusText');
        if(d.label_studio_online){dot.className='status-dot online';txt.textContent='Label Studio backend is running';}
        else{dot.className='status-dot offline';txt.textContent='Label Studio backend is NOT running';}
    }catch(e){document.getElementById('statusDot').className='status-dot offline';document.getElementById('statusText').textContent='Cannot reach server';}
}
async function loadHistory(){
    try{
        const r=await fetch('/api/import_history');
        const d=await r.json();
        const c=document.getElementById('historyContainer');
        if(!d.history||!d.history.length){c.innerHTML='<div class="empty-state">No imports yet</div>';return;}
        let h='<div class="table-wrap"><table class="history-table"><thead><tr><th class="col-name">Dataset / Project</th><th class="col-st">Status</th><th class="col-tasks">Tasks</th><th class="col-proj">Project</th><th class="col-src">Source</th><th class="col-time">Time</th></tr></thead><tbody>';
        d.history.forEach(e=>{
            const name=e.dataset_dir?e.dataset_dir.split('/').pop():(e.project_name||'?');
            const st=e.success?'<span class="badge ok">OK</span>':'<span class="badge fail">FAIL</span>';
            const tasks=e.task_count||'-';
            const pname=e.project_name||'#'+e.project_id;
            const link=e.project_id?'<a href="/projects/'+e.project_id+'/" target="_blank" title="'+pname+'">'+pname+'</a>':(e.error||'-');
            const src=e.source==='label_studio'?'<span style="color:#888;font-size:.8rem">Existing</span>':'<span style="color:#4361ee;font-size:.8rem">Imported</span>';
            const ts=e.timestamp?new Date(e.timestamp).toLocaleString():'-';
            h+='<tr><td title="'+(e.dataset_dir||e.project_name||'')+'">'+name+'</td><td>'+st+'</td><td>'+tasks+'</td><td title="'+pname+'">'+link+'</td><td>'+src+'</td><td>'+ts+'</td></tr>';
        });
        h+='</tbody></table></div>';c.innerHTML=h;
    }catch(e){}
}
async function handleImport(ev){
    ev.preventDefault();
    const input=document.getElementById('datasetDir');
    const btn=document.getElementById('importBtn');
    const spinner=document.getElementById('spinner');
    const res=document.getElementById('result');
    const dd=input.value.trim();if(!dd)return;
    btn.disabled=true;spinner.className='spinner active';res.innerHTML='';res.className='result';
    try{
        const r=await fetch('/api/import?dataset_dir='+encodeURIComponent(dd));
        const d=await r.json();
        if(d.success){
            res.className='result success';
            res.innerHTML='<h3>Import Successful!</h3>'+
                '<p>Project: <a href="/projects/'+d.project_id+'/">'+d.project_name+' (#'+d.project_id+')</a></p>'+
                '<p>Tasks imported: '+d.task_count+'</p>'+
                '<p>Time: '+d.elapsed_seconds+'s</p>';
        }else{
            res.className='result error';
            res.innerHTML='<h3>Import Failed</h3><p>'+(d.error||'Unknown error')+'</p>';
        }
    }catch(e){res.className='result error';res.innerHTML='<h3>Request Failed</h3><p>'+e.message+'</p>';
    }finally{btn.disabled=false;spinner.className='spinner';loadHistory();}
}
window.addEventListener('DOMContentLoaded',()=>{
    checkStatus();loadHistory();setInterval(checkStatus,30000);
    const p=new URLSearchParams(window.location.search);
    const dd=p.get('dataset_dir');
    if(dd){document.getElementById('datasetDir').value=dd;document.getElementById('importForm').dispatchEvent(new Event('submit'));}
});
</script>
</body>
</html>"""


# =============================================================================
# Reverse Proxy + Import Handler
# =============================================================================


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

    def __init__(self, server_address, handler_class, backend_host, backend_port, api_key):
        self.backend_host = backend_host
        self.backend_port = backend_port
        self.api_key = api_key
        self.ls_url = f"http://{backend_host}:{backend_port}"
        super().__init__(server_address, handler_class)


class ProxyHandler(BaseHTTPRequestHandler):
    """
    Reverse-proxy handler.

    Special paths handled locally:
      /?dataset_dir=…        → import & redirect to project
      /import                → import form UI
      /api/import            → JSON import API
      /api/import_status     → JSON backend status
      /api/import_history    → JSON import history

    Everything else is proxied transparently to the Label Studio backend.
    """

    # Use HTTP/1.1 so connections can be reused (critical for tunnel services)
    protocol_version = "HTTP/1.1"

    server: ThreadedHTTPServer  # type hint for IDE

    def log_message(self, format, *args):
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"[{ts}] {self.address_string()} {args[0]}")

    # ------------------------------------------------------------------
    # Routing
    # ------------------------------------------------------------------

    def _route(self):
        """Decide whether to handle locally or proxy."""
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        params = parse_qs(parsed.query)

        # 1) Root URL with dataset_dir → import and redirect
        if path == "/" and "dataset_dir" in params:
            dd = params["dataset_dir"][0]
            self._handle_browser_import(dd)
            return

        # 2) Path-style: /dataset_dir=xxx
        m = re.match(r"^/dataset_dir=(.+)$", path)
        if m:
            dd = m.group(1)
            self._handle_browser_import(dd)
            return

        # 3) Import UI page
        if path == "/import":
            self._serve_import_page(params)
            return

        # 4) API endpoints
        if path == "/api/import":
            self._handle_api_import(params)
            return
        if path == "/api/import_status":
            self._handle_api_status()
            return
        if path == "/api/import_history":
            self._handle_api_history()
            return

        # 5) Everything else → proxy to Label Studio backend
        self._proxy()

    do_GET = _route
    do_POST = _route
    do_PUT = _route
    do_PATCH = _route
    do_DELETE = _route
    do_HEAD = _route
    do_OPTIONS = _route

    # ------------------------------------------------------------------
    # Proxy
    # ------------------------------------------------------------------

    def _proxy(self):
        """Forward the request to the Label Studio backend."""
        try:
            conn = http.client.HTTPConnection(
                self.server.backend_host, self.server.backend_port, timeout=120
            )

            # Read request body
            content_length = int(self.headers.get("Content-Length", 0))
            req_body = self.rfile.read(content_length) if content_length > 0 else None

            # Build forwarded headers (use items() to preserve duplicates)
            headers = {}
            for key, val in self.headers.items():
                if key.lower() in ("host",):
                    continue
                headers[key] = val
            headers["Host"] = f"{self.server.backend_host}:{self.server.backend_port}"
            headers["X-Forwarded-For"] = self.client_address[0]
            headers["X-Forwarded-Host"] = self.headers.get("Host", "localhost")
            # Detect if client came via HTTPS (e.g. loophole, ngrok)
            fwd_proto = self.headers.get("X-Forwarded-Proto", "http")
            headers["X-Forwarded-Proto"] = fwd_proto

            conn.request(self.command, self.path, body=req_body, headers=headers)
            resp = conn.getresponse()

            # Read full response body so we can set Content-Length reliably
            # (backend may use chunked encoding which we strip)
            resp_body = resp.read()

            # Send response status (use send_response_only to avoid auto Date/Server)
            self.send_response_only(resp.status)

            # Forward response headers from backend
            skip_headers = HOP_BY_HOP | {"content-length"}
            for key, val in resp.getheaders():
                if key.lower() in skip_headers:
                    continue
                if key.lower() == "location":
                    val = self._rewrite_location(val)
                self.send_header(key, val)

            # Set accurate Content-Length
            self.send_header("Content-Length", str(len(resp_body)))
            self.end_headers()

            if self.command != "HEAD":
                self.wfile.write(resp_body)

            conn.close()
        except ConnectionRefusedError:
            error_msg = (
                f"Cannot connect to Label Studio backend at "
                f"{self.server.backend_host}:{self.server.backend_port}"
            )
            print(error_msg)
            body = error_msg.encode()
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            error_msg = f"Proxy error: {e}"
            print(error_msg)
            body = error_msg.encode()
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def _rewrite_location(self, location: str) -> str:
        """Rewrite backend Location header to point at proxy port."""
        backend_origin = f"http://{self.server.backend_host}:{self.server.backend_port}"
        if location.startswith(backend_origin):
            path_part = location[len(backend_origin):]
        elif location.startswith("/"):
            path_part = location
        else:
            return location

        # Build the correct origin from the client's perspective
        host = self.headers.get("Host", f"localhost:{self.server.server_address[1]}")
        proto = self.headers.get("X-Forwarded-Proto", "http")
        return f"{proto}://{host}{path_part}"

    # ------------------------------------------------------------------
    # Import handlers
    # ------------------------------------------------------------------

    def _handle_browser_import(self, dataset_dir: str):
        """Import dataset and redirect browser to the new project page."""
        try:
            result = do_import(
                dataset_dir=dataset_dir,
                ls_url=self.server.ls_url,
                api_key=self.server.api_key,
            )
            if result.get("success"):
                # Redirect to project page (through proxy, so stays on :8080)
                redirect_url = f"/projects/{result['project_id']}/"
                self.send_response(302)
                self.send_header("Location", redirect_url)
                self.end_headers()
            else:
                self._send_html(
                    f"<h2>Import Failed</h2><p>{result.get('error', 'Unknown error')}</p>"
                    f"<p><a href='/import'>Try again</a></p>",
                    status=500,
                )
        except Exception as e:
            tb = traceback.format_exc()
            print(f"Import error:\n{tb}")
            add_to_history({
                "success": False,
                "error": str(e),
                "dataset_dir": expand_dataset_dir(dataset_dir),
                "timestamp": datetime.now().isoformat(),
            })
            self._send_html(
                f"<h2>Import Error</h2><pre>{tb}</pre><p><a href='/import'>Try again</a></p>",
                status=500,
            )

    def _handle_api_import(self, params: dict):
        """JSON API: import dataset."""
        dataset_dir = params.get("dataset_dir", [None])[0]
        if not dataset_dir:
            self._send_json({"success": False, "error": "dataset_dir parameter is required"}, 400)
            return
        try:
            result = do_import(
                dataset_dir=dataset_dir,
                ls_url=self.server.ls_url,
                api_key=self.server.api_key,
            )
            # Add project_url relative to proxy
            if result.get("success"):
                result["project_url"] = f"/projects/{result['project_id']}/"
            self._send_json(result, 200 if result.get("success") else 500)
        except Exception as e:
            tb = traceback.format_exc()
            print(f"Import error:\n{tb}")
            err = {
                "success": False,
                "error": str(e),
                "dataset_dir": expand_dataset_dir(dataset_dir),
                "timestamp": datetime.now().isoformat(),
            }
            add_to_history(err)
            self._send_json(err, 500)

    def _handle_api_status(self):
        online = check_label_studio(self.server.backend_host, self.server.backend_port)
        self._send_json({"label_studio_online": online, "backend": self.server.ls_url})

    def _handle_api_history(self):
        # Merge in-memory import history with existing Label Studio projects
        with import_lock:
            history_copy = list(import_history)

        # Also fetch all projects from Label Studio backend
        ls_projects = []
        try:
            client = LabelStudioClient(
                base_url=self.server.ls_url, api_key=self.server.api_key
            )
            projects = client.projects.list()
            # Track project IDs already in import history to avoid duplicates
            known_ids = {e.get("project_id") for e in history_copy if e.get("project_id")}
            for p in projects:
                if p.id in known_ids:
                    continue
                ls_projects.append({
                    "success": True,
                    "project_id": p.id,
                    "project_name": p.title,
                    "task_count": p.task_number if hasattr(p, "task_number") else "-",
                    "dataset_dir": "",
                    "timestamp": p.created_at.isoformat() if hasattr(p, "created_at") and p.created_at else "",
                    "source": "label_studio",
                })
        except Exception as e:
            print(f"Warning: could not fetch projects from LS: {e}")

        # Combine: recent imports first, then LS projects sorted by creation time desc
        ls_projects.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
        combined = history_copy + ls_projects
        self._send_json({"history": combined})

    def _serve_import_page(self, params: dict):
        html = IMPORT_PAGE_HTML.replace("%%S3_PREFIX%%", DEFAULT_S3_PREFIX)
        self._send_html(html)

    # ------------------------------------------------------------------
    # Response helpers
    # ------------------------------------------------------------------

    def _send_json(self, data: dict, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html: str, status: int = 200):
        body = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


# =============================================================================
# Main
# =============================================================================


def main():
    parser = argparse.ArgumentParser(
        description="Reverse-proxy + Dataset Import server for Label Studio",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Architecture:
  Browser  →  :PORT (this proxy)  →  :BACKEND (Label Studio)

All Label Studio pages are accessible through the proxy.
Import datasets via URL without needing API keys or S3 credentials.

Examples:
  python dataset_server.py                          # proxy :8080 → LS :8081
  python dataset_server.py --port 8080 --backend 8081

Access:
  http://localhost:8080/                             # Label Studio (proxied)
  http://localhost:8080/?dataset_dir=DATASET_NAME    # import & redirect
  http://localhost:8080/dataset_dir=DATASET_NAME     # import & redirect
  http://localhost:8080/import                       # import Web UI
  http://localhost:8080/api/import?dataset_dir=NAME  # JSON API
        """,
    )
    parser.add_argument(
        "--port", type=int, default=8080,
        help="Port for this proxy server (default: 8080)",
    )
    parser.add_argument(
        "--backend", type=int, default=8081,
        help="Label Studio backend port (default: 8081)",
    )
    parser.add_argument(
        "--backend-host", type=str, default="localhost",
        help="Label Studio backend host (default: localhost)",
    )
    parser.add_argument(
        "--api-key", type=str, default=None,
        help="Label Studio API key (default: embedded production key)",
    )
    args = parser.parse_args()

    api_key = args.api_key or API_KEY_PROD

    print()
    print("=" * 60)
    print("  Label Studio Reverse Proxy + Dataset Import")
    print("=" * 60)
    print(f"  Proxy port:        {args.port}")
    print(f"  LS backend:        {args.backend_host}:{args.backend}")
    print(f"  S3 prefix:         {DEFAULT_S3_PREFIX}")
    print()

    if check_label_studio(args.backend_host, args.backend):
        print("  LS backend status: ONLINE")
    else:
        print("  LS backend status: OFFLINE (will retry on each request)")
    print()

    server = ThreadedHTTPServer(
        ("0.0.0.0", args.port),
        ProxyHandler,
        backend_host=args.backend_host,
        backend_port=args.backend,
        api_key=api_key,
    )

    print(f"  Listening on http://0.0.0.0:{args.port}")
    print()
    print("  Routes:")
    print(f"    http://localhost:{args.port}/                           → Label Studio")
    print(f"    http://localhost:{args.port}/?dataset_dir=NAME          → import + redirect")
    print(f"    http://localhost:{args.port}/dataset_dir=NAME           → import + redirect")
    print(f"    http://localhost:{args.port}/import                     → import Web UI")
    print(f"    http://localhost:{args.port}/api/import?dataset_dir=... → JSON API")
    print()
    print("  Press Ctrl+C to stop")
    print("=" * 60)
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
