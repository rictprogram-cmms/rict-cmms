#!/usr/bin/env bash
# ============================================================================
# RICT CMMS — Raspberry Pi kiosk installer
# ============================================================================
# Turns a fresh Raspberry Pi OS **Lite** install into a self-healing,
# full-screen display for one CMMS page (default: the TV Display).
#
#   sudo bash setup-kiosk.sh                       # TV Display, defaults
#   sudo bash setup-kiosk.sh --url https://rict-cmms.vercel.app/lab-status
#   sudo bash setup-kiosk.sh --resolution 1280x720 --protect-sd
#
# What it sets up (and why — the old "digital signage" setups kept crashing):
#   • Bare X + Chromium, no desktop. Less RAM used, nothing to pop up dialogs.
#   • Chromium runs in a restart loop: if the browser dies, it is back in ~3 s.
#   • A watchdog service checks the page every 30 s through Chromium's local
#     debugging port. A frozen tab, "Aw, Snap!", a "no internet" error page or
#     a blank page is reloaded; if the browser stops answering it is restarted;
#     if memory runs low the browser is restarted before the Pi locks up.
#   • The Pi's hardware watchdog is turned on, so a full lock-up reboots it.
#   • A nightly reboot (default 03:30) clears any slow leaks.
#   • Screen blanking, the mouse cursor, "Restore pages?" bubbles, translate
#     bars and update nags are all turned off.
#   • The TV is forced to 1080p by default. A 4K TV otherwise makes the Pi
#     render 4K, which is a common cause of slow-downs and crashes.
#   • Optional --protect-sd makes the SD card read-only (power cuts can no
#     longer corrupt it — the other common cause of "it died again").
#
#   • Every minute the Pi checks in with the CMMS (Settings → TV Displays):
#     online/offline, page health, temperature, power warnings, memory. From
#     there an instructor can restart the browser or reboot the Pi remotely.
#     Needs the kiosk token from the CMMS (--kiosk-token); without it the
#     kiosk still works, it just doesn't report in.
#
# Re-running the script is safe; it overwrites its own files and keeps the
# kiosk token and CMMS key from the last run.
# Settings live in /etc/rict-kiosk.conf — edit and reboot to change them.
# Helper commands installed: kiosk-status, kiosk-restart
# ============================================================================
set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────
URL="https://rict-cmms.vercel.app/tv-display"
KIOSK_USER="${SUDO_USER:-}"
RESOLUTION="1920x1080"     # "" = leave whatever the TV reports
ROTATE="normal"            # normal | left | right | inverted
REBOOT_TIME="03:30"        # "" = no nightly reboot
PROTECT_SD="no"
KIOSK_VERSION="2026.11.24"
SUPABASE_URL="https://jzzfgafwyxabafaqrnho.supabase.co"
SUPABASE_ANON_KEY=""       # public key; read from the live CMMS site if not given
KIOSK_TOKEN=""             # from the CMMS migration output; kept between re-runs
NO_REBOOT="no"

usage() {
  sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --url URL             Page to show (default: TV Display)
  --user NAME           Account that runs the kiosk (default: the sudo user)
  --resolution WxH      Force this screen mode, or "auto" to leave it alone
                        (default 1920x1080)
  --rotate DIR          normal | left | right | inverted (default normal)
  --reboot-time HH:MM   Nightly reboot time, or "off" (default 03:30)
  --protect-sd          Make the SD card read-only after setup (overlay FS)
  --kiosk-token TOKEN   CMMS kiosk token, so the Pi shows in Settings → TV Displays
  --anon-key KEY        CMMS public (anon) key (normally found automatically)
  --no-reboot           Apply an update without rebooting (restarts the screen instead)
  -h, --help            Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url)          URL="$2"; shift 2 ;;
    --user)         KIOSK_USER="$2"; shift 2 ;;
    --resolution)   RESOLUTION="$2"; [ "$RESOLUTION" = auto ] && RESOLUTION=""; shift 2 ;;
    --rotate)       ROTATE="$2"; shift 2 ;;
    --reboot-time)  REBOOT_TIME="$2"; [ "$REBOOT_TIME" = off ] && REBOOT_TIME=""; shift 2 ;;
    --protect-sd)   PROTECT_SD="yes"; shift ;;
    --kiosk-token)  KIOSK_TOKEN="$2"; shift 2 ;;
    --anon-key)     SUPABASE_ANON_KEY="$2"; shift 2 ;;
    --no-reboot)    NO_REBOOT="yes"; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

