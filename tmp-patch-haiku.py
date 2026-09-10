#!/usr/bin/env python3
from pathlib import Path

p = Path(r"c:\Users\Simone\CascadeProjects\WEB APP CKB - Copia\src\app\dashboard\actions.ts")
text = p.read_text(encoding="utf-8")

if "from '@/lib/llm-json'" not in text:
    needle = "'use server'\n\n\n\n"
    insert = "'use server'\n\n\n\nimport { llmChat, parseLlmJson } from '@/lib/llm-json'\n\n\n\n"
    if needle not in text:
        raise SystemExit("use server header not found")
    text = text.replace(needle, insert, 1)

old = """const openaiSearchNlpParams = async (

  userQuery: string,

  ctx: { available_categories: string[]; available_locations: string[] }

): Promise<SearchNlpParams> => {

  const apiKey = process.env.OPENAI_API_KEY

  if (!apiKey) {

    throw new Error('MISSING_OPENAI_KEY')

  }



  const payload = {

    model: 'gpt-4o-mini',

    temperature: 0,

    response_format: { type: 'json_object' },

    messages: [

      { role: 'system', content: buildSearchNlpSystemPromptWithContext(ctx) },

      { role: 'user', content: userQuery },

    ],

  }



  const controller = new AbortController()

  const timeoutId = setTimeout(() => controller.abort(), 25000)



  const res = await fetch('https://api.openai.com/v1/chat/completions', {

    method: 'POST',

    headers: {

      'Content-Type': 'application/json',

      Authorization: `Bearer ${apiKey}`,

    },

    body: JSON.stringify(payload),

    signal: controller.signal,

  }).finally(() => clearTimeout(timeoutId))



  if (!res.ok) {

    const bodyText = await res.text().catch(() => '')

    throw new Error(`OPENAI_HTTP_${res.status}: ${bodyText || res.statusText}`)

  }



  const json = (await res.json()) as any

  const content = json?.choices?.[0]?.message?.content

  if (typeof content !== 'string' || !content.trim()) {

    throw new Error('OPENAI_EMPTY_CONTENT')

  }



  const rawParsed = JSON.parse(content)

  const coerced = coerceSearchNlpParams(rawParsed)

  console.log('LLM EXTRACTION:', { raw: rawParsed, coerced, source: 'llm' })

  return coerced

}"""

new = """const openaiSearchNlpParams = async (

  userQuery: string,

  ctx: { available_categories: string[]; available_locations: string[] }

): Promise<SearchNlpParams> => {

  const content = await llmChat({

    system: buildSearchNlpSystemPromptWithContext(ctx),

    user: userQuery,

    temperature: 0,

    json: true,

    timeoutMs: 25000,

  })

  const rawParsed = parseLlmJson(content)

  const coerced = coerceSearchNlpParams(rawParsed)

  console.log('LLM EXTRACTION:', { raw: rawParsed, coerced, source: 'llm' })

  return coerced

}"""

if old not in text:
    raise SystemExit("openaiSearchNlpParams block not found")
text = text.replace(old, new, 1)

# Also patch other filter helpers used by search — replace OPENAI-only gate with llmChat for the main JSON helpers.
# openaiDeterministicSearchFilters, openaiLegacyAiFilters, openaiNliJson, openaiJson, openaiPitch
# Use a lighter approach: make OPENAI_API_KEY check also accept ANTHROPIC and swap fetch URL via monkey... too hard.
# Patch remaining helpers that still call api.openai.com by replacing apiKey check + fetch with llmChat where pattern is clear.

import re

# Fix inline OpenAI calls that use process.env.OPENAI_API_KEY in Authorization for smaller call sites
# Leave for now if search path is fixed; user asked search to work.

p.write_text(text, encoding="utf-8")
print("OK patched")
print("openai.com remaining", text.count("api.openai.com"))
print("has import", "llm-json" in text)
