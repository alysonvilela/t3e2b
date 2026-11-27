# Self-hosted E2B on a single-node k3s

t3e2b works with E2B Cloud as is. This folder runs E2B yourself instead: the official
single-node Kubernetes package ([E2B "Embed"](https://github.com/e2b-dev/runtime/tree/main/embed/kubernetes))
as one StatefulSet `e2b/e2b-0` with the orchestrator (Firecracker), API, client-proxy, dashboard,
Postgres, Redis and ClickHouse. It uses hostNetwork and privileged containers.

Tested on a Proxmox VM (Ubuntu, k3s, 8 vCPU, 16 GB).

## 1. Hypervisor: give the VM KVM

E2B runs Firecracker, so the node needs `/dev/kvm`.

- Host: nested virtualization on (`cat /sys/module/kvm_intel/parameters/nested` shows `Y` or `1`;
  otherwise `options kvm_intel nested=1` in `/etc/modprobe.d/kvm.conf` and reload the module; `kvm_amd` on AMD).
- VM: CPU type `host` and at least 12 GiB RAM (16 recommended; 4 GiB of it becomes hugepages).
  - Proxmox, on the host: `qm set <vmid> --cpu host --memory 16384 --balloon 0`, then `qm shutdown <vmid> && qm start <vmid>`
    (a reboot from inside the VM does not apply the CPU change).
  - libvirt: `<cpu mode='host-passthrough'/>`, more memory, `virsh shutdown` + `virsh start`.
- Check inside the VM: `ls /dev/kvm` and `grep -c vmx /proc/cpuinfo` (> 0).

## 2. Install

```bash
sudo bash selfhost/host-prep.sh     # packages + 4 GiB hugepages + k3s restart
bash selfhost/install.sh            # ~3-5 min; writes selfhost/sdk.env (contains the API key: keep it private)
sudo bash selfhost/firewall.sh      # block the internal ports from the LAN (5008 is an unauthenticated control API)
```

`install.sh` also applies `limits-job.yaml`: 24 h max sandbox lifetime and 10 GB free disk per sandbox.
E2B keeps these limits in its own Postgres (tables `default_limits`, `project_limits`, `tiers`), not in env
vars; the Job rewrites them on every `kubectl apply -k selfhost`. Size the disk so that running sandboxes fit
in your root volume.

## 3. Use it

```bash
set -a; . selfhost/sdk.env; set +a     # E2B_API_KEY, E2B_API_URL (:3000), E2B_SANDBOX_URL (:3002)
bunx t3e2b template t3                 # build the template t3e2b uses (5-15 min)
bunx t3e2b doctor
```

| Port | What |
| - | - |
| 3000 | API (`E2B_API_URL`) |
| 3001 | Dashboard: lists sandboxes, terminal, files. It can't create sandboxes; the SDK does. |
| 3002 | Sandbox proxy (`E2B_SANDBOX_URL`). `http://<port>-<sandboxId>.<node-ip>.sslip.io:3002` reaches a port inside a sandbox. |

From another machine (LAN or Tailscale), set the same three variables with the node's IP. Pods in the cluster
reach the node IP too, so any app can use the `e2b` SDK with those variables. Everything is plain HTTP: keep
it on a private network.

## Capacity and gotchas

- Sandbox RAM comes from the hugepage pool (4 GiB by default): the default 2.5 GB `t3` template needs a pool of at least 5 GiB to
  build (about twice its memory) and 2.5 GiB to run. On a 16 GB node set `vm.nr_hugepages=4096` (8 GiB) to fit 3 boxes, or build with
  `--memory 1536` to fit the default pool. Paused sandboxes use no RAM. To grow the pool, raise `vm.nr_hugepages`
  and the orchestrator's `hugepages-2Mi` request/limit and its `HUGEPAGES` setting together.
- Allocating hugepages on a running node can fail because memory is fragmented: reboot and re-run `host-prep.sh`.
- On a slow or overcommitted host, template builds sometimes fail with "An internal error occurred"
  (`syncing took too long`). Run the build again: finished steps are cached.
- Sandboxes can't reach the node's own IP: the E2B API isn't reachable from inside a sandbox.
- A template built `fromTemplate()` another one keeps the parent's disk size; t3e2b's templates start from images.

## Remove

```bash
kubectl -n e2b delete statefulset e2b && kubectl -n e2b wait --for=delete pod/e2b-0 --timeout=5m
sudo rm -rf /var/lib/e2b/data; kubectl delete namespace e2b
```
