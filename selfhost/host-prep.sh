#!/usr/bin/env bash
# Run ON THE NODE with sudo, AFTER the VM has nested virtualization (/dev/kvm) and >= 12 GiB RAM.
#   sudo bash selfhost/host-prep.sh
set -euo pipefail
[ -e /dev/kvm ] || { echo "FIX: /dev/kvm missing - enable nested virt / CPU type 'host' on the hypervisor first"; exit 1; }
mem_gib=$(awk '/MemTotal/{print int($2/1048576)}' /proc/meminfo)
[ "$mem_gib" -ge 11 ] || { echo "FIX: only ${mem_gib} GiB RAM; E2B needs 12 GiB (4 GiB of it becomes hugepages)"; exit 1; }
apt-get update && apt-get install -y iptables rsync e2fsprogs iproute2
# Sandbox RAM comes from this pool: 2048 x 2 MiB = 4 GiB. A template build needs ~2x its memory.
echo 'vm.nr_hugepages=2048' > /etc/sysctl.d/90-e2b.conf
sysctl -p /etc/sysctl.d/90-e2b.conf
grep HugePages_Total /proc/meminfo   # less than 2048 = fragmented memory; reboot and re-run
systemctl restart k3s   # kubelet only advertises hugepages it saw at start
echo "OK. Now, as your user: bash selfhost/install.sh"
