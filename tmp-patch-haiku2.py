#!/usr/bin/env python3
"""Patch remaining openai* JSON helpers in actions.ts to llmChat (Anthropic-first)."""
from pathlib import Path
import re

p = Path(r"c:\Users\Simone\CascadeProjects\WEB APP CKB - Copia\src\app\dashboard\actions.ts")
text = p.read_text(encoding="utf-8")

# Pattern for helpers that: check OPENAI_API_KEY, build payload with system+user, fetch openai, parse JSON from choices
# We'll rewrite openaiDeterministicSearchFilters, openaiLegacyAiFilters, openaiNliJson, openaiJson similarly by
# finding each and doing targeted replacements of the fetch block.

helpers = [
    "openaiDeterministicSearchFilters",
    "openaiLegacyAiFilters",
    "openaiNliJson",
    "openaiJson",
]

for name in helpers:
    # Find function start
    m = re.search(rf"const {name} = async \(", text)
    if not m:
        print("skip missing", name)
        continue
    # Find body until matching closing `}\n\n\n\nconst ` or `}\n\n\n\nexport`
    start = m.start()
    # crude: from start to next '\n\n\n\nconst ' or '\n\n\n\nexport ' after 200 chars
    rest = text[start:]
    end_rel = None
    for marker in ("\n\n\n\nconst ", "\n\n\n\nexport ", "\n\n\n\ntype "):
        idx = rest.find(marker, 100)
        if idx != -1 and (end_rel is None or idx < end_rel):
            end_rel = idx
    if end_rel is None:
        print("skip no end", name)
        continue
    block = rest[:end_rel]
    if "api.openai.com" not in block:
        print("already patched?", name)
        continue
    if "llmChat" in block:
        print("already llm", name)
        continue

    # Extract system content expression from messages
    sys_m = re.search(r"\{ role: 'system', content: ([^\n]+) \}", block)
    user_m = re.search(r"\{ role: 'user', content: ([^\n]+) \}", block)
    ret_type_m = re.search(rf"Promise<([^>]+)>", block)
    if not sys_m or not user_m:
        print("skip parse msgs", name)
        continue

    system_expr = sys_m.group(1).rstrip(",")
    user_expr = user_m.group(1).rstrip(",")
    # userQuery is typical arg
    arg_m = re.search(rf"const {name} = async \(([^)]*)\)", block)
    args = arg_m.group(1) if arg_m else "userQuery: string"
    ret = ret_type_m.group(1) if ret_type_m else "any"

    # Find coerce/parse after content - keep tail after JSON.parse
    # Most do: const raw = JSON.parse(content) ... return
    # Simpler: keep everything after getting content by using llmChat then same parse logic.
    # Extract from `const json = (await res.json())` onward... actually replace whole function with llmChat + original post-parse.

    # Find post-parse: from `const content =` through end — we'll rebuild.

    # Look for parse lines after content check
    post = None
    for needle in (
        "const parsed = JSON.parse(content)",
        "const rawParsed = JSON.parse(content)",
        "const raw = JSON.parse(content)",
        "return JSON.parse(content)",
        "const data = JSON.parse(content)",
        "const obj = JSON.parse(content)",
        "const spec = JSON.parse(content)",
    ):
        if needle in block:
            post = block[block.index(needle):]
            break
    if post is None:
        # try generic JSON.parse(content)
        jm = re.search(r"\n  (const \w+ = JSON\.parse\(content\)[\s\S]+)$", block)
        if not jm:
            print("skip no postparse", name)
            continue
        post = jm.group(1)
        if not post.startswith("const"):
            post = "const " + post  # unlikely

    new_block = f"""const {name} = async ({args}): Promise<{ret}> => {{

  const content = await llmChat({{

    system: {system_expr},

    user: {user_expr},

    temperature: 0,

    json: true,

    timeoutMs: 25000,

  }})

  {post.rstrip()}
}}"""

    text = text[:start] + new_block + text[start + end_rel :]
    print("patched", name)

p.write_text(text, encoding="utf-8")
print("remaining openai.com", text.count("api.openai.com"))
