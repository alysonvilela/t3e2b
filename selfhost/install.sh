#!/usr/bin/env bash
# Installs E2B Embed into a single-node k3s cluster. Run as your user after host-prep.sh.
#   NODE=<node name> bash selfhost/install.sh      (default: the only node)
set -euo pipefail
cd "$(dirname "$0")"
NODE=${NODE:-$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}')}
[ -e /dev/kvm ] || { echo "FIX: /dev/kvm missing"; exit 1; }
hp=$(kubectl get node "$NODE" -o jsonpath='{.status.allocatable.hugepages-2Mi}')
[ "$hp" = "4Gi" ] || { echo "FIX: node $NODE advertises hugepages-2Mi=$hp, need 4Gi (run host-prep.sh)"; exit 1; }
kubectl label node "$NODE" e2b.dev/single-node=true --overwrite
kubectl create namespace e2b --dry-run=client -o yaml | kubectl apply -f -
kubectl -n e2b get secret e2b-api >/dev/null 2>&1 || kubectl -n e2b create secret generic e2b-api \
  --from-literal=ADMIN_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=SANDBOX_ACCESS_TOKEN_HASH_SEED="$(openssl rand -hex 32)"
kubectl apply -k .
kubectl -n e2b rollout status statefulset/e2b --timeout=15m
kubectl -n e2b logs e2b-0 -c ready | tail -5
# E2B_API_KEY, E2B_API_URL, E2B_SANDBOX_URL, E2B_DASHBOARD_URL for this cluster. Keep it private.
kubectl -n e2b exec e2b-0 -c ready -- cat /run/e2b/sdk.env > sdk.env && chmod 600 sdk.env
echo "SDK env written to $(pwd)/sdk.env"