# ── Sanity checks ───────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "Run with sudo:  sudo bash $0"
[ -n "$KIOSK_USER" ] || die "Could not tell which user to run the kiosk as. Use --user NAME."
id "$KIOSK_USER" >/dev/null 2>&1 || die "User '$KIOSK_USER' does not exist."
[ "$KIOSK_USER" != root ] || die "Don't run the kiosk as root. Use --user NAME."
case "$ROTATE" in normal|left|right|inverted) ;; *) die "--rotate must be normal, left, right or inverted" ;; esac
if [ -n "$REBOOT_TIME" ] && ! [[ "$REBOOT_TIME" =~ ^[0-2][0-9]:[0-5][0-9]$ ]]; then
  die "--reboot-time must look like 03:30 (or 'off')"
fi
if [ -n "$RESOLUTION" ] && ! [[ "$RESOLUTION" =~ ^[0-9]+x[0-9]+$ ]]; then
  die "--resolution must look like 1920x1080 (or 'auto')"
fi
command -v raspi-config >/dev/null || die "raspi-config not found — this script is for Raspberry Pi OS."

KIOSK_HOME="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"
if dpkg -s lightdm >/dev/null 2>&1; then
  warn "A desktop (lightdm) is installed. Raspberry Pi OS Lite is recommended;"
  warn "this script will switch the Pi to boot to console so the desktop no longer starts."
fi

MODEL="$(tr -d '\0' </proc/device-tree/model 2>/dev/null || echo unknown)"
MEM_MB="$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"
say "Setting up kiosk on: $MODEL (${MEM_MB} MB RAM) for user '$KIOSK_USER'"
echo "    Page: $URL"
[ "$MEM_MB" -lt 1500 ] && warn "Under 2 GB RAM. This works, but a Pi 4 (2 GB+) or Pi 5 is much steadier for this page."

# ── Packages ────────────────────────────────────────────────────────────────
say "Installing packages (this takes a few minutes)"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y full-upgrade
apt-get install -y --no-install-recommends \
  xserver-xorg xserver-xorg-legacy x11-xserver-utils xinit \
  fonts-noto-color-emoji fonts-dejavu-core \
  python3 python3-websocket curl ca-certificates
# Package name differs between Raspberry Pi OS releases.
apt-get install -y chromium-browser 2>/dev/null || apt-get install -y chromium
CHROME_BIN="$(command -v chromium-browser || command -v chromium || true)"
[ -n "$CHROME_BIN" ] || die "Chromium did not install."
echo "    Chromium: $CHROME_BIN ($("$CHROME_BIN" --version 2>/dev/null || echo '?'))"

usermod -aG video,render,input,tty "$KIOSK_USER" 2>/dev/null || usermod -aG video,input,tty "$KIOSK_USER"

# ── CMMS check-in settings ──────────────────────────────────────────────────
# Keep the token / key from an earlier run unless new ones were given.
if [ -f /etc/rict-kiosk.conf ]; then
  OLD_TOKEN="$(sed -n 's/^KIOSK_TOKEN="\(.*\)"$/\1/p' /etc/rict-kiosk.conf | head -1)"
  OLD_KEY="$(sed -n 's/^SUPABASE_ANON_KEY="\(.*\)"$/\1/p' /etc/rict-kiosk.conf | head -1)"
  [ -z "$KIOSK_TOKEN" ] && KIOSK_TOKEN="$OLD_TOKEN"
  [ -z "$SUPABASE_ANON_KEY" ] && SUPABASE_ANON_KEY="$OLD_KEY"
fi
if [ -z "$SUPABASE_ANON_KEY" ]; then
  # The public key ships inside the CMMS web app; read it from the live site.
  SITE="$(echo "$URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
  JS="$(curl -fsSL --max-time 20 "$SITE/" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1 || true)"
  [ -n "$JS" ] && SUPABASE_ANON_KEY="$(curl -fsSL --max-time 60 "$SITE$JS" \
      | grep -oE 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}' | head -1 || true)"
