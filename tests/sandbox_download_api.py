#!/usr/bin/env python3
"""Real native HTTP artifact download checks with a synthetic model fixture."""
import hashlib
import http.server
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(sys.argv[1]).resolve()
NATIVE = Path(sys.argv[2]).resolve()
PROJECT_SOURCE = Path(sys.argv[3]).resolve()
UI = Path(sys.argv[4]).resolve()
HELPER = Path(sys.argv[5]).resolve()
DATA = ROOT / "data"
OUTPUT = ROOT
DATA.mkdir(parents=True, exist_ok=True)
PROJECT_SOURCE.mkdir(parents=True, exist_ok=True)
(ROOT / "temp").mkdir(exist_ok=True)
for oversize_mib in (33, 48, 64):
    with (PROJECT_SOURCE / ("too-large-%d.bin" % oversize_mib)).open("wb") as file:
        file.seek(oversize_mib * 1024**2 - 1)
        file.write(b"\0")

state = {"mode": "maximum", "oversizeBytes": 33, "calls": [], "errors": []}


def tool_result_messages(body):
    return [json.loads(message["content"]) for message in body.get("messages", []) if message.get("role") == "tool"]


class ModelHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length))
            results = tool_result_messages(body)
            mode = state["mode"]
            if mode == "maximum":
                if len(results) == 0:
                    name = "sandbox_exec"
                    args = {"argv": ["/usr/bin/python3", "-c", "import pathlib;pathlib.Path('maximum.bin').write_bytes(b'x'*(32*1024*1024))"],
                            "outputs": ["maximum.bin"], "timeoutSeconds": 30}
                elif len(results) == 1:
                    last = results[0]
                    assert not last["error"], last
                    assert last["metadata"]["execution_outcome_known"] is True
                    receipt = json.loads(last["result"])
                    assert receipt["transportCleanupConfirmed"] is True
                    assert receipt["networkAccess"] is False
                    assert receipt["outputSnapshots"][0]["sizeBytes"] == 32 * 1024**2
                    # A later project write must not change the task snapshot download.
                    (PROJECT_SOURCE / "maximum.bin").write_bytes(b"z")
                    name = "task_finish"
                    args = {"summary": "32 MiB snapshot completed", "artifacts": last["artifacts"],
                            "verification": last["verification"]}
                else:
                    raise AssertionError("unexpected maximum round")
            else:
                oversize = state["oversizeBytes"]
                filename = "too-large-%d.bin" % oversize
                if len(results) == 0:
                    name = "sandbox_exec"
                    args = {"argv": ["/usr/bin/true"], "outputs": [filename], "timeoutSeconds": 30}
                elif len(results) == 1:
                    last = results[0]
                    assert last["error"] is True
                    assert last["metadata"]["execution_outcome_known"] is True
                    receipt = json.loads(last["result"])
                    assert receipt["code"] == "output_too_large"
                    assert "outputSnapshots" not in receipt
                    name = "final_response"
                    args = {"content": "%d MiB output rejected" % oversize}
                else:
                    raise AssertionError("unexpected oversized round")
            state["calls"].append({"mode": mode, "name": name, "args": args})
            call_id = "download-" + str(len(state["calls"]))
            if name == "final_response":
                delta = {"content": args["content"], "finish_reason": "stop"}
            else:
                delta = {"tool_calls": [{"index": 0, "id": call_id, "type": "function",
                                        "function": {"name": name, "arguments": json.dumps(args)}}],
                         "finish_reason": "tool_calls"}
            payload = ("data: " + json.dumps({"choices": [{"index": 0, "delta": delta}]}) +
                       "\n\ndata: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as error:
            state["errors"].append(repr(error))
            self.send_response(500)
            self.end_headers()
            self.wfile.write(repr(error).encode())

    def log_message(self, *args):
        pass


model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
model_thread = threading.Thread(target=model.serve_forever, daemon=True)
model_thread.start()
env = os.environ.copy()
env["TEMP"] = str(ROOT / "temp")
env["TMP"] = str(ROOT / "temp")
child = subprocess.Popen([
    str(NATIVE), "--data", str(DATA), "--ui", str(UI), "--port", "0",
    "--desktop-helper", str(HELPER.parent / "dimension-desktop-helper-apps"),
    "--sandbox-distro", "dimension-sandbox", "--desktop-home-root", "/home/dimension",
], cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
lines = queue.Queue()


def read_stdout():
    for raw in child.stdout:
        lines.put(raw)


reader = threading.Thread(target=read_stdout, daemon=True)
reader.start()
origin = None
try:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        raw = lines.get(timeout=1)
        value = json.loads(raw)
        if value.get("ready"):
            origin = "http://127.0.0.1:" + str(value["port"])
            break
    if not origin:
        raise AssertionError("native service did not become ready")

    def request(route, payload=None, method=None, expected=200):
        data = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(origin + route, data=data, method=method or ("POST" if data else "GET"),
                                     headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                body = response.read()
                status = response.status
        except urllib.error.HTTPError as error:
            body = error.read()
            status = error.code
        if status != expected:
            raise AssertionError((route, status, body[:1000]))
        return json.loads(body)

    def download(route):
        with urllib.request.urlopen(origin + route, timeout=90) as response:
            return response.status, response.read()

    request("/api/dimension/bots", {"id": "download", "name": "snapshot-download-fixture", "mode": "work"})
    request("/api/dimension/work/settings", {"botId": "download", "networkAccess": True}, "PATCH", 400)
    request("/api/dimension/work/settings", {"botId": "download", "approvalMode": "full", "networkAccess": False,
                                               "projectCwd": str(PROJECT_SOURCE)}, "PATCH")
    print("PASS networkAccess=true is rejected by the real settings API", flush=True)
    request("/api/providers", {"name": "download-fixture", "entry": {"kind": "openai-chat-compat",
        "baseUrl": "http://127.0.0.1:" + str(model.server_address[1]) + "/v1", "spec": {"model": "download-fixture"}},
        "secret": {"kind": "literal", "value": "synthetic-only"}})
    request("/api/providers/download-fixture/activate", {})

    def wait_run(run_id):
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            value = request("/api/dimension/work/runs/" + run_id)
            if value.get("terminal") and not value.get("executing"):
                return value
            time.sleep(0.05)
        raise AssertionError("run timeout")

    state["mode"] = "maximum"
    run = request("/api/dimension/work/runs", {"botId": "download", "requestId": "maximum", "text": "create exact 32 MiB output"})["run"]
    done = wait_run(run["id"])
    assert done["status"] == "completed", done
    files = request("/api/dimension/work/tasks/" + run["id"] + "/artifacts")["files"]
    maximum = next(file for file in files if file["extension"] == ".bin")
    assert maximum["bytes"] == 32 * 1024**2
    assert "sandbox-snapshots" in maximum["url"]
    status, content = download(maximum["url"])
    digest = hashlib.sha256(content).hexdigest()
    assert status == 200 and len(content) == 32 * 1024**2
    assert digest == hashlib.sha256(b"x" * (32 * 1024**2)).hexdigest()
    assert (PROJECT_SOURCE / "maximum.bin").read_bytes() == b"z"
    print("PASS exact 32 MiB snapshot is served by the real task download API after source replacement", flush=True)

    state["mode"] = "oversized"
    rejected = []
    for oversize in (33, 48, 64):
        state["oversizeBytes"] = oversize
        oversized_run = request("/api/dimension/work/runs", {"botId": "download", "requestId": "oversized-" + str(oversize),
            "text": "reject %d MiB output" % oversize})["run"]
        oversized_done = wait_run(oversized_run["id"])
        assert oversized_done["status"] == "failed", oversized_done
        oversized_files = request("/api/dimension/work/tasks/" + oversized_run["id"] + "/artifacts")["files"]
        assert not any(file["extension"] == ".bin" for file in oversized_files), oversized_files
        rejected.append({"bytes": oversize * 1024**2, "code": "output_too_large", "artifacts": len(oversized_files)})
        print("PASS %d MiB output returns output_too_large and publishes no artifact download" % oversize, flush=True)
    assert not state["errors"], state["errors"]
    evidence = {"ok": True, "checks": 5, "networkEnableRejected": True, "maximum": {"bytes": len(content), "sha256": digest,
                    "url": maximum["url"], "sourceAfterSnapshot": "z"},
                "oversized": rejected, "networkAccessDespiteDesktopSetting": False, "calls": state["calls"]}
    (ROOT / "result.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    print("RESULT " + str(ROOT / "result.json"), flush=True)
except Exception as error:
    (ROOT / "result.json").write_text(json.dumps({"ok": False, "error": repr(error), "calls": state["calls"],
                                                    "fixtureErrors": state["errors"]}, indent=2), encoding="utf-8")
    raise
finally:
    try:
        child.stdin.write(b"shutdown\n")
        child.stdin.flush()
        child.wait(timeout=15)
    except Exception:
        child.kill()
        child.wait(timeout=5)
    model.shutdown()
    model.server_close()
    model_thread.join(timeout=2)
