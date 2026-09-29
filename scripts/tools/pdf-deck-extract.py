#!/usr/bin/env python3
"""pdf-deck-extract.py —— 客户产品 PDF → 逐页文本 + 嵌入图（商品档案导入的前置解析器）

用法：
  python3 scripts/tools/pdf-deck-extract.py --file <产品介绍.pdf> --out <工作目录> [--min-px 600]

产出（供 product-archive.mts import-pdf 消费）：
  <out>/pages.json   [{ page, text, images:[{file,width,height,bytes}] }]
  <out>/pages/p-XX.png  （每页渲染图，150dpi，兜底证据）
  <out>/images/*.png|jpg（PDF 内嵌图片原件，按页归属）

为什么用 Python：仓库已有 Python 工具先例（talkcraft-asr-words.py / generate-model-02-seedream.py）；
PDF 文本与内嵌图解析用 pdfplumber/pypdf 最稳，Node 侧只负责"按规则建档"（唯一事实源在 product-archive.ts）。
"""
import argparse, io, json, os, subprocess, sys
from pathlib import Path

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-px", type=int, default=600)
    ap.add_argument("--dpi", type=int, default=150)
    args = ap.parse_args()

    try:
        import pdfplumber
        from pypdf import PdfReader
    except Exception as exc:  # pragma: no cover
        print(f"缺少 PDF 解析依赖（pdfplumber/pypdf）：{exc}", file=sys.stderr)
        return 2

    src = Path(args.file)
    out = Path(args.out)
    (out / "images").mkdir(parents=True, exist_ok=True)
    (out / "pages").mkdir(parents=True, exist_ok=True)

    pages = []
    with pdfplumber.open(str(src)) as pdf:
        for index, page in enumerate(pdf.pages, 1):
            text = (page.extract_text() or "").strip()
            pages.append({"page": index, "text": text, "images": []})

    # 每页渲染图（版式证据 + 图片兜底来源）
    try:
        subprocess.run(["pdftoppm", "-png", "-r", str(args.dpi), str(src), str(out / "pages" / "p")],
                       check=True, capture_output=True)
    except Exception as exc:
        print(f"⚠ pdftoppm 渲染失败（不影响文字与内嵌图）：{exc}", file=sys.stderr)

    def size_of(data: bytes):
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big"), "png"
        if data[:2] == b"\xff\xd8":
            i = 2
            while i + 9 < len(data):
                if data[i] != 0xFF:
                    i += 1
                    continue
                marker = data[i + 1]
                length = int.from_bytes(data[i + 2:i + 4], "big")
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big"), "jpg"
                i += 2 + length
        return None

    reader = PdfReader(str(src))
    for index, page in enumerate(reader.pages, 1):
        try:
            images = list(page.images)
        except Exception:
            images = []
        for n, image in enumerate(images, 1):
            data = image.data
            dims = size_of(data)
            if not dims:
                continue
            width, height, ext = dims
            if max(width, height) < args.min_px or len(data) < 50_000:
                continue
            name = f"images/p{index:02d}-{n:02d}.{ext}"
            (out / name).write_bytes(data)
            pages[index - 1]["images"].append({"file": name, "width": width, "height": height, "bytes": len(data)})

    (out / "pages.json").write_text(json.dumps({"source": src.name, "pages": pages}, ensure_ascii=False, indent=1), encoding="utf-8")
    total_images = sum(len(p["images"]) for p in pages)
    print(f"解析完成：{len(pages)} 页 · 内嵌图 {total_images} 张（≥{args.min_px}px 且 ≥50KB）→ {out/'pages.json'}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
