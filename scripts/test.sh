#!/usr/bin/env bash
# Full check suite — run before every release. Hermetic: never touches the
# real board (integration uses its own tmux socket + temp dirs).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
echo "── syntax ──"
bash -n core/hamster core/facts-hook.sh install.sh tests/integration.sh
python3 -m py_compile core/*.py
node --check extension.js
echo "── served webview scripts ──"
node scripts/check-served.js
echo "── unit ──"
python3 -m unittest discover -s tests -q
echo "── integration (scratch tmux) ──"
bash tests/integration.sh
echo "ALL CHECKS PASS"
