"""Resume-parser worker: hosts sukhrobnurali/qwen3vl-resume-parser behind HTTP.

POST /parse   {"filename": "resume.pdf", "content_base64": "..."}
              -> {"resume": {<23-field record>}, "model": "...", "pages": n}
GET  /healthz -> {"ok": true, "model_loaded": bool}

PDFs are rendered to page PNGs with pypdfium2 (top-to-bottom, one image per
page), then run through the exact inference recipe from the model card.
Deploy on a GPU (Cloud Run GPU / L4 is plenty). Optional bearer auth via
PARSER_BEARER_TOKEN — set the same value as RESUME_PARSER_TOKEN in JobSync.
"""

import base64
import io
import json
import os
import re
import tempfile
import threading

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

MODEL_ID = os.environ.get("PARSER_MODEL_ID", "sukhrobnurali/qwen3vl-resume-parser")
MAX_PAGES = int(os.environ.get("PARSER_MAX_PAGES", "4"))
PDF_RENDER_SCALE = float(os.environ.get("PARSER_PDF_SCALE", "2.0"))  # ~144 dpi

SYSTEM_PROMPT = "You are a resume parser. Extract information from resume images into structured JSON."
USER_PROMPT = "Parse this resume and return the structured JSON."

app = FastAPI(title="jobsync-resume-parser", version="1.0.0")

_model = None
_processor = None
_load_lock = threading.Lock()


def _load_model():
    """Lazy, thread-safe model load (first request on a cold container)."""
    global _model, _processor
    if _model is not None:
        return
    with _load_lock:
        if _model is not None:
            return
        from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

        _model = Qwen3VLForConditionalGeneration.from_pretrained(
            MODEL_ID, dtype="auto", device_map="auto", attn_implementation="sdpa",
        )
        _processor = AutoProcessor.from_pretrained(MODEL_ID)


def _pdf_to_page_paths(pdf_bytes: bytes, out_dir: str) -> list[str]:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(pdf_bytes)
    paths = []
    for i, page in enumerate(doc):
        if i >= MAX_PAGES:
            break
        bitmap = page.render(scale=PDF_RENDER_SCALE)
        pil = bitmap.to_pil()
        path = os.path.join(out_dir, f"page_{i + 1}.png")
        pil.save(path)
        paths.append(path)
    doc.close()
    if not paths:
        raise HTTPException(status_code=422, detail="PDF has no renderable pages.")
    return paths


def _extract_json(text: str) -> dict:
    """The model emits pure JSON; tolerate stray code fences just in case."""
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1:
        raise HTTPException(status_code=502, detail="Model output contained no JSON object.")
    return json.loads(text[start : end + 1])


def _run_inference(page_paths: list[str]) -> dict:
    # Exact recipe from the model card: the 23-field schema is baked into the
    # weights, so the short training prompt is all it needs.
    messages = [{
        "role": "user",
        "content": (
            [{"type": "text", "text": SYSTEM_PROMPT}]
            + [{"type": "image", "url": p} for p in page_paths]
            + [{"type": "text", "text": USER_PROMPT}]
        ),
    }]
    inputs = _processor.apply_chat_template(
        messages,
        tokenize=True,
        add_generation_prompt=True,
        return_dict=True,
        return_tensors="pt",
    ).to(_model.device)
    inputs.pop("token_type_ids", None)
    generated = _model.generate(**inputs, max_new_tokens=4096, do_sample=False)
    trimmed = generated[:, inputs["input_ids"].shape[1]:]
    text = _processor.batch_decode(trimmed, skip_special_tokens=True)[0]
    return _extract_json(text)


class ParseRequest(BaseModel):
    filename: str
    content_base64: str


def _check_auth(request: Request) -> None:
    token = os.environ.get("PARSER_BEARER_TOKEN")
    if token and request.headers.get("authorization") != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/healthz")
def healthz():
    return {"ok": True, "model": MODEL_ID, "model_loaded": _model is not None}


@app.post("/parse")
def parse(req: ParseRequest, request: Request):
    _check_auth(request)
    try:
        raw = base64.b64decode(req.content_base64, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="content_base64 is not valid base64.")
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file.")

    _load_model()

    name = req.filename.lower()
    with tempfile.TemporaryDirectory() as tmp:
        if name.endswith(".pdf"):
            pages = _pdf_to_page_paths(raw, tmp)
        elif name.endswith((".png", ".jpg", ".jpeg")):
            from PIL import Image

            path = os.path.join(tmp, "page_1.png")
            Image.open(io.BytesIO(raw)).convert("RGB").save(path)
            pages = [path]
        else:
            raise HTTPException(status_code=400, detail="Use .pdf, .png, or .jpg.")

        resume = _run_inference(pages)
        return {"resume": resume, "model": MODEL_ID, "pages": len(pages)}