fi
if [ -n "$KIOSK_TOKEN" ] && [ -n "$SUPABASE_ANON_KEY" ]; then
  echo "    CMMS check-in: on (every minute)"
else
  warn "CMMS check-in is OFF (no kiosk token). Re-run with --kiosk-token to show this Pi in Settings."
fi

# ── Config file ─────────────────────────────────────────────────────────────
say "Writing /etc/rict-kiosk.conf"
cat >/etc/rict-kiosk.conf <<EOF
# RICT CMMS kiosk settings. Edit, then reboot (or run: kiosk-restart).
URL="$URL"
CHROME_BIN="$CHROME_BIN"
# Screen mode to force, e.g. 1920x1080 or 1280x720. Empty = TV's default.
RESOLUTION="$RESOLUTION"
# normal | left | right | inverted
ROTATE="$ROTATE"
# Restart the browser if free memory drops below this many MB.
LOW_MEM_MB=120
# CMMS check-in (Settings → TV Displays). Blank token = no check-in.
DEVICE_NAME="$(hostname)"
SUPABASE_URL="$SUPABASE_URL"
SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY"
KIOSK_TOKEN="$KIOSK_TOKEN"
KIOSK_VERSION="$KIOSK_VERSION"
EOF
# Holds the kiosk token: readable by root and the kiosk user only
chown root:"$KIOSK_USER" /etc/rict-kiosk.conf
chmod 640 /etc/rict-kiosk.conf

# Let the watchdog reboot the Pi when an instructor asks (nothing else)
SYSTEMCTL_BIN="$(command -v systemctl)"
echo "$KIOSK_USER ALL=(root) NOPASSWD: $SYSTEMCTL_BIN reboot" >/etc/sudoers.d/rict-kiosk-reboot
chmod 440 /etc/sudoers.d/rict-kiosk-reboot
visudo -cf /etc/sudoers.d/rict-kiosk-reboot >/dev/null || { rm -f /etc/sudoers.d/rict-kiosk-reboot; warn "Could not add the remote-reboot rule; remote reboot will not work."; }

mkdir -p /opt/rict-kiosk

# ── X session: screen setup + Chromium restart loop ─────────────────────────
say "Writing the kiosk session"
cat >/opt/rict-kiosk/xinitrc <<'EOF'
#!/bin/bash
# Started by startx on tty1. Runs Chromium forever; if it exits, start it again.
. /etc/rict-kiosk.conf
PROFILE="$HOME/.config/rict-kiosk-chromium"
LOG="/tmp/rict-kiosk-chromium.log"

# Never blank or power-save the screen
xset s off; xset s noblank; xset -dpms
xsetroot -solid black 2>/dev/null || true

OUT="$(xrandr --query | awk '/ connected/{print $1; exit}')"
if [ -n "$OUT" ]; then
  if [ -n "$RESOLUTION" ] && xrandr --query | grep -q "^ *$RESOLUTION "; then
    xrandr --output "$OUT" --mode "$RESOLUTION" || true
  fi
  [ "$ROTATE" != "normal" ] && xrandr --output "$OUT" --rotate "$ROTATE" || true
fi

# Some Pi 3 / Raspbian builds give the HDMI output an all-zero colour matrix
# (CTM): the TV reports a signal but the picture is solid black. It comes back
# whenever the TV is swapped, switched on late or changes input, so check every
# 10 s and put it back to normal. "--current" reads without re-probing the TV,
# so the check itself never makes the screen flicker.
# First fix at start-up isn't counted (these Pis always start that way).
for O in $(xrandr --current | awk '/ connected/{print $1}'); do
  xrandr --output "$O" --set CTM "1,0,0,0,1,0,0,0,1" 2>/dev/null || true
