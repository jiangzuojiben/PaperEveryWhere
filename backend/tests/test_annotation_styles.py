"""Offline appearance checks: use PDFium pixels, not a running application."""
import io

import pytest
from PIL import Image, ImageChops
from pypdf import PdfReader, PdfWriter

from backend.pdf import export_annotations, render_page


def annotated(annotation, *, rotate=0):
    writer = PdfWriter()
    page = writer.add_blank_page(width=600, height=600)
    page.rotate(rotate)
    stream = io.BytesIO()
    writer.write(stream)
    output = export_annotations(stream.getvalue(), [{'page': 1, 'color': '#ff0000', **annotation}])
    image = Image.open(io.BytesIO(render_page(output, 1, scale=1))).convert('RGB')
    obj = PdfReader(io.BytesIO(output)).pages[0]['/Annots'][0].get_object()
    return image, obj


def test_rectangle_independent_fill_and_scaled_stroke():
    image, obj = annotated({'type': 'rectangle', 'rects': [[.2, .2, .8, .8]],
                            'fill_opacity': .25, 'stroke_width': .02})
    red, green, blue = image.getpixel((300, 300))
    assert red == 255 and 185 <= green <= 195 and green == blue
    assert image.getpixel((125, 300)) == (255, 0, 0)
    assert image.getpixel((110, 300)) == (255, 255, 255)
    assert float(obj['/BS']['/W']) == 12
    assert '/AP' in obj
    plain, _ = annotated({'type': 'rectangle', 'rects': [[.2, .2, .8, .8]]})
    assert plain.getpixel((300, 300)) == (255, 255, 255)


@pytest.mark.parametrize('rotate', [0, 90, 180, 270])
def test_reverse_diagonal_keeps_point_direction_when_exported(rotate):
    image, obj = annotated({'type': 'line', 'rects': [[.2, .2, .8, .8]],
                            'points': [{'x': .2, 'y': .8}, {'x': .8, 'y': .2}],
                            'stroke_width': .01}, rotate=rotate)
    assert image.getpixel((150, 450)) == (255, 0, 0)
    assert image.getpixel((150, 150)) == (255, 255, 255)
    assert list(obj['/L']) == [120, 120, 480, 480]


def test_highlight_opacity_default_and_override_are_visible():
    default, _ = annotated({'type': 'highlight', 'rects': [[.2, .2, .8, .8]]})
    opaque, _ = annotated({'type': 'highlight', 'rects': [[.2, .2, .8, .8]], 'opacity': 1})
    invisible, _ = annotated({'type': 'highlight', 'rects': [[.2, .2, .8, .8]], 'opacity': 0})
    assert 160 <= default.getpixel((300, 300))[1] <= 170
    assert opaque.getpixel((300, 300)) == (255, 0, 0)
    assert invisible.getpixel((300, 300)) == (255, 255, 255)


def test_explicit_ink_width_retains_thin_and_thick_strokes():
    ink = {'type': 'ink', 'points': [{'x': .2, 'y': .5, 'pressure': 0},
                                    {'x': .8, 'y': .5, 'pressure': 1}]}
    narrow, _ = annotated({**ink, 'stroke_width': .002})
    wide, _ = annotated({**ink, 'stroke_width': .02})
    assert narrow.getpixel((300, 304)) == (255, 255, 255)
    assert wide.getpixel((300, 304)) == (255, 0, 0)


def test_native_point_widths_are_visible_without_clipped_appearance():
    image, obj = annotated({'type':'ink','points':[
        {'x':.2,'y':.5,'pressure':.5,'width':.02},
        {'x':.8,'y':.5,'pressure':.5,'width':.04}]})
    assert image.getpixel((300,307)) == (255,0,0)
    assert image.getpixel((300,311)) == (255,255,255)
    assert float(obj['/BS']['/W']) == 24


def test_cjk_text_size_changes_appearance_and_preserves_text():
    text = {'type': 'text', 'text': '中文注释 Test', 'rects': [[.1, .1, .9, .5]]}
    small, small_obj = annotated({**text, 'font_size': .02})
    large, large_obj = annotated({**text, 'font_size': .06})
    white = Image.new('RGB', small.size, 'white')
    small_box = ImageChops.difference(small, white).getbbox()
    large_box = ImageChops.difference(large, white).getbbox()
    assert large_box[3] - large_box[1] > 2 * (small_box[3] - small_box[1])
    assert large_box[2] - large_box[0] > 2 * (small_box[2] - small_box[0])
    assert str(large_obj['/Contents']) == text['text']
    assert '/Helv 36.0 Tf' in str(large_obj['/DA'])
    assert '/Helv 12.0 Tf' in str(small_obj['/DA'])


@pytest.mark.parametrize('field,value', [
    ('opacity', float('nan')), ('opacity', float('inf')), ('opacity', -.01), ('opacity', 1.01),
    ('fill_opacity', -.01), ('fill_opacity', 1.01), ('fill_opacity', True),
    ('font_size', 0), ('font_size', 1.01), ('font_size', '12'),
    ('stroke_width', 0), ('stroke_width', .10001), ('stroke_width', float('-inf')),
])
def test_style_validation_rejects_nonfinite_and_out_of_contract_values(field, value):
    from fastapi import HTTPException
    from backend.entities import validate_data
    with pytest.raises(HTTPException) as error:
        validate_data(None, None, 'personal', 'annotation', {'page': 1, 'type': 'text', field: value})
    assert error.value.status_code == 422


def test_style_validation_accepts_documented_endpoints_and_existing_annotations():
    from backend.entities import validate_data
    for style in ({}, {'opacity': 0, 'fill_opacity': 1, 'font_size': 1, 'stroke_width': .1}):
        validate_data(None, None, 'personal', 'annotation', {'page': 1, 'type': 'text', **style})
