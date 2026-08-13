# Remove AI Marks Skill

Vendored source: https://github.com/guillaumemeyer/watermarks-remover

Snapshot date: 2026-08-13. Upstream license: MIT, preserved at
`skills/remove-ai-marks/LICENSE`.

The reusable skill lives at `skills/remove-ai-marks/`. It provides an agent
`SKILL.md`, reference notes, and Python 3.10+ stdlib scripts for inspecting and
cleaning owned content:

- invisible Unicode and exotic spaces in text;
- Markdown/HTML AI metadata and frontmatter keys;
- C2PA/EXIF/XMP/container metadata for supported document/image formats;
- optional best-effort rewrite prompts for statistical text marks.

Use it in future project-generation work by copying or mounting
`skills/remove-ai-marks/` into the generated project or by calling its scripts
from factory tooling:

```bash
python3 skills/remove-ai-marks/scripts/inspect_file.py path
python3 skills/remove-ai-marks/scripts/clean_file.py path -o path.cleaned
```

The skill is intended for content the owner controls. Reports must distinguish
verifiable cleaning from best-effort statistical rewrite risk; it cannot certify
that any vendor detector will fail.
