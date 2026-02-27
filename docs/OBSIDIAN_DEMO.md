# Obsidian Demo Runbook

This runbook configures and launches the WorkGraph Obsidian demo vault with:

- generated Kanban + command-center content,
- terminal and Kanban community plugins,
- graph color groups for large context visualization.

## 1) Generate the demo vault

```bash
npm run demo:workspace
```

This creates:

- `/tmp/workgraph-obsidian-demo`

## 2) Install Obsidian demo plugins/config

```bash
npm run demo:obsidian-setup
```

This installs:

- `obsidian-kanban`
- `terminal`

and writes `.obsidian/graph.json` / workspace defaults.

## 3) Launch Obsidian

If native Obsidian launch works in your environment:

```bash
obsidian /tmp/workgraph-obsidian-demo
```

If AppImage/FUSE is unavailable, use extracted AppImage fallback:

```bash
/tmp/squashfs-root/AppRun /tmp/workgraph-obsidian-demo
```

## 4) Demo flow checklist

1. Open `ops/Workgraph Board.md` (Kanban view).
2. Open `ops/Command Center.md`.
3. Open one `context-nodes/context-node-*.md`.
4. Open integrated terminal pane and run `pwd` + `ls`.
5. Open Graph view and pan/zoom for large colored graph.
