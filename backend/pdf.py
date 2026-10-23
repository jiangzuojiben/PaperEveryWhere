import io
import threading
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, NameObject, ArrayObject, FloatObject, TextStringObject, NumberObject, DecodedStreamObject
import pypdfium2 as pdfium


# PDFium is not thread safe. All in-process calls use this lock; Celery uses
# prefork workers so each process gets an independent PDFium instance.
pdf_lock = threading.RLock()


def inspect_pdf(content: bytes, password=""):
    with pdf_lock:
        doc = pdfium.PdfDocument(content, password=password)
        try:
            pages = []
            for index in range(len(doc)):
                page = doc[index]
                textpage = page.get_textpage()
                try:
                    text = textpage.get_text_range()
                    pages.append({"page": index + 1, "width": page.get_width(), "height": page.get_height(), "text": text})
                finally:
                    textpage.close()
                    page.close()
            outline = [{"title": item.title, "page": item.page_index + 1 if item.page_index is not None else None,
                        "level": item.level} for item in doc.get_toc()]
            metadata = doc.get_metadata_dict()
            return {"pages": pages, "outline": outline, "metadata": metadata,
                    "needs_ocr": bool(pages) and not any(p["text"].strip() for p in pages)}
        finally:
            doc.close()


def render_page(content: bytes, page_number: int, scale: float = 1.2):
    with pdf_lock:
        doc = pdfium.PdfDocument(content)
        try:
            if not 1 <= page_number <= len(doc):
                raise ValueError("页码超出范围")
            page = doc[page_number - 1]
            try:
                bitmap = page.render(scale=scale)
                try:
                    output = io.BytesIO()
                    bitmap.to_pil().save(output, format="PNG")
                    return output.getvalue()
                finally:
                    bitmap.close()
            finally:
                page.close()
        finally:
            doc.close()


