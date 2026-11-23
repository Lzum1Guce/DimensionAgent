Dimension Native Linux desktop helper

desktop_main.cpp is an original C++20 helper built with this project's own json.cpp/json.hpp. It does not read, launch or depend on the old application backend, any competitor worker, Electron, Playwright or Node. At runtime it uses the installed public Xvfb, Openbox, FFmpeg, xdotool and xclip programs through direct fork/exec argument arrays. There is no shell command concatenation. Applications supplied through launch are also executed directly by absolute path.

The caller must isolate and supervise each helper. The Windows native service owns Bot identity, workspace/software policy, permission and human-control decisions, observationId checks, the WSL/bubblewrap namespace and process-session lifetime. This helper is not an independent security boundary and must not be run against a shared host desktop. It assumes a private PID/IPC/network/mount namespace, private /tmp, /dev/shm, /run and HOME, a /workspace bind mount, readonly application/runtime mounts, uid/gid 1000, and a mounted /proc. Required executables are /usr/bin/Xvfb, /usr/bin/openbox, /usr/bin/ffmpeg, /usr/bin/xdotool and /usr/bin/xclip. The caller can supply Chrome or other installed graphical programs without changing the helper.

The helper sets DISPLAY=:99, HOME=/home/bot, TMPDIR=/tmp, XDG_RUNTIME_DIR=/run/user/1000 and cwd=/workspace. It starts its own Xvfb screen at 1280x800x24 with TCP listening disabled, waits for the real X geometry, then starts Openbox. Xvfb also receives -nolisten local: this disables its Linux abstract socket while preserving the pathname socket under the Bot's private /tmp. Abstract X sockets belong to the network namespace and would otherwise collide or connect another Bot when the caller enables --share-net. With only the private pathname socket, multiple network-enabled Bots can safely use :99. Do not separately start an X server for the same private namespace. Keep Xvfb's normal MIT-SHM extension enabled: disabling it caused the installed FFmpeg x11grab client to stall during input initialization.

Standard input/output protocol

Input is UTF-8 NDJSON. Each request is one line with an id (string <=128 bytes or nonnegative integer <=2^53-1), op and fields. Maximum line size is 256 KiB. Unknown operations and malformed or out-of-range arguments return an error. An incomplete trailing request at EOF is discarded because EOF means session cancellation.

After the real desktop is available:
  {"event":"ready","width":1280,"height":800,"previewFps":30}

Responses:
  {"id":"request-id","ok":true,"result":{...}}
  {"id":"request-id","ok":false,"error":{"code":"STATIC_CODE","message":"Static diagnostic."}}

Preview events:
  {"event":"frame","jpeg":"base64 JPEG bytes","seq":1,"width":1280,"height":800}

stdout contains only these JSON lines. A mutex serializes complete lines from actions and preview. Child stdout is captured only when required and otherwise discarded; child stderr is discarded. Helper stderr permits at most 16 fixed diagnostic lines of at most 160 bytes each. No external error text, executable arguments, typed text or clipboard content is included in diagnostics. The native WSL launcher may independently emit its own startup diagnostics; those are outside this helper.

Output is nonblocking with a two-second write deadline. Preview drops a whole frame when an action already owns the output lock. If the consumer stops draining a partially written line, the helper closes the session and cleans up; it does not silently continue a corrupt NDJSON stream. The consumer should continuously drain stdout and allow lines up to 8 MiB.

Operations

launch {executable,args?}
  executable must be an absolute path to a regular executable file. args is an array of at most 128 strings, each <=64 KiB and total executable/arguments <=128 KiB. NUL bytes are rejected. Returns {pid,launched:true} once exec succeeds. This does not assert that the application has finished starting or created a window. The parent service must apply its software/path policy before sending the request. An allowed program may itself interpret its own arguments; the helper does not build an extra shell layer.

observe {}
  Captures the actual X display using FFmpeg x11grab and returns {png,width:1280,height:800,windowTitle?}. PNG bytes are RGB24, signature/IHDR dimensions are checked, and the binary limit is 5 MiB so base64 plus JSON remains below 8 MiB. Capture timeout is six seconds. The active title is read separately through xdotool with a one-second timeout and invalid UTF-8 replaced. Title absence is allowed when no window is active. No synthetic or placeholder screenshot is returned as a successful observation.

click {x,y,button?}
  x and y are integer screen coordinates in 0..1279 and 0..799. button is left/middle/right or 1/2/3 and defaults to left. Moves the pointer then injects the click. Returns {performed:true}.

drag {x,y,toX,toY,button?}
  Validates both endpoints before touching the mouse, holds the chosen button, moves through 16 interpolated steps spaced 15 ms apart, then releases. A failed drag attempts to release mouse buttons before reporting failure. Returns {performed:true}.

scroll {x,y,amount}
  Moves to the supplied coordinate and injects at most 50 wheel notches. amount is an integer -50..50; positive scrolls down, negative up, zero only positions the pointer. Returns {performed:true}.

type {text}
  Accepts valid UTF-8 text up to 64 KiB with no NUL. An independent foreground xclip process owns the private X clipboard as UTF8_STRING. The helper writes through a bounded pipe, confirms the selection by reading it with a separate bounded xclip call, allows a cancellable 250 ms for applications to process the asynchronous XFixes owner/format notification, then injects Ctrl+V. This settling period prevents the first paste in a fresh Chrome window from reading stale clipboard availability. The clipboard owner remains alive until replaced or the session closes, allowing asynchronous application paste requests. Returns {typedBytes:UTF8_byte_count}. Empty text is a no-op. Clipboard setup/readback has bounded two-second stages; key injection has a two-second timeout. This intentionally replaces this private desktop's clipboard. It does not modify a Windows or another Bot's clipboard.

