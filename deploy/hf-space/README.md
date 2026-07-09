---
title: Genesis Infinity CPU Test
emoji: 🎲
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# Genesis Infinity — real-model CPU test

Runs the Genesis Infinity engine's CLI (`npm run play`) against a real
Llama-3.2-3B-Instruct-Q4_K_M model on this Space's CPU, scripting three
turns (scope check, technique use, item use) through the `blackline-action`
example Experience. Output is visible in this Space's container logs —
there is no interactive UI. The HTTP endpoint on port 7860 only exists to
satisfy the Space's health check.

This Space's contents are synced automatically from the `main` branch of
the Genesis Infinity GitHub repo by `.github/workflows/sync-hf-space.yml`
— do not edit files here directly, they'll be overwritten on the next push.
