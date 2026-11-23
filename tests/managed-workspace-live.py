#!/usr/bin/env python3
"""Live managed-workspace test against an independently launched native server."""
import hashlib
import http.server
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ORIGIN = sys.argv[1].rstrip("/")
OUTPUT = Path(sys.argv[2]).resolve()
OUTPUT.mkdir(parents=True, exist_ok=True)
BOT = sys.argv[3] if len(sys.argv) > 3 else "managed-live"
KEY = "bot-" + hashlib.sha256(BOT.encode()).hexdigest()[:32]
LINUX_ROOT = "/var/lib/dimension/managed/" + KEY
state = {"calls": [], "errors": []}


class Model(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
            results = [json.loads(message["content"]) for message in body.get("messages", [])
                       if message.get("role") == "tool"]
            if not results:
                name = "sandbox_exec"
                args = {"argv": ["/usr/bin/python3", "-c",
                                 "import pathlib\nfor i in range(16):\n pathlib.Path(f'quota-{i}.bin').write_bytes(b'x'*(31*1024**2))"],
                        "timeoutSeconds": 60}
            else:
                receipt = json.loads(results[-1]["result"])
                assert results[-1]["error"] is True
                assert receipt["code"] == "command_failed", receipt
                assert "Disk quota exceeded" in receipt["stderr"], receipt
                assert receipt["workspaceWriteQuota"] is True
                assert receipt["workspaceWriteQuotaBytes"] == 448 * 1024**2
                name = "final_response"
                args = {"content": "kernel quota rejected the excess write"}
            state["calls"].append({"name": name})
            call_id = "managed-" + str(len(state["calls"]))
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


model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
thread = threading.Thread(target=model.serve_forever, daemon=True)
thread.start()


def request(route, payload=None, method=None, expected=200):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(ORIGIN + route, data=data, method=method or ("POST" if data else "GET"),
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            body = response.read()
            status = response.status
    except urllib.error.HTTPError as error:
        body = error.read()
        status = error.code
    if status != expected:
        raise AssertionError((route, status, body[:2000]))
    return json.loads(body)


def wsl_python(code):
    result = subprocess.run(["C:/Windows/System32/wsl.exe", "-d", "dimension-sandbox", "-u", "root",
                             "--exec", "/usr/bin/python3", "-c", code], capture_output=True, timeout=30)
    if result.returncode:
        raise AssertionError(result.stderr.decode("utf-8", "replace"))
    return result.stdout.decode("utf-8", "replace").strip()


try:
    request("/api/dimension/bots", {"id": BOT, "name": "managed-live-fixture", "mode": "work"})
    settings = request("/api/dimension/work/settings?botId=" + BOT)["settings"]
    assert settings["managedWorkspace"] is True and settings["workspaceWriteQuota"] is True
    assert settings["workspaceWriteQuotaBytes"] == 448 * 1024**2
    assert settings["projectCwd"].lower().startswith("\\\\wsl.localhost\\dimension-sandbox\\")
    print("PASS new Bot receives a managed 448 MiB hard-quota workspace", flush=True)

    request("/api/dimension/work/settings", {"botId": BOT, "approvalMode": "full"}, "PATCH")
    written = request("/api/dimension/work/tools", {"botId": BOT, "tool": "write",
        "path": "incoming/live.txt", "content": "windows-native-live", "requestId": "live-write"})
    assert written.get("ok") is True and written.get("pending") is False, written
    assert wsl_python("import pathlib; p=pathlib.Path('" + LINUX_ROOT +
                      "/incoming/live.txt'); assert p.read_text()=='windows-native-live'; s=p.stat(); print(s.st_uid,s.st_gid)") == "1001 1002"
    print("PASS native Windows write is immediately visible in Linux and shares quota gid 1002", flush=True)

    request("/api/dimension/work/software", {"apps": [{"id": "managed-desktop-probe",
        "name": "managed desktop probe", "executable": "/usr/bin/python3", "args": ["-c",
        "import pathlib;pathlib.Path('/workspace/desktop-probe.txt').write_text('managed-desktop-ok')"]}]}, "PUT")
    desktop = request("/api/dimension/work/desktops/" + BOT + "/action", {"action": {"op": "launch", "appId": "managed-desktop-probe"}})
    assert desktop["running"] is True and desktop["managedWorkspace"] is True, desktop
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            if wsl_python("import pathlib; assert pathlib.Path('" + LINUX_ROOT + "/desktop-probe.txt').read_text()=='managed-desktop-ok'; print('ok')") == "ok":
                break
        except AssertionError:
            time.sleep(0.1)
    else:
        raise AssertionError("managed desktop probe did not write")
    stopped = request("/api/dimension/work/desktops/" + BOT + "/stop", {})
    assert stopped["running"] is False, stopped
    print("PASS managed Linux desktop launches, writes and stops with the same identity mapping", flush=True)

    wsl_python("import pathlib; pathlib.Path('" + LINUX_ROOT + "/offline.html').write_text('<h1>managed-offline</h1>')")
    registry = request("/api/dimension/work/software")
    request("/api/dimension/work/software", {"apps": registry["apps"] + [{"id": "managed-chrome",
        "name": "managed offline Chrome", "executable": "/opt/google/chrome/chrome",
        "args": ["file:///workspace/offline.html"]}]}, "PUT")
    chrome = request("/api/dimension/work/desktops/" + BOT + "/action", {"action": {"op": "launch", "appId": "managed-chrome"}})
    assert chrome["running"] is True and len(chrome.get("png", "")) > 1000, chrome.keys()
    stopped = request("/api/dimension/work/desktops/" + BOT + "/stop", {})
    assert stopped["running"] is False, stopped
    print("PASS real Chrome launches from the managed desktop with an offline workspace page", flush=True)

    request("/api/providers", {"name": "managed-live-fixture", "entry": {"kind": "openai-chat-compat",
        "baseUrl": "http://127.0.0.1:" + str(model.server_address[1]) + "/v1",
        "spec": {"model": "managed-live-fixture"}}, "secret": {"kind": "literal", "value": "synthetic-only"}})
    request("/api/providers/managed-live-fixture/activate", {})
    run = request("/api/dimension/work/runs", {"botId": BOT, "requestId": "quota-overflow",
                                                "text": "write beyond the managed quota"})["run"]
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        current = request("/api/dimension/work/runs/" + run["id"])
        if current.get("terminal") and not current.get("executing"):
            break
        time.sleep(0.1)
    else:
        raise AssertionError("quota run timeout")
    assert current["status"] == "failed" and "unverified_text_completion" in current["error"], current
    assert current["response"] == "kernel quota rejected the excess write", current
    assert not state["errors"], state["errors"]
    size = int(wsl_python("import pathlib; print(sum(p.stat().st_size for p in pathlib.Path('" + LINUX_ROOT + "').glob('quota-*.bin')))"))
    assert 0 < size <= 448 * 1024**2, size
    print("PASS excess sandbox write receives EDQUOT and cannot exceed the hard quota", flush=True)
    result = {"ok": True, "checks": 5, "key": KEY, "quotaBytes": 448 * 1024**2,
              "overflowFileBytes": size, "settings": settings, "calls": state["calls"]}
    (OUTPUT / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print("RESULT " + str(OUTPUT / "result.json"), flush=True)
except Exception as error:
    (OUTPUT / "result.json").write_text(json.dumps({"ok": False, "error": repr(error),
        "key": KEY, "errors": state["errors"], "calls": state["calls"]}, ensure_ascii=False, indent=2), encoding="utf-8")
    raise
finally:
    model.shutdown()
    model.server_close()
    thread.join(timeout=2)