done
echo 0 > /tmp/rict-kiosk-screen-fixes
(
  while sleep 10; do
    for O in $(xrandr --current | awk '/ connected/{print $1}'); do
      if ! xrandr --current --prop | sed -n "/^$O /,/^[^ \t]/p" | grep -A1 'CTM:' | grep -q 'CTM:[[:space:]]*1\.0'; then
        xrandr --output "$O" --set CTM "1,0,0,0,1,0,0,0,1" 2>/dev/null || true
        # count it, so Settings → TV Displays can show how often this happens
        N="$(cat /tmp/rict-kiosk-screen-fixes 2>/dev/null || echo 0)"
        echo $(( N + 1 )) > /tmp/rict-kiosk-screen-fixes
      fi
    done
  done
) &
# There's no desktop/window manager, so tell Chromium the exact screen size
# (otherwise it can open at half width). "current W x H" accounts for rotation.
SCREEN="$(xrandr --query | sed -n 's/.*current \([0-9]*\) x \([0-9]*\).*/\1,\2/p' | head -1)"
[ -n "$SCREEN" ] || SCREEN="1920,1080"

# Wait (up to 2 min) for the network so the first load isn't an error page.
# The watchdog fixes it anyway if it is.
HOST="$(echo "$URL" | sed -E 's#^[a-z]+://([^/]+).*#\1#')"
for _ in $(seq 1 60); do
  curl -s -o /dev/null --max-time 3 "https://$HOST" && break
  sleep 2
done

while true; do
  mkdir -p "$PROFILE/Default"
  # Mark the last run as a clean exit so Chromium never shows "Restore pages?"
  PREFS="$PROFILE/Default/Preferences"
  if [ -f "$PREFS" ]; then
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' "$PREFS"
  fi
  # Start each run with an empty cache (keeps the SD card from filling up)
  rm -rf "$PROFILE/Default/Cache" "$PROFILE/Default/Code Cache" "$PROFILE/Default/GPUCache" 2>/dev/null
  # Keep the log small
  [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 2000000 ] && : >"$LOG"

  echo "=== $(date '+%F %T') starting Chromium ===" >>"$LOG"
  "$CHROME_BIN" \
    --kiosk "$URL" \
    --window-position=0,0 --window-size="$SCREEN" --start-fullscreen \
    --user-data-dir="$PROFILE" \
    --no-first-run --noerrdialogs --disable-infobars \
    --disable-session-crashed-bubble --disable-restore-session-state \
    --disable-features=Translate,TranslateUI,MediaRouter,InfiniteSessionRestore \
    --disable-component-update --check-for-update-interval=31536000 \
    --simulate-outdated-no-au='Tue, 31 Dec 2099 23:59:59 GMT' \
    --overscroll-history-navigation=0 --disable-pinch --hide-scrollbars \
    --password-store=basic --autoplay-policy=no-user-gesture-required \
    --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
    --remote-allow-origins=http://127.0.0.1:9222 \
    >>"$LOG" 2>&1
  echo "=== $(date '+%F %T') Chromium exited ($?) — restarting in 3 s ===" >>"$LOG"
  sleep 3
done
EOF
chmod 755 /opt/rict-kiosk/xinitrc

# ── Watchdog ────────────────────────────────────────────────────────────────
say "Writing the page watchdog"
cat >/opt/rict-kiosk/watchdog.py <<'EOF'
#!/usr/bin/env python3
"""RICT kiosk watchdog.

Every 30 s it asks Chromium (via the local debugging port) what the page is
doing. It fixes, in order of escalation:
  * error page / wrong page / blank page  -> navigate back to the kiosk URL
  * page not answering (frozen, crashed)  -> reload; 3 misses in a row -> restart Chromium
  * debugging port gone for 3 minutes     -> restart Chromium
  * free memory below LOW_MEM_MB twice    -> restart Chromium
Restarting Chromium = killing it; the session loop starts it again in ~3 s.

Every 60 s it also checks in with the CMMS (Settings -> TV Displays) and
carries out a remote command if an instructor queued one:
  restart_browser | reboot
"""
import json, os, re, socket, subprocess, sys, time, urllib.request

try:
    import websocket  # python3-websocket
except ImportError:
    print("python3-websocket missing", flush=True); sys.exit(1)

def load_conf():
    conf = {}
    with open("/etc/rict-kiosk.conf") as f:
        for line in f:
            m = re.match(r'^\s*([A-Z_]+)="?(.*?)"?\s*$', line)
            if m: conf[m.group(1)] = m.group(2)
    return conf