press {key}
  Accepts one validated key/chord, for example Return, Tab, Escape, BackSpace, Delete, Home, End, ArrowLeft/Left, PageUp/Page_Up, F1..F24, one ASCII letter/digit, or ctrl+shift+a. Modifiers ctrl/control, alt, shift, super/meta/win are recognized without duplicates. Enter/Esc/Backspace/Space/Arrow*/PageUp/PageDown have aliases. Named punctuation includes minus/equal/plus/comma/period/slash/backslash/semicolon/apostrophe/bracketleft/bracketright/grave. Arbitrary text belongs in type. Key names containing shell fragments or unknown tokens are rejected. Returns {pressed:true}.

preview {enabled:true|false}
  Enabling starts a separate FFmpeg x11grab -> MJPEG/image2pipe process and thread at a target of 30 fps. The operation waits up to five seconds for the first real JPEG before returning {enabled:true,previewFps:30}. Frames have monotonically increasing sequence numbers across toggles and a 2 MiB binary limit. A five-second missing-frame watchdog stops an unhealthy encoder. Disabling joins the thread and stops its process before replying, so no later frame follows the disabled response. It leaves the desktop and launched applications alive. Preview is initially disabled. There is no continuously running encoder when preview is disabled.

shutdown {}
  Returns {shuttingDown:true}, then ends the session and closes self-created programs. Closing stdin also cancels the session without requiring a shutdown request.

Input/action semantics and lifetime

Requests execute on one action thread in input order; preview encoding runs independently. The input-reader thread notices EOF even while an action, capture or encoder is active and raises cancellation. Mouse commands have a three-second timeout; ordinary key commands two seconds; exec confirmation two seconds. Startup waits at most eight seconds for Xvfb. A queue holds at most 64 requests and 1 MiB combined; overload is a static error with null id. No unbounded child wait is used.

A successful input action means the X events were injected. It does not prove that an application has completed focus changes, rendering, downloads or navigation. Use a subsequent observation and state check. Chrome initially loading from a fresh profile can take substantially longer than helper readiness. The native non-fast-input observation round trip also gives applications time to settle after a click. Do not infer task completion solely from an input acknowledgment.

Each spawned program starts a new process group and receives a parent-death signal. The helper is a Linux child subreaper and reaps completed background launch processes between requests, so a long-lived Bot does not accumulate zombies from short programs. On shutdown it stops preview, joins the reader, sends TERM to its tracked groups and /proc-discovered descendants, then KILL after a short bounded grace period and reaps adopted children. This includes descendants that called setsid and left the initial process group. The caller's bubblewrap PID namespace and Windows process supervision remain the outer cleanup boundary for abrupt host termination. This helper never deliberately signals unrelated host processes.

Chrome integration

A typical caller-supplied launch uses /usr/bin/google-chrome with an explicit private --user-data-dir=/home/bot/chrome, --no-first-run, --no-default-browser-check, --disable-dev-shm-usage and --no-sandbox when Chromium's inner sandbox cannot run in the already isolated namespace. The no-sandbox flag disables Chromium's own sandbox; the outer namespace remains the parent's responsibility and must actually exist. Chrome may display its own flag notice and window decorations, so real input coordinates should come from observed screenshots rather than assumed page coordinates.

Build and validation

Compile on Linux/WSL with g++13 and no X11/FFmpeg development headers or extra linked libraries:
  g++ -std=c++20 -O2 -Wall -Wextra -Wpedantic -pthread \
      -I <absolute-project>/include \
      <absolute-project>/linux/desktop_main.cpp <absolute-project>/src/json.cpp \
      -o <absolute-project>/outputs/linux/dimension-desktop-helper


tests/linux-desktop.test.mjs runs the helper in original synthetic bubblewrap fixtures with the parent's selected /etc mounts, uid/gid 1000, cap-drop ALL and clearenv. It launches the installed generic Chrome against local fixture pages and verifies PNG bytes/dimensions, UTF-8 Chinese/emoji paste, keyboard modifiers, mouse click/drag/scroll, request validation, actual JPEG sequences and measured frame rate, preview shutdown, two simultaneous private :99 displays, reaping short launch processes, and EOF cleanup of a detached heartbeat child. A separate concurrent test enables --share-net for two desktops, loads distinct pages through a real WSL loopback HTTP server, checks independent text input and screenshots, runs both preview encoders, and confirms one desktop survives the other's shutdown. An outer synthetic supervisor samples /proc every 20 ms, tracks descendants by (PID,starttime), retains them across reparenting/setsid, and also tracks members of their private PID namespaces. It checks all retained identities after exit, including Xvfb, Chrome, FFmpeg and detached children; it does not rely on a fixture path appearing in argv or print unrelated host process data. It also exports startDesktop(root,binary,{shareNetwork}) for integration tests. Current report and visual artifacts are under outputs/phase3-desktop; no real account, old application backend or external website is used.

Run from the project directory with the configured Node test runtime:
  node tests/linux-desktop.test.mjs [absolute-output-directory] [absolute-helper-binary]
On Windows the harness calls wsl.exe -d dimension-sandbox; DIMENSION_WSL_DISTRO can select another explicitly prepared distribution.
