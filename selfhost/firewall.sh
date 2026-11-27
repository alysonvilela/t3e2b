#!/usr/bin/env bash
# Block E2B internal ports from the LAN. Keeps 3000 api, 3001 dashboard, 3002 sandbox proxy.
# Loopback, pod (cni0) and sandbox (e2b-*) interfaces are untouched.
#   sudo IF=<lan interface> bash selfhost/firewall.sh   # apply now + install a boot-time unit (default: the default-route interface)
set -euo pipefail
IF=${IF:-$(ip route show default | awk '{print $5; exit}')}; PORTS=3003,5007,5008,5009,5010,5016,5017,5018,5109
iptables  -C INPUT -i "$IF" -p tcp -m multiport --dports $PORTS -j DROP 2>/dev/null || iptables  -I INPUT -i "$IF" -p tcp -m multiport --dports $PORTS -j DROP
ip6tables -C INPUT -i "$IF" -p tcp -m multiport --dports $PORTS -j DROP 2>/dev/null || ip6tables -I INPUT -i "$IF" -p tcp -m multiport --dports $PORTS -j DROP
if [ ! -f /etc/systemd/system/e2b-firewall.service ]; then
  install -m 755 "$0" /usr/local/sbin/e2b-firewall.sh
  cat > /etc/systemd/system/e2b-firewall.service <<UNIT
[Unit]
Description=Block E2B internal ports on $IF
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/e2b-firewall.sh
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload && systemctl enable e2b-firewall.service
fi
echo "OK: blocked $PORTS on $IF"
