#!/usr/bin/env bash
# Sets up a Raspberry Pi (Raspberry Pi OS with desktop, labwc) as the lobby TV. Run it on the Pi, as yourself,
# with your site's address (the one `npm run deploy` printed):
#   wget -O pi-setup.sh https://<your-site>/pi-setup.sh
#   bash pi-setup.sh https://<your-site>
# Safe to run again.
set -euo pipefail

SITE="${1:-}"
[ -n "$SITE" ] || { echo "Usage: bash pi-setup.sh https://<your-site>   (the address npm run deploy printed)"; exit 1; }
URL="${SITE%/}/tv"
[ "$(id -u)" != 0 ] || { echo "Run this as yourself, without sudo."; exit 1; }
echo "==> Setting up the lobby TV for $URL (your password may be asked for once)"

BROWSER=$(command -v chromium || command -v chromium-browser || true)
[ -n "$BROWSER" ] || { echo "Chromium isn't installed. Run: sudo apt install chromium"; exit 1; }

# Open the temple full screen when the desktop starts. --kiosk rather than --start-fullscreen: on the Pi's labwc
# desktop, --start-fullscreen left the page in a half-size box. (For the wifi splash page: Alt+F4 closes it.)
# --password-store=basic stops the "unlock your keyring" prompt that automatic login would otherwise cause.
# --disable-gpu-rasterization: the Pi 4's graphics chip chokes on lots of moving shapes; measured on a Pi 4, letting
# the processor draw them took a big batch from ~13fps to ~30fps (the graphics chip still composites the screen).
AUTOSTART=~/.config/labwc/autostart
mkdir -p "$(dirname "$AUTOSTART")"
# A personal autostart file replaces the system one, so start from a copy of it to keep the taskbar and desktop.
[ -f "$AUTOSTART" ] || cp /etc/xdg/labwc/autostart "$AUTOSTART" 2>/dev/null || touch "$AUTOSTART"
sed -i '/# fill-the-temple/d' "$AUTOSTART"
# On labwc, screen blanking is a swayidle line in this file (it's how raspi-config turns it on), so drop it.
sed -i '/swayidle/d' "$AUTOSTART"
echo "==> Screen blanking: off"
echo "$BROWSER --kiosk --disable-gpu-rasterization --no-first-run --noerrdialogs --password-store=basic --disable-session-crashed-bubble '$URL' & # fill-the-temple" >> "$AUTOSTART"
echo "==> Startup: $(basename "$BROWSER") opens the temple full screen at login"

# 1080p at 60Hz on either HDMI port. TVs and monitors often default to 4K at 30Hz, which is far too much for a Pi.
KANSHI=~/.config/kanshi/config
mkdir -p "$(dirname "$KANSHI")"
if [ -s "$KANSHI" ] && ! grep -q "fill-the-temple" "$KANSHI"; then
  echo "==> Screen: you already have display settings, leaving them (set 1920x1080 in Screen Configuration)"
else
  cat > "$KANSHI" <<'EOF'
# fill-the-temple: 1080p at 60Hz on whichever HDMI port is used
profile {
	output HDMI-A-1 enable mode 1920x1080@60Hz position 0,0 transform normal scale 1.0
}
profile {
	output HDMI-A-2 enable mode 1920x1080@60Hz position 0,0 transform normal scale 1.0
}
EOF
  echo "==> Screen: 1920x1080 at 60Hz (applies at next login)"
fi

# The Pi's wifi chip saves power by dozing, which is a well-known cause of dropped connections.
# This one needs sudo; over a non-interactive ssh session without passwordless sudo, it's skipped.
if sudo -n true 2>/dev/null || [ -t 0 ]; then
  printf '[connection]\nwifi.powersave = 2\n' | sudo install -D -m 644 /dev/stdin /etc/NetworkManager/conf.d/temple-wifi-powersave.conf
  echo "==> Wifi power saving: off (takes effect after a reboot)"
else
  echo "==> Wifi power saving: SKIPPED (needs your password; run this script again on the Pi itself)"
fi

if grep -qs "^autologin-user=$USER" /etc/lightdm/lightdm.conf && [ "$(systemctl get-default)" = graphical.target ]; then
  echo "==> Auto login to the desktop: already on"
else
  echo "==> Auto login to the desktop: OFF. Turn it on: Control Centre > System, or sudo raspi-config > System > Boot"
fi

echo
echo "==> Done. Reboot (sudo reboot) and the temple should open by itself."