CONF = load_conf()
URL = CONF.get("URL", "")
LOW_MEM_MB = int(CONF.get("LOW_MEM_MB", "120") or 120)
DEVICE = CONF.get("DEVICE_NAME") or socket.gethostname()
SB_URL = CONF.get("SUPABASE_URL", "").rstrip("/")
SB_KEY = CONF.get("SUPABASE_ANON_KEY", "")
TOKEN = CONF.get("KIOSK_TOKEN", "")
VERSION = CONF.get("KIOSK_VERSION", "")
DEVTOOLS = "http://127.0.0.1:9222"
INTERVAL = 30
CHECKIN_EVERY = 60
STARTUP_GRACE = 120
PROFILE_MARK = "rict-kiosk-chromium"
CHROME_LOG = "/tmp/rict-kiosk-chromium.log"
SCREEN_FIXES = "/tmp/rict-kiosk-screen-fixes"

page_state = "starting"
last_checkin = 0.0
checkin_ok = None

def log(msg): print(time.strftime("%F %T"), msg, flush=True)

def mem_available_mb():
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    return 99999

def restart_chromium(reason):
    global page_state
    log(f"RESTART Chromium: {reason}")
    page_state = "starting"
    subprocess.run(["pkill", "-f", PROFILE_MARK])
    time.sleep(5)
    subprocess.run(["pkill", "-9", "-f", PROFILE_MARK])

def page_target():
    with urllib.request.urlopen(DEVTOOLS + "/json", timeout=5) as r:
        targets = json.load(r)
    pages = [t for t in targets if t.get("type") == "page"]
    return pages[0] if pages else None

def cdp(ws_url, method, params=None, timeout=10):
    ws = websocket.create_connection(ws_url, timeout=timeout, suppress_origin=True)
    try:
        ws.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = json.loads(ws.recv())
            if msg.get("id") == 1:
                return msg
        raise TimeoutError(method)
    finally:
        ws.close()

PROBE = """JSON.stringify({
  href: location.href,
  ready: document.readyState,
  kids: (document.getElementById('root') || document.body || {childElementCount:0}).childElementCount
})"""

# ── Health facts for the CMMS check-in ──────────────────────────────────────
def _read(path, default=""):
    try:
        with open(path) as f: return f.read().strip()
    except Exception: return default

def _run(cmd):
    try: return subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception: return ""

def health():
    d = {"page_url": URL, "page_state": page_state, "script_version": VERSION}
    d["model"] = _read("/proc/device-tree/model").replace("\x00", "")[:80]
    d["ip_address"] = _run(["hostname", "-I"]).split(" ")[0] if _run(["hostname", "-I"]) else ""
    try: d["uptime_sec"] = int(float(_read("/proc/uptime", "0").split()[0]))
    except Exception: pass
    d["mem_free_mb"] = mem_available_mb()
    pid = _run(["pgrep", "-o", "-f", PROFILE_MARK])
    if pid:
        et = _run(["ps", "-o", "etimes=", "-p", pid.split()[0]])
        if et.isdigit(): d["browser_uptime_sec"] = int(et)
    log_text = _read(CHROME_LOG)
    d["browser_restarts"] = log_text.count("Chromium exited")
    fixes = _read(SCREEN_FIXES, "0")
    d["screen_fixes"] = int(fixes) if fixes.isdigit() else 0
    t = _run(["vcgencmd", "measure_temp"])
    m = re.search(r"([\d.]+)", t)
    if m: d["cpu_temp_c"] = float(m.group(1))
    th = _run(["vcgencmd", "get_throttled"]).split("=")[-1]
    if th.startswith("0x"):
        v = int(th, 16)
        d["throttled"] = th
        d["undervolt_now"] = bool(v & 0x1)
        d["undervolt_since_boot"] = bool(v & 0x10000)
        d["hot_now"] = bool(v & 0xC)   # throttled or soft temperature limit
    return d

