# Indigital Studio Marketplace

An omp marketplace for skills, plugins, and extensions.

## Add this marketplace

```bash
omp plugin marketplace add indigitalstudio/marketplace
```

Or by full URL (for private/custom repos):

```bash
omp plugin marketplace add https://github.com/indigitalstudio/marketplace
```

## Install a plugin

List available plugins:

```bash
omp plugin list --marketplace indigitalstudio-marketplace
```

Install one:

```bash
omp plugin install sample-skill@indigitalstudio-marketplace
```

## Repo structure

```
.
├── marketplace.json           # omp marketplace catalog
├── plugins/
│   └── <plugin-name>/         # one directory per plugin
│       ├── .claude-plugin/
│       │   └── plugin.json     # plugin metadata + hooks
│       └── skills/
│           └── <skill-name>/
│               └── SKILL.md   # skill instructions
└── README.md
```

## Add a new plugin

1. Create `plugins/<your-plugin>/` directory.
2. Add `plugins/<your-plugin>/.claude-plugin/plugin.json` with plugin metadata.
3. Add `plugins/<your-plugin>/skills/<skill-name>/SKILL.md` with your skill content.
4. Add an entry to `plugins[]` in `marketplace.json` pointing `"source": "./plugins/<your-plugin>"`.

### plugin.json template

```json
{
  "name": "your-plugin-name",
  "description": "What it does, in one line.",
  "author": {
    "name": "Your Name",
    "url": "https://github.com/your-handle"
  }
}
```

### SKILL.md template

```markdown
---
name: your-skill-name
description: One-line trigger description.
---

# Your Skill Name

Instructions for the agent...
```
