"""
Skill Loader — reads skills from the SKILLS environment variable and
assembles additional system-prompt content.

Skill layout (inside the worker container or ConfigMap mount):

  /skills/
  ├── code-review/
  │   └── prompt.md          # System-prompt fragment
  ├── data-analysis/
  │   └── prompt.md
  └── docker-expert/
      └── prompt.md

Each skill's prompt.md is appended (in order) to the base SOUL.md so the
agent gains the specialised knowledge without replacing the base personality.

Skills can also ship an optional `tools.json` that lists extra tool names to
enable (currently advisory; nanobot enables all built-in tools by default).

The SKILLS env var is a comma-separated list of skill names, e.g.:
  SKILLS=code-review,data-analysis
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

# Default location for skill bundles (can be overridden by env var)
SKILLS_DIR = Path(os.environ.get("SKILLS_DIR", "/skills"))


def load_skill_prompts(skill_names: list[str]) -> str:
    """
    Load and concatenate prompt fragments for the requested skill names.

    Returns a single string (may be empty) to append to the agent's system prompt.
    """
    if not skill_names:
        return ""

    fragments: list[str] = []
    for name in skill_names:
        name = name.strip()
        if not name:
            continue
        prompt_text = _load_skill_prompt(name)
        if prompt_text:
            fragments.append(f"## Skill: {name}\n\n{prompt_text.strip()}")
        else:
            logger.warning("Skill '%s' not found or has no prompt.md — skipping", name)

    if not fragments:
        return ""

    return "\n\n---\n\n".join(fragments)


def get_skills_from_env() -> list[str]:
    """Parse the SKILLS env var into a list of skill names."""
    raw = os.environ.get("SKILLS", "").strip()
    if not raw:
        return []
    return [s.strip() for s in raw.split(",") if s.strip()]


def _load_skill_prompt(name: str) -> str:
    # Try filesystem skill bundle
    skill_dir = SKILLS_DIR / name
    prompt_file = skill_dir / "prompt.md"
    if prompt_file.exists():
        try:
            return prompt_file.read_text(encoding="utf-8")
        except OSError as e:
            logger.warning("Could not read skill prompt %s: %s", prompt_file, e)

    # Fall back to built-in skills bundled with this package
    builtin = _load_builtin_skill(name)
    if builtin:
        return builtin

    return ""


def _load_builtin_skill(name: str) -> str:
    """
    Return a hard-coded prompt for built-in skill names.
    This enables useful skills without requiring a mounted /skills volume.
    """
    _BUILTIN = {
        "code-review": """\
You are an expert code reviewer. When asked to review code:
- Point out bugs, security issues, and performance problems first
- Suggest idiomatic improvements and best practices
- Explain the *why* behind each suggestion
- Be constructive and respectful
""",
        "data-analysis": """\
You are a data analyst. When working with data:
- Prefer pandas/polars for tabular data manipulation
- Use matplotlib or plotly for visualisation
- Always check for nulls, outliers, and data type issues before analysis
- Summarise key statistics and insights clearly
""",
        "docker-expert": """\
You are a Docker and container expert. Help with:
- Writing efficient, secure Dockerfiles (multi-stage builds, non-root users)
- Docker Compose configurations
- Container networking and volume management
- Debugging container issues
""",
        "k8s-expert": """\
You are a Kubernetes expert. Help with:
- Writing correct YAML manifests (Deployments, Services, Ingress, RBAC)
- Troubleshooting Pod failures, scheduling issues, and network policies
- Helm charts and Kustomize overlays
- K8s security best practices (pod security, network policies)
""",
        "sql-expert": """\
You are a SQL and database expert. Help with:
- Writing efficient, readable SQL queries (prefer CTEs over subqueries)
- Schema design and normalisation
- Query optimisation (index hints, EXPLAIN plans)
- Database-specific dialects: PostgreSQL, MySQL, SQLite, BigQuery
""",
        "writing-assistant": """\
You are a professional writing assistant. Help with:
- Clarity, conciseness, and tone
- Grammar and punctuation
- Structuring documents and arguments logically
- Adapting style for technical, business, or casual audiences
""",
    }
    return _BUILTIN.get(name, "")


def load_skill_tools(skill_names: list[str]) -> list[str]:
    """
    Return a combined list of extra tool names requested by the skills.
    (Currently informational; nanobot enables all built-in tools by default.)
    """
    tools: list[str] = []
    for name in skill_names:
        skill_dir = SKILLS_DIR / name
        tools_file = skill_dir / "tools.json"
        if tools_file.exists():
            try:
                data = json.loads(tools_file.read_text(encoding="utf-8"))
                if isinstance(data, list):
                    tools.extend(data)
            except (OSError, json.JSONDecodeError) as e:
                logger.warning("Could not read tools.json for skill %s: %s", name, e)
    return list(dict.fromkeys(tools))  # deduplicate, preserve order