def checkin():
    """Send health to the CMMS; carry out a queued command. Never raises."""
    global last_checkin, checkin_ok
    last_checkin = time.time()
    if not (SB_URL and SB_KEY and TOKEN):
        return
    body = json.dumps({"p_token": TOKEN, "p_device": DEVICE, "p_data": health()}).encode()
    headers = {"Content-Type": "application/json", "apikey": SB_KEY}
    if SB_KEY.startswith("eyJ"):
        headers["Authorization"] = "Bearer " + SB_KEY
    try:
        req = urllib.request.Request(SB_URL + "/rest/v1/rpc/kiosk_heartbeat", data=body,
                                     headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=15) as r:
            res = json.load(r)
        if checkin_ok is not True: log("CMMS check-in OK")
        checkin_ok = True
    except Exception as e:
        if checkin_ok is not False: log(f"CMMS check-in failed: {e!r}")
        checkin_ok = False
        return
    cmd = (res or {}).get("command")
    if cmd == "restart_browser":
        restart_chromium("requested from the CMMS")
    elif cmd == "reboot":
        log("REBOOT requested from the CMMS")
        subprocess.run(["sudo", "-n", "systemctl", "reboot"])

def nap(seconds):
    """Sleep, but keep checking in every minute (even during grace periods)."""
    end = time.time() + seconds
    while True:
        if time.time() - last_checkin >= CHECKIN_EVERY:
            checkin()
        left = end - time.time()
        if left <= 0: return
        time.sleep(min(left, 5))

def main():
    global page_state
    log(f"watchdog started for {URL} as '{DEVICE}'"
        + ("" if TOKEN else " (CMMS check-in off: no kiosk token)"))
    nap(STARTUP_GRACE)
    no_port = 0; no_answer = 0; blank = 0; low_mem = 0
    while True:
        try:
            # Memory guard
            avail = mem_available_mb()
            low_mem = low_mem + 1 if avail < LOW_MEM_MB else 0
            if low_mem >= 2:
                restart_chromium(f"low memory ({avail} MB free)")
                low_mem = 0; nap(STARTUP_GRACE); continue

            # Is Chromium's debugging port up?
            try:
                target = page_target()
                no_port = 0
            except Exception:
                no_port += 1
                page_state = "not_answering"
                if no_port >= 6:   # ~3 minutes
                    restart_chromium("debugging port not answering")
                    no_port = 0; nap(STARTUP_GRACE)
                nap(INTERVAL); continue
            if not target:
                restart_chromium("no page open"); nap(STARTUP_GRACE); continue
            ws_url = target["webSocketDebuggerUrl"]

            # Ask the page what it's doing
            try:
                res = cdp(ws_url, "Runtime.evaluate", {"expression": PROBE, "returnByValue": True})
                state = json.loads(res["result"]["result"]["value"])
                no_answer = 0
            except Exception as e:
                no_answer += 1
                page_state = "not_answering"
                log(f"page not answering ({no_answer}/3): {e!r}")
                if no_answer >= 3:
                    restart_chromium("page frozen or crashed"); no_answer = 0
                    nap(STARTUP_GRACE)
                else:
                    try: cdp(ws_url, "Page.reload", {"ignoreCache": True})
                    except Exception: pass
                nap(INTERVAL); continue

            href = state.get("href", "")
            if href.startswith("chrome-error:") or not href.startswith(URL.split("?")[0].split("#")[0]):
                log(f"wrong/error page ({href}) -> navigating back")
                page_state = "error"
                cdp(ws_url, "Page.navigate", {"url": URL})
                blank = 0
            elif state.get("kids", 0) == 0:
                blank += 1
                page_state = "blank"
                if blank >= 4:   # blank for ~2 minutes
                    log("page blank for 2 min -> reload")
                    cdp(ws_url, "Page.reload", {"ignoreCache": True}); blank = 0
            else:
                blank = 0
                page_state = "ok"
        except Exception as e:
            log(f"watchdog error: {e!r}")
        nap(INTERVAL)

if __name__ == "__main__":
    main()
EOF
chmod 755 /opt/rict-kiosk/watchdog.py

cat >/etc/systemd/system/rict-kiosk-watchdog.service <<EOF
[Unit]
Description=RICT kiosk page watchdog
After=network-online.target

