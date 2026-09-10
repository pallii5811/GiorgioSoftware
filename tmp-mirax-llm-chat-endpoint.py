#!/usr/bin/env python3
"""Patch worker_supabase.py: add POST /llm-chat using server ANTHROPIC key."""
from pathlib import Path

path = Path("/home/worker/app/backend/worker_supabase.py")
text = path.read_text(encoding="utf-8")
marker = '    @app.post("/audit-url")'
if "/llm-chat" in text:
    print("already_present")
    raise SystemExit(0)

insert = r'''
    class _LlmChatRequest(BaseModel):
        system: str
        user: str
        temperature: float = 0
        json: bool = False

    @app.post("/llm-chat")
    async def llm_chat(payload: _LlmChatRequest) -> Dict[str, Any]:
        """Proxy Anthropic Haiku for Vercel search NLP when frontend has no API key."""
        import os
        import urllib.error
        import urllib.request

        key = (os.getenv("ANTHROPIC_API_KEY") or "").strip()
        if not key:
            raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY missing on worker")
        model = (os.getenv("ANTHROPIC_MODEL") or "claude-haiku-4-5").strip()
        system = payload.system
        if payload.json:
            system = system + "\n\nRispondi SOLO con un oggetto JSON valido. Niente markdown, niente spiegazioni."
        body = json.dumps(
            {
                "model": model,
                "max_tokens": 4096,
                "temperature": float(payload.temperature or 0),
                "system": system,
                "messages": [{"role": "user", "content": payload.user}],
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=body,
            method="POST",
            headers={
                "content-type": "application/json",
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:500]
            raise HTTPException(status_code=502, detail=f"anthropic_{e.code}:{detail}")
        except Exception as e:
            raise HTTPException(status_code=502, detail=str(e))
        text_out = "".join(
            (b.get("text") or "")
            for b in (raw.get("content") or [])
            if isinstance(b, dict) and b.get("type") == "text"
        ).strip()
        if not text_out:
            raise HTTPException(status_code=502, detail="ANTHROPIC_EMPTY_CONTENT")
        return {"text": text_out, "model": model}

'''

if marker not in text:
    raise SystemExit("marker not found")
text = text.replace(marker, insert + marker, 1)
path.write_text(text, encoding="utf-8")
print("patched_ok")
