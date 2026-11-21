# Raspberry Pi TV Display kiosk

Sets up a Raspberry Pi to boot straight into the CMMS **TV Display** page
(`https://rict-cmms.vercel.app/tv-display`), full screen, and keeps it on
screen without anyone touching it.

## Why this setup instead of a digital-signage image

Signage images (FullPageOS and similar) start the browser once and hope.
When Chromium runs out of memory, a tab crashes ("Aw, Snap!"), the Wi-Fi
drops at boot, or the Pi freezes, the screen stays broken until someone
pulls the plug. This setup adds several layers of recovery:

| Problem | What happens now |
|---|---|
| Browser crashes or closes | Restarted within ~3 seconds |
| Page freezes / "Aw, Snap!" | Watchdog reloads it; after 3 failed checks it restarts the browser |
| "No internet" error page, wrong page | Watchdog sends it back to the TV Display |
| Page stays blank for 2 minutes | Reloaded |
| Memory running out (slow leak) | Browser restarted before the Pi locks up |
| Whole Pi locks up | Hardware watchdog reboots it |
| Slow build-up over days | Nightly reboot at 3:30 am |
| 4K TV making the Pi struggle | Forced to 1080p |
| TV off when the Pi boots → no picture | HDMI forced on at boot |
| Power cut corrupts the SD card | Optional read-only SD card (`--protect-sd`) |
| Screen blanking, cursor, "Restore pages?" pop-ups | All turned off |

The TV Display page already reloads itself at midnight and when you press
**Reload TVs now** (Settings → General → TV Displays). Nothing about that
changes.

## What you need

- Raspberry Pi 4 (2 GB or more) or Pi 5. A Pi 3 works but is borderline for
  this page.
- **The official Raspberry Pi power supply.** Phone chargers and TV USB ports
  cause under-voltage, which is one of the most common reasons Pis crash.
- A good-quality microSD card (16 GB+, A1/A2 rated). Replace the cards from
  the failing Pis; they may already be worn out.
- Ethernet if possible. Wi-Fi works too.

## Step 1 — Flash the SD card

1. Install **Raspberry Pi Imager** on your PC.
2. Choose your Pi model, then **Raspberry Pi OS (other) → Raspberry Pi OS Lite (64-bit)**.
   Use *Lite* (no desktop).
3. Click **Edit settings** before writing:
   - Hostname: e.g. `rict-tv1`
   - Username / password: e.g. `kiosk` / (your choice)
   - Wi-Fi (if not using Ethernet), country **US**
   - Time zone: **America/Chicago** (the TV's midnight reload and the
     nightly reboot use this)
   - **Services → Enable SSH** (password authentication)
4. Write the card, put it in the Pi, connect the TV and network, power on.
   First boot takes a couple of minutes.

## Step 2 — Run the installer

From your PC, open a terminal (PowerShell works):

```
ssh kiosk@rict-tv1.local
```

Then on the Pi:

```
curl -fsSL https://raw.githubusercontent.com/rictprogram-cmms/rict-cmms/main/kiosk/raspberry-pi/setup-kiosk.sh -o setup-kiosk.sh
sudo bash setup-kiosk.sh
```

It installs everything (5–15 minutes) and reboots into the TV Display.

**No internet to GitHub?** Copy `setup-kiosk.sh` onto a USB stick, plug it
into the Pi, and run `sudo bash /media/.../setup-kiosk.sh` (or copy it over
with `scp setup-kiosk.sh kiosk@rict-tv1.local:`).

### Options

```
sudo bash setup-kiosk.sh --resolution 1280x720      # smoother on a Pi 3 / older TV
sudo bash setup-kiosk.sh --resolution auto          # don't force a resolution
sudo bash setup-kiosk.sh --rotate left              # portrait TV
sudo bash setup-kiosk.sh --reboot-time 05:00        # or --reboot-time off
sudo bash setup-kiosk.sh --protect-sd               # read-only SD card (recommended once it's working)
sudo bash setup-kiosk.sh --url https://rict-cmms.vercel.app/lab-status   # a different page
```

Running it again is safe; it replaces its own files.

## Day-to-day

Over SSH:

- `kiosk-status` — is the browser up, how long, memory, temperature,
  **under-voltage warnings**, and the watchdog's last actions.
- `kiosk-restart` — restart the browser.
- `sudo reboot` — restart the Pi.

To change the page or resolution later, edit `/etc/rict-kiosk.conf` and
reboot. (If you used `--protect-sd`, first run
`sudo raspi-config nonint do_overlayfs 1 && sudo reboot` to make the card
writable, make the change, then `sudo raspi-config nonint do_overlayfs 0 && sudo reboot`.)

## Troubleshooting

- **Black screen, no browser:** SSH in and check `/tmp/rict-kiosk-x.log` and
  `/tmp/rict-kiosk-chromium.log`.
- **Keeps restarting:** run `kiosk-status`. Under-voltage → replace the power
  supply. Low memory on a 1 GB Pi → try `--resolution 1280x720`.
- **Watchdog log:** `journalctl -u rict-kiosk-watchdog -n 50`

## Files the installer creates

| Path | Purpose |
|---|---|
| `/etc/rict-kiosk.conf` | Settings (URL, resolution, rotation) |
| `/opt/rict-kiosk/xinitrc` | Screen setup + Chromium restart loop |
| `/opt/rict-kiosk/watchdog.py` | Page health checks |
| `/etc/systemd/system/rict-kiosk-watchdog.service` | Runs the watchdog |
| `/etc/systemd/system/rict-kiosk-reboot.{service,timer}` | Nightly reboot |
| `/etc/systemd/system.conf.d/rict-watchdog.conf` | Hardware watchdog |
| `/etc/X11/xorg.conf.d/99-rict-vc4.conf` | Makes X use the right display chip (Pi 5) |
| `~/.bash_profile` (block marked `rict-kiosk`) | Starts the kiosk on auto-login |
| `/usr/local/bin/kiosk-status`, `kiosk-restart` | Helper commands |
