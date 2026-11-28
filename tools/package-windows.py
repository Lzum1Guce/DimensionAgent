"""Bundle the reviewed public client only. Never use a deployed data directory as input."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

SOURCE = Path(__file__).resolve().parents[1]
ROLES = "claude deepseek gemini glm gpt grok kimi qwen".split()
UI_FILES = """DimensionAgent.ico THIRD_PARTY_NOTICES.txt anime-fx.js app-bridge-ui.js app-bridge.css app.js archived-work-ui.js attachment-library-ui.js boot-guard.js bot-archive-ui.js capability-status-ui.js change-diff-ui.js character-directory-example.json client-settings-ui.js cli-engine-catalog.js model-catalog-view.js cli-reception-modal.css cli-reception-modal.js cli-sandbox-settings-ui.js codex-theme.css pixel-theater-stage.js pixel-theater-stage.css playground-ui.js playground-ui.css context-limits-ui.js context-usage-ui.js context-usage.css conversation-archive-ui.js conversation-archive.css conversation-services-ui.js design-polish.css dimension-bot-avatar.js dimension-bot.css dimensionagent-icon.png experience-drafts.js experience.css galgame-bgm.js galgame-stage.css galgame-stage.js galgame-voice.js global-search-ui.js group-invite-ui.js group-invite.css group-message-ui.js group-relay-fx.js group-roster.js group-stream-state.js group-work-ui.js index.html linux-desktop-ui.js living-memory-ui.js markdown-lite.js message-actions.css message-context-ui.js model-canvas-ui.js model-canvas.css motion-fx.css motion-fx.js network-proxy-ui.js notification-inbox-ui.js p1-polish.css panels-p1.css paper-seal.js plugin-market-ui.css plugin-market-ui.js proactive-reminders-ui.js shared-capabilities-ui.js sidebar-state-ui.js skill-learning-ui.js splash.png startup-wordmark.png stickers.js story-theater-v3.css story-theater-v3.js studio-workstations-ui.js styles.css tarot-holo.js task-templates-ui.js task-templates.css thought-stream.js transcript-scroll.js ui-icons.js work-artifacts-dock.js work-cli-picker.js work-github-ui.js work-model-ui.js work-rollup-stream.js work-roster-tree.js work-session-ui.js work-task-groups.js work-task-panel.css""".split()
RUNTIME = "coplay-protocol.mjs cross-harness-mcp.mjs local-dsh-discovery.mjs plugin-host-guard.mjs plugin-host.mjs website-egress.mjs website-guide.mjs website-sandbox-proxy.mjs website-sandbox.mjs".split()
LINUX = "dimension-desktop-helper dimension-exec-helper dimension-sandbox-root.sh dimension-software-helper dimension-userns.py dimension-workspace-root.py".split()

def copy(source, dest):
    if not source.is_file() or source.is_symlink():
        raise ValueError(f"Expected regular distribution file: {source}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, dest)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def copy_public_ui(release_ui, dest_ui):
    for name in UI_FILES + ["LICENSES/OpenMausBot-Apache-2.0.txt", "LICENSES/OpenMausBot-NOTICE.txt"]:
        copy(release_ui/name,dest_ui/name)
    reminder = dest_ui/"proactive-reminders-ui.js"
    reminder.write_text(reminder.read_text(encoding="utf-8").replace(r"D:\\SampleProject",r"C:\\Projects\\MyApp"),encoding="utf-8")
    for role in ROLES:
        for name in ["default-avatars/"+role+".png", "tarot-cards/"+role+".webp"]:
            copy(release_ui/name,dest_ui/name)
        folder = Path("gal-sprites")/("ai-"+role)
        for f in (release_ui/folder).rglob("*.webp"):
            copy(f,dest_ui/f.relative_to(release_ui))
        if not (dest_ui/folder/"neutral.webp").exists():
            raise ValueError(f"Missing portrait: {role}")
    gemini = "gal-sprites/ai-gemini/manifest.json"
    copy(release_ui/gemini,dest_ui/gemini)
    for bg in ["ai-girls-group", "cafe", "classroom", "observatory", "study"]:
        name="gal-bgs/"+bg+".webp"
        copy(release_ui/name,dest_ui/name)
    for name in (SOURCE/"tools/windows-public-game-assets.txt").read_text(encoding="utf-8").splitlines():
        asset_root = SOURCE/"ui"
        asset = asset_root/name
        if asset.resolve() != asset_root.resolve()/name:
            raise ValueError(f"Unexpected asset link: {name}")
        copy(asset, dest_ui/name)

def package():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("install", "work", "compiler", "webview", "output"):
        parser.add_argument("--" + arg, required=True, type=Path)
    a = parser.parse_args()
    work = a.work.resolve()
    work.mkdir(parents=True, exist_ok=True)
    build = Path(tempfile.mkdtemp(prefix="package-", dir=work))
    payload = build/"payload"
    prefix = Path("app/native-release/public")
    dest = payload/prefix
    config = json.loads((a.install/"native-client.json").read_text(encoding="utf-8-sig"))
    release = (a.install/config["ui"]).resolve().parent
    if release.parent != (a.install/"app/native-release").resolve():
        raise ValueError("Expected the active immutable application release")
    copy(a.install/"DImensionagent.exe", payload/"DImensionagent.exe")
    for name in ["native/DImensionagent-native.exe", "runtime/node/node.exe", "runtime/webview2/WebView2Loader.dll"]:
        copy(release/name, dest/name)
    for name in RUNTIME:
        copy(release/"runtime"/name, dest/"runtime"/name)
    for name in LINUX:
        copy(release/"linux"/name, dest/"linux"/name)
    copy_public_ui(release/"ui", dest/"ui")
    copy(SOURCE/"LICENSE",payload/"licenses/LICENSE")
    copy(SOURCE/"third_party/webview2/1.0.4314.35/LICENSE.txt",payload/"licenses/WebView2.txt")
    for name in ["NODE-LICENSE.txt","RIPGREP-COPYING.txt"]:
        copy(work/name,payload/"licenses"/name)
    copy(a.install/"app/native-runtime/cli-kit/bin/rg.exe",payload/"app/native-runtime/cli-kit/bin/rg.exe")
    for name in ["package.json","package-lock.json"]:
        copy(SOURCE/"runtime"/name,dest/"runtime"/name)
    subprocess.run(["npm.cmd","ci","--ignore-scripts","--omit=dev","--no-audit","--no-fund","--prefer-offline"],cwd=dest/"runtime",check=True)
    subprocess.run(["node",SOURCE/"tools/hash-versions.js",dest/"ui"],check=True)
    subprocess.run(["node",SOURCE/"tools/hash-versions.js",dest/"ui","--check"],check=True)
    public={key:(prefix/path).as_posix() for key,path in {
        "backend":"native/DImensionagent-native.exe","ui":"ui","loader":"runtime/webview2/WebView2Loader.dll",
        "node":"runtime/node/node.exe","pluginHost":"runtime/plugin-host.mjs","icon":"ui/DimensionAgent.ico",
        "splash":"ui/splash.png","desktopHelper":"linux/dimension-desktop-helper"}.items()}
    public.update(data="data",sandboxDistribution="dimension-sandbox",desktopHomeRoot="/home/dimension")
    (payload/"native-client.json").write_text(json.dumps(public,indent=2),encoding="utf-8")
    files=sorted(f for f in payload.rglob("*") if f.is_file())
    forbidden=re.compile(rb"(?i:(?:[CL]:[\\/]+Users[\\/]+[^\\/\s]+[\\/]+(?:AppData|Desktop|Documents)|L:[\\/]+(?:agent file|xmwcodex|DimensionAgent-src)))|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/]{32}|gh[pousr]_[A-Za-z0-9]{36,}|(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{40,}")
    manifest={}
    for f in files:
        rel=f.relative_to(payload)
        if f.is_symlink() or f.suffix.lower() in {".db",".sqlite",".sqlite3",".vhdx",".log",".pem",".pfx",".pdb"} or f.name.lower() in {"settings.json","hosts.yml",".npmrc",".env","cookies","login data"}:
            raise ValueError(f"Unexpected private or mutable file: {rel}")
        data=f.read_bytes()
        if forbidden.search(data) or (f.suffix.lower() in {".exe",".dll"} and forbidden.search(data.replace(b"\0",b""))):
            raise ValueError(f"Potential private material: {rel}")
        manifest[rel.as_posix()]=hashlib.sha256(data).hexdigest()
    (build/"manifest.json").write_text(json.dumps(manifest,indent=2),encoding="utf-8")
    uninstall=build/"remove.nsh"
    commands=['Delete "$INSTDIR\\'+str(f.relative_to(payload)).replace('$','$$')+'"' for f in files]
    directories=sorted((d for d in payload.rglob("*") if d.is_dir()),key=lambda d:-len(d.parts))
    commands+=['RMDir "$INSTDIR\\'+str(d.relative_to(payload)).replace('$','$$')+'"' for d in directories]
    uninstall.write_text("\n".join(commands),encoding="utf-8-sig")
    a.output.parent.mkdir(parents=True,exist_ok=True)
    subprocess.run([a.compiler,"/V2","/INPUTCHARSET","UTF8",f"/DPAYLOAD={payload}",f"/DWEBVIEW={a.webview.resolve()}",
                    f"/DDIST_EXE={a.output.resolve()}",f"/DREMOVE_LIST={uninstall}",SOURCE/"tools/windows-client.nsi"],check=True)
    print(f"Packaged {len(files)} approved files; manifest: {build/'manifest.json'}",flush=True)
if __name__=="__main__":
    package()