[Service]
User=$KIOSK_USER
ExecStart=/usr/bin/python3 /opt/rict-kiosk/watchdog.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# ── Helper commands ─────────────────────────────────────────────────────────
cat >/usr/local/bin/kiosk-restart <<'EOF'
#!/bin/bash
# Restart the kiosk browser (it comes back in a few seconds).
pkill -f rict-kiosk-chromium && echo "Chromium restarting..." || echo "Chromium was not running."
EOF
cat >/usr/local/bin/kiosk-status <<'EOF'
#!/bin/bash
. /etc/rict-kiosk.conf
echo "Page:        $URL"
PID="$(pgrep -o -f rict-kiosk-chromium || true)"
if [ -n "$PID" ]; then echo "Chromium:    running for $(ps -o etime= -p "$PID" | xargs)"; else echo "Chromium:    NOT running"; fi
echo "Watchdog:    $(systemctl is-active rict-kiosk-watchdog)"
if [ -n "$KIOSK_TOKEN" ]; then
  C="$(journalctl -u rict-kiosk-watchdog -o cat --no-pager 2>/dev/null | grep -E 'CMMS check-in' | tail -1)"
  echo "CMMS:        ${C:-check-in starting…}  (as '$DEVICE_NAME')"
else
  echo "CMMS:        check-in off (no kiosk token)"
fi
echo "Uptime:      $(uptime -p)"
echo "Memory free: $(awk '/MemAvailable/{print int($2/1024)" MB"}' /proc/meminfo)"
if command -v vcgencmd >/dev/null; then
  echo "CPU temp:    $(vcgencmd measure_temp | cut -d= -f2)"
  T="$(vcgencmd get_throttled | cut -d= -f2)"
  echo "Throttled:   $T"
  [ $(( T & 0x1 )) -ne 0 ]     && echo "  !! Under-voltage RIGHT NOW — use the official power supply"
  [ $(( T & 0x10000 )) -ne 0 ] && echo "  !! Under-voltage has happened since boot — a weak power supply crashes Pis"
  [ $(( T & 0x4 )) -ne 0 ]     && echo "  !! Throttling now (too hot?)"
fi
echo; echo "Last watchdog actions:"
journalctl -u rict-kiosk-watchdog -n 10 --no-pager -o cat 2>/dev/null | sed 's/^/  /'
N="$(grep -c 'Chromium exited' /tmp/rict-kiosk-chromium.log 2>/dev/null)"
echo; echo "Browser restarts since boot: ${N:-0}"
EOF
chmod 755 /usr/local/bin/kiosk-restart /usr/local/bin/kiosk-status

# ── Auto-login on tty1 and start X ──────────────────────────────────────────
say "Configuring auto-login and auto-start"
raspi-config nonint do_boot_behaviour B2     # console, auto-login
systemctl set-default multi-user.target >/dev/null

