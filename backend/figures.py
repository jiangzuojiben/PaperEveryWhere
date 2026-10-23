"""Conservative embedded-image candidates, not a semantic chart detector."""
import base64
import io
import re
from pypdf import PdfReader, PdfWriter
import pypdfium2 as pdfium
from .pdf import pdf_lock


def figure_candidates(content: bytes, pages=None, checkpoint=None, limit=60):
    # Flatten page rotation into the content so returned normalized coordinates
    # agree with the displayed PDF on both clients, including rotated pages.
    reader = PdfReader(io.BytesIO(content))
    writer = PdfWriter()
    writer.append(reader)
    for page in writer.pages:
        if page.rotation:
            page.transfer_rotation_to_content()
    normalized = io.BytesIO(); writer.write(normalized)
    figures, budget, truncated = [], 0, False
    pattern = re.compile(r'^(?:fig(?:ure)?\.?|table|图|表)\s*([A-Za-z]?\d+(?:[.\-]\d+)*)\b', re.I)
    with pdf_lock:
        doc = pdfium.PdfDocument(normalized.getvalue())
        try:
            selected = [i for i in range(len(doc)) if not pages or i + 1 in pages]
            for offset, index in enumerate(selected):
                if checkpoint:
                    checkpoint(.1 + .8 * offset / max(1, len(selected)))
                page = doc[index]
                textpage = page.get_textpage()
                bitmap = None
                try:
                    left, bottom, right, top = page.get_bbox()
                    width, height = right - left, top - bottom
                    boxes = []
                    for obj in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_IMAGE], max_depth=1):
                        l, b, r, t = obj.get_bounds()
                        l, b, r, t = max(l, left), max(b, bottom), min(r, right), min(t, top)
                        area = max(0, r - l) * max(0, t - b) / (width * height)
                        # Full-page scans and logos are not presented as charts.
                        if r - l < 40 or t - b < 40 or not .02 <= area <= .85:
                            continue
                        box = [max(0, (l - left) / width), max(0, (top - t) / height),
                               min(1, (r - left) / width), min(1, (top - b) / height)]
                        if any(all(abs(a - v) < .005 for a, v in zip(box, previous)) for previous in boxes):
                            continue
                        boxes.append(box)
                        caption = ''
                        # Only accept explicit figure/table labels close to the image.
                        for region in [(l, max(bottom, b - 85), r, b), (l, t, r, min(top, t + 55))]:
                            nearby = textpage.get_text_bounded(*region).strip()
                            lines = nearby.splitlines()
                            for n, line in enumerate(lines):
                                if pattern.match(line.strip()):
                                    caption = ' '.join(lines[n:n + 4])[:600]
                                    break
                            if caption:
                                break
                        if bitmap is None:
                            bitmap = page.render(scale=min(1.5, 1800 / max(width, height)))
                        image = bitmap.to_pil()
                        crop = image.crop((round(box[0] * image.width), round(box[1] * image.height),
                                           round(box[2] * image.width), round(box[3] * image.height)))
                        try:
                            crop.thumbnail((800, 800))
                            output = io.BytesIO(); crop.save(output, format='PNG')
                            encoded = base64.b64encode(output.getvalue()).decode('ascii')
                        finally:
                            crop.close(); image.close()
                        if len(figures) >= limit or budget + len(encoded) > 8_000_000:
                            truncated = True
                            break
                        budget += len(encoded)
                        match = pattern.match(caption)
                        figures.append({'page': index + 1, 'rect': box, 'caption': caption,
                            'label': match.group(0) if match else '', 'image_base64': encoded,
                            'caption_verified': False})
                finally:
                    if bitmap is not None:
                        bitmap.close()
                    textpage.close(); page.close()
                if truncated:
                    break
        finally:
            doc.close()
    return {'figures': figures, 'truncated': truncated, 'method': 'embedded-images-v1',
            'limitations': '仅枚举页面直接嵌入的较大图像；矢量图、嵌套图、纯文本表格及扫描页需手动选图。图号与图注为邻近文字候选，请核对原文。'}
