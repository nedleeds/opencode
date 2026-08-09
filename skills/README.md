# skills

Each subdirectory here is one opencode skill: a folder with a `SKILL.md` and
whatever scripts or reference files it needs.

```
skills/
  my-skill/
    SKILL.md
    scripts/…
    reference/…
```

`index.js` adds this directory to `skills.paths` at load, so anything dropped in
here reaches every user on the next start — no config change on their side.

A `SKILL.md` starts with frontmatter; `description` is what the model matches
against, so write it as the trigger condition, not as a summary:

```markdown
---
name: my-skill
description: Use when … . Covers … .
---

# My skill

Instructions the model follows once the skill is loaded.
```

Paths inside a skill resolve against its own directory, so `scripts/foo.py`
works regardless of where the repo was installed.