PROFILE_FILE="$KIOSK_HOME/.bash_profile"
touch "$PROFILE_FILE"
# Remove any earlier copy of our lines, then rebuild: load .profile first
# (a .bash_profile stops bash reading .profile), then the user's own lines,
# then the kiosk start block.
EXISTING="$(sed -e '/# >>> rict-kiosk >>>/,/# <<< rict-kiosk <<</d' "$PROFILE_FILE")"
{
  echo '# >>> rict-kiosk >>>'
  echo '[ -f ~/.profile ] && . ~/.profile'
  echo '# <<< rict-kiosk <<<'
  [ -n "$EXISTING" ] && printf '%s\n' "$EXISTING"
  cat <<'EOF'
# >>> rict-kiosk >>>
# Start the kiosk on the physical screen only (not over SSH).
# If X ever exits, this login ends and auto-login starts it again.
if [ -z "$DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
  exec startx /opt/rict-kiosk/xinitrc -- -nocursor -s 0 >/tmp/rict-kiosk-x.log 2>&1
fi
# <<< rict-kiosk <<<
EOF
} >"$PROFILE_FILE.new"
mv "$PROFILE_FILE.new" "$PROFILE_FILE"
chown "$KIOSK_USER:$KIOSK_USER" "$PROFILE_FILE"

# Allow the console user to start X
cat >/etc/X11/Xwrapper.config <<'EOF'
allowed_users=console
needs_root_rights=yes
EOF

# Pi 5 (and some Pi 4 setups): make X use the display chip, not the 3D-only one
mkdir -p /etc/X11/xorg.conf.d
cat >/etc/X11/xorg.conf.d/99-rict-vc4.conf <<'EOF'
Section "OutputClass"
  Identifier "vc4"
  MatchDriver "vc4"
  Driver "modesetting"
  Option "PrimaryGPU" "true"
EndSection
EOF
# On 1 GB Pis (Pi 3) turn off X's own GPU acceleration: it shares the small
# graphics memory pool with Chromium. Chromium still uses the GPU itself.
if [ "$MEM_MB" -lt 1500 ]; then
  sed -i 's/^EndSection/  Option "AccelMethod" "none"\nEndSection/' /etc/X11/xorg.conf.d/99-rict-vc4.conf
fi

# ── Boot options: no console blanking, quiet boot ───────────────────────────
CMDLINE=/boot/firmware/cmdline.txt; [ -f "$CMDLINE" ] || CMDLINE=/boot/cmdline.txt
if [ -f "$CMDLINE" ]; then
  grep -q 'consoleblank=0' "$CMDLINE" || sed -i '1 s/$/ consoleblank=0/' "$CMDLINE"
  # Force the HDMI mode at boot. The trailing "D" keeps the output on even if
  # the TV is switched off when the Pi starts (otherwise you can get no picture
  # until the Pi is rebooted with the TV on).
  sed -i -E '1 s/ ?video=HDMI-A-1:[^ ]*//' "$CMDLINE"
  if [ -n "$RESOLUTION" ]; then
    sed -i "1 s/\$/ video=HDMI-A-1:${RESOLUTION}@60D/" "$CMDLINE"
  fi
fi

# ── Hardware watchdog: reboot automatically if the Pi locks up ─────────────
say "Enabling the hardware watchdog"
mkdir -p /etc/systemd/system.conf.d
cat >/etc/systemd/system.conf.d/rict-watchdog.conf <<'EOF'
[Manager]
RuntimeWatchdogSec=15s
RebootWatchdogSec=2min
EOF

# ── Nightly reboot ──────────────────────────────────────────────────────────
if [ -n "$REBOOT_TIME" ]; then
  say "Scheduling a nightly reboot at $REBOOT_TIME"
  cat >/etc/systemd/system/rict-kiosk-reboot.service <<'EOF'
[Unit]
Description=RICT kiosk nightly reboot
[Service]
Type=oneshot
ExecStart=/bin/systemctl reboot
EOF
  cat >/etc/systemd/system/rict-kiosk-reboot.timer <<EOF
[Unit]
Description=RICT kiosk nightly reboot
[Timer]
OnCalendar=*-*-* $REBOOT_TIME:00
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable rict-kiosk-reboot.timer
else
  systemctl disable --now rict-kiosk-reboot.timer 2>/dev/null || true
fi

systemctl daemon-reload
systemctl enable rict-kiosk-watchdog.service

# Stop background apt jobs from running during class hours and eating RAM/CPU
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true

# ── Optional: read-only SD card ─────────────────────────────────────────────
if [ "$PROTECT_SD" = yes ]; then
  say "Turning on the read-only overlay (takes effect after reboot)"
  raspi-config nonint do_overlayfs 0
  warn "SD card is now read-only after reboot. To change settings later:"
  warn "  sudo raspi-config nonint do_overlayfs 1 && sudo reboot   (makes it writable)"
fi

# ── Power check ─────────────────────────────────────────────────────────────
if command -v vcgencmd >/dev/null; then
  T="$(vcgencmd get_throttled | cut -d= -f2)"
  if [ $(( T & 0x50000 )) -ne 0 ]; then
    warn "This Pi has seen UNDER-VOLTAGE since boot ($T). A weak power supply is a"
    warn "very common reason kiosks crash. Use the official Raspberry Pi supply."
  fi
fi

if [ "$NO_REBOOT" = yes ]; then
  say "Done. Restarting the kiosk screen and watchdog (no reboot)."
  systemctl restart rict-kiosk-watchdog
  systemctl restart getty@tty1
  echo "    Boot-time settings (resolution at boot, hardware watchdog) apply at the next reboot."
  echo "    Check with:  kiosk-status"
  exit 0
fi
say "Done. Rebooting in 10 seconds into kiosk mode (Ctrl+C to cancel)."
echo "    After reboot, over SSH:  kiosk-status   |   kiosk-restart"
sleep 10
reboot
