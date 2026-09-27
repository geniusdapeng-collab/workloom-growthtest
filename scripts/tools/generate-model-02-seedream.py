#!/usr/bin/env python3
"""Generate one original model-02 portrait through Ark Seedream text-to-image.

No image input is accepted by this tool. The API key stays in process memory;
the saved evidence omits the time-limited image URL and authentication headers.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request


API_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations"
MODEL = "doubao-seedream-5-0-pro-260628"
TRACE_HEADERS = (
    "x-tt-logid",
    "x-request-id",
    "x-trace-id",
    "x-ark-trace-id",
    "request-id",
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def key_from_local_store() -> str:
    for name in ("VOLCENGINE_ARK_API_KEY", "ARK_API_KEY"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    result = subprocess.run(
        ["security", "find-generic-password", "-s", "workloom-live-ark", "-w"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError("Ark API key unavailable in environment or macOS Keychain")
    return result.stdout.strip()


def selected_headers(headers: object) -> dict[str, str]:
    return {name: value for name in TRACE_HEADERS if (value := headers.get(name))}


def request_json(url: str, payload: dict[str, object], api_key: str) -> tuple[dict[str, object], int, dict[str, str]]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            status = response.status
            trace = selected_headers(response.headers)
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read(4096).decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Ark HTTP {exc.code}; trace={selected_headers(exc.headers)}; body={detail}"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Ark network error: {exc.reason}") from exc
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Ark returned invalid JSON (HTTP {status})") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("Ark response root is not an object")
    return parsed, status, trace


def download_jpeg(url: str) -> tuple[bytes, int, dict[str, str]]:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise RuntimeError("Ark returned a non-HTTPS image URL")
    try:
        with urllib.request.urlopen(url, timeout=120) as response:
            status = response.status
            trace = selected_headers(response.headers)
            content_type = response.headers.get("Content-Type", "")
            data = response.read(32 * 1024 * 1024 + 1)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Image download HTTP {exc.code}; trace={selected_headers(exc.headers)}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Image download network error: {exc.reason}") from exc
    if len(data) > 32 * 1024 * 1024 or len(data) < 50 * 1024:
        raise RuntimeError(f"Image byte size outside expected bounds: {len(data)}")
    if not data.startswith(b"\xff\xd8\xff") or not data.endswith(b"\xff\xd9"):
        raise RuntimeError(f"Image is not a complete JPEG (content-type={content_type})")
    return data, status, trace


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", delete=False) as temporary:
        temporary.write(data)
        temporary.flush()
        os.fsync(temporary.fileno())
        temp_path = Path(temporary.name)
    os.replace(temp_path, path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--angle", required=True)
    parser.add_argument("--prompt-file", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--summary", required=True)
    args = parser.parse_args()
    if args.output.suffix.lower() not in (".jpg", ".jpeg"):
        parser.error("output must have a .jpg or .jpeg suffix")
    if args.output.exists():
        parser.error(f"refusing to overwrite existing output: {args.output}")
    prompt = args.prompt_file.read_text(encoding="utf-8").strip()
    if not prompt or len(prompt) > 1000:
        parser.error("prompt must contain 1-1000 characters")
    payload: dict[str, object] = {
        "model": MODEL,
        "prompt": prompt,
        "size": "2K",
        "output_format": "jpeg",
        "response_format": "url",
        "watermark": False,
    }
    # Keep this a pure text-to-image request, even when the CLI is extended.
    assert "image" not in payload and "images" not in payload
    response, status, trace = request_json(API_URL, payload, key_from_local_store())
    response_model = response.get("model")
    created = response.get("created")
    image_list = response.get("data")
    if response_model != MODEL or not isinstance(created, int):
        raise RuntimeError(f"Unexpected Ark model/created: {response_model!r} / {created!r}")
    if not isinstance(image_list, list) or len(image_list) != 1 or not isinstance(image_list[0], dict):
        raise RuntimeError("Ark did not return exactly one image")
    image_info = image_list[0]
    image_url = image_info.get("url")
    if not isinstance(image_url, str):
        raise RuntimeError("Ark image response omitted URL")
    image_bytes, download_status, download_trace = download_jpeg(image_url)
    digest = sha256(image_bytes)
    produce_id = f"WL-GROWTH-M02-{args.angle.upper()}-{created}-{digest[:12].upper()}"
    evidence = {
        "schemaVersion": "workloom.model-02-seedream-provenance/v1",
        "source": "original-pure-text-to-image",
        "apiDocument": "https://docs.volcengine.com/docs/ark/image-generation-api?lang=en",
        "invisibleWatermarkDocument": "https://docs.volcengine.com/docs/ark/add-invisible-watermark-to-ai-generated-content?lang=zh",
        "angle": args.angle,
        "promptSummary": args.summary,
        "prompt": prompt,
        "promptSha256": sha256(prompt.encode("utf-8")),
        "request": {"url": API_URL, "bodyWithoutPrompt": {k: v for k, v in payload.items() if k != "prompt"}, "imageFieldPresent": False},
        "response": {
            "httpStatus": status,
            "traceHeaders": trace,
            "model": response_model,
            "created": created,
            "fields": sorted(response.keys()),
            "imageSize": image_info.get("size"),
            "imageFormat": image_info.get("output_format"),
            "usage": response.get("usage"),
        },
        "download": {"httpStatus": download_status, "traceHeaders": download_trace, "urlSha256": sha256(image_url.encode("utf-8"))},
        "output": {"path": str(args.output), "bytes": len(image_bytes), "sha256": digest},
        "produceId": produce_id,
        "produceIdNote": "Client-defined resource mapping. This is not an Ark or Seedream task_id.",
        "visibleWatermarkRequested": False,
        "invisibleWatermark": {"status": "unverified", "reason": "Endpoint-level feature and JPEG metadata require separate verification"},
    }
    atomic_write(args.output, image_bytes)
    evidence_file = args.output.with_suffix(args.output.suffix + ".provenance.json")
    atomic_write(evidence_file, (json.dumps(evidence, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    print(json.dumps({"output": str(args.output), "sha256": digest, "model": response_model, "created": created, "traceHeaders": trace, "produceId": produce_id, "provenance": str(evidence_file)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"generation failed: {error}", file=sys.stderr)
        sys.exit(1)