def export_annotations(content: bytes, annotations: list[dict]) -> bytes:
    reader = PdfReader(io.BytesIO(content))
    if reader.is_encrypted and not reader.decrypt(""):
        raise ValueError("请先导入已解锁的 PDF")
    writer = PdfWriter()
    writer.append(reader)
    for annotation in annotations:
        page_index = annotation["page"] - 1
        if not 0 <= page_index < len(writer.pages):
            continue
        page = writer.pages[page_index]
        # Transfer /Rotate to content so displayed top-left coordinates map
        # consistently to the exported PDF's unrotated page.
        if page.rotation:
            page.transfer_rotation_to_content()
        box = page.cropbox
        width, height = float(box.width), float(box.height)
        def xy(x, y):
            return float(box.left) + x * width, float(box.bottom) + (1 - y) * height
        def numbers(values):
            return ArrayObject([FloatObject(v) for v in values])
        color = annotation.get("color", "#edb83c").lstrip("#")
        rgb = [int(color[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        kind = annotation["type"]
        opacity = annotation.get('opacity', .35 if kind == 'highlight' else 1)
        fill_opacity = annotation.get('fill_opacity', 0)
        fixed_stroke = annotation.get('stroke_width')
        stroke_width = (fixed_stroke * width if fixed_stroke is not None else
                        width / 400 if kind == 'line' else 1)
        font_size = annotation.get('font_size', 12 / 600) * width
        rects = annotation.get("rects", [])
        points = annotation.get("points", [])
        if kind == 'ink' and fixed_stroke is None and points and all('width' in p for p in points):
            stroke_width = max(p['width'] for p in points) * width
        if not rects and points:
            xs, ys = [p["x"] for p in points], [p["y"] for p in points]
            rects = [[min(xs), min(ys), max(xs), max(ys)]]
        if not rects:
            continue
        x0 = min(r[0] for r in rects); y0 = min(r[1] for r in rects)
        x1 = max(r[2] for r in rects); y1 = max(r[3] for r in rects)
        left, top = xy(x0, y0); right, bottom = xy(x1, y1)
        obj = DictionaryObject({NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject({"highlight": "/Highlight", "ink": "/Ink", "rectangle": "/Square", "text": "/FreeText", "line": "/Line"}[kind]),
            NameObject("/Rect"): numbers([left - max(1, width / 300, stroke_width / 2), bottom - max(1, width / 300, stroke_width / 2), right + max(1, width / 300, stroke_width / 2), top + max(1, width / 300, stroke_width / 2)]),
            NameObject("/C"): numbers(rgb), NameObject("/F"): NumberObject(4),
            NameObject("/CA"): FloatObject(opacity),
            NameObject("/Contents"): TextStringObject(annotation.get("text", "")),
            NameObject("/Border"): numbers([0, 0, stroke_width]),
            NameObject("/BS"): DictionaryObject({NameObject('/W'): FloatObject(stroke_width)})})
        if kind == "highlight":
            quads = []
            for r in rects:
                l, t = xy(r[0], r[1]); rr, bb = xy(r[2], r[3])
                quads.extend([l, t, rr, t, l, bb, rr, bb])
            obj[NameObject("/QuadPoints")] = numbers(quads)
        elif kind == "ink":
            obj[NameObject("/InkList")] = ArrayObject([numbers([v for p in points for v in xy(p["x"], p["y"])])])
        elif kind == "line":
            line_start = xy(points[0]['x'], points[0]['y']) if len(points) >= 2 else (left, top)
            line_end = xy(points[-1]['x'], points[-1]['y']) if len(points) >= 2 else (right, bottom)
            obj[NameObject("/L")] = numbers([*line_start, *line_end])
        elif kind == "text":
            obj[NameObject("/DA")] = TextStringObject(' '.join(str(v) for v in rgb) + f' rg /Helv {font_size} Tf')
        elif kind == 'rectangle' and fill_opacity:
            obj[NameObject('/IC')] = numbers(rgb)
        if kind in ('text', 'line', 'ink', 'rectangle', 'highlight'):
            # Explicit appearance streams are required: PDFium does not create
            # a Line appearance, and Helvetica silently drops CJK FreeText.
            ax, ay, ar, at = [float(value) for value in obj['/Rect']]
            aw, ah = ar - ax, at - ay
            appearance = DecodedStreamObject()
            appearance.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Form'),
                               NameObject('/BBox'): numbers([0, 0, aw, ah])})
            if kind == 'text':
                from reportlab.pdfgen import canvas as canvas_module
                from reportlab.pdfbase import pdfmetrics
                from reportlab.pdfbase.cidfonts import UnicodeCIDFont
                with pdf_lock:
                    if 'STSong-Light' not in pdfmetrics.getRegisteredFontNames():
                        pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
                    stream = io.BytesIO()
                    drawing = canvas_module.Canvas(stream, pagesize=(aw, ah))
                    size = font_size
                    drawing.setFont('STSong-Light', size)
                    drawing.setFillColorRGB(*rgb)
                    drawing.setFillAlpha(opacity)
                    y, line = top - ay - size, ''
                    for character in annotation.get('text', '') + '\n':
                        if character == '\n' or pdfmetrics.stringWidth(line + character, 'STSong-Light', size) > max(1, right - left):
                            drawing.drawString(left - ax, y, line)
                            y -= size * 1.2
                            line = '' if character == '\n' else character
                        else:
                            line += character
                    if line:
                        drawing.drawString(left - ax, y, line)
                    drawing.showPage(); drawing.save()
                source = PdfReader(io.BytesIO(stream.getvalue())).pages[0]
                appearance.set_data(source.get_contents().get_data())
                appearance[NameObject('/Resources')] = source['/Resources'].clone(writer)
            else:
                appearance[NameObject('/Resources')] = DictionaryObject({NameObject('/ExtGState'): DictionaryObject({
                    NameObject('/Stroke'): DictionaryObject({NameObject('/CA'): FloatObject(opacity), NameObject('/ca'): FloatObject(opacity)}),
                    NameObject('/Fill'): DictionaryObject({NameObject('/ca'): FloatObject(fill_opacity)}),
                })})
                color_command = ' '.join(str(v) for v in rgb)
                commands = ['q', '/Stroke gs', color_command + ' RG', color_command + ' rg', '1 J 1 j']
                if kind == 'line':
                    commands.extend([f'{stroke_width} w', f'{line_start[0] - ax} {line_start[1] - ay} m {line_end[0] - ax} {line_end[1] - ay} l S'])
                elif kind in ('rectangle', 'highlight'):
                    for r in rects:
                        l, t = xy(r[0], r[1]); rr, bb = xy(r[2], r[3])
                        rectangle = f'{l - ax} {bb - ay} {rr - l} {t - bb} re'
                        if kind == 'highlight':
                            commands.append(f'{rectangle} f')
                        else:
                            if fill_opacity:
                                commands.extend(['q /Fill gs', f'{rectangle} f', 'Q'])
                            commands.extend([f'{stroke_width} w', f'{rectangle} S'])
                elif kind == 'ink':
                    for first, second in zip(points, points[1:]):
                        x0, y0 = xy(first['x'], first['y']); x1, y1 = xy(second['x'], second['y'])
                        segment_width = (fixed_stroke * width if fixed_stroke is not None else
                                         (first['width'] + second['width']) / 2 * width if 'width' in first and 'width' in second else
                                         (1 + second.get('pressure', .5) * 3) * width / 600)
                        commands.extend([f'{segment_width} w', f'{x0 - ax} {y0 - ay} m {x1 - ax} {y1 - ay} l S'])
                appearance.set_data(('\n'.join(commands) + '\nQ').encode('ascii'))
            obj[NameObject('/AP')] = DictionaryObject({NameObject('/N'): writer._add_object(appearance)})
        writer.add_annotation(page_index, obj)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()
