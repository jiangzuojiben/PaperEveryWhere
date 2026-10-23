"""Decode native webDrawV2 data using the reference renderer's 950-unit grid.

Creation is deliberately not inferred from this read model. Eraser/clip records
are fail-closed: rendering pre-erasure strokes would fabricate visible ink.
"""
import math
from fastapi import HTTPException


def decode_drawings(drawings, geometry, paper_id, file_hash, make_entity):
    entries, sources, warnings = {}, {}, []
    pages_with_erasures = set()
    for wrapper in drawings:
        draw = wrapper.get('webDrawV2') or {}
        if any(s.get('erase') or s.get('tooltype') == 4 for s in draw.get('webDrawItems') or []):
            pages_with_erasures.add(draw.get('pageNumber', wrapper.get('pageNumber')))
    for wrapper in drawings:
        draw = wrapper.get('webDrawV2') or {}
        page = draw.get('pageNumber', wrapper.get('pageNumber'))
        if not draw or page in pages_with_erasures:
            warnings.append({'kind':'handwriting','page':page,'message':'原手写含擦除/剪裁或缺少路径结构，保留云端，暂不绘制'})
            continue
        for stroke in draw.get('webDrawItems') or []:
            sid = str(stroke.get('id') or '')
            try:
                w, h, _ = geometry(page)
                if not sid or stroke.get('tooltype') not in (1, 2) or stroke.get('drawShapeType', 0) not in (0, 6):
                    raise ValueError('Unsupported native ink tool')
                original = stroke.get('points') or []
                if not original or len(original) > 100000: raise ValueError('Invalid native point count')
                color = stroke['lineHexColor']
                if not isinstance(color, str) or len(color) != 7 or color[0] != '#': raise ValueError('Invalid ink color')
                int(color[1:], 16)
                opacity = float(stroke.get('lineAlpha', 1))
                width = float(stroke.get('lineWidth', 0))/950
                if not math.isfinite(opacity) or not 0 <= opacity <= 1 or not math.isfinite(width) or not 0 <= width <= .1:
                    raise ValueError('Invalid native style')
                points = []
                for point in original:
                    x, y = float(point['x'])/950, float(point['y'])/950*w/h
                    pressure = float(point.get('pressure', .5))
                    if not all(math.isfinite(v) for v in (x, y, pressure)) or not (0 <= x <= 1 and 0 <= y <= 1 and 0 <= pressure <= 1):
                        raise ValueError('Native point outside page')
                    converted = {'x':x, 'y':y}
                    if 'pressure' in point: converted['pressure'] = pressure
                    if width == 0:
                        size = point.get('size') or {}
                        thickness = math.hypot(float(size['width']), float(size['height']))/950
                        if isinstance(point.get('altitude'), (int, float)): thickness /= 2
                        if not math.isfinite(thickness) or not 0 < thickness <= .1: raise ValueError('Invalid point width')
                        converted['width'] = thickness
                    points.append(converted)
                if len(points) == 1: points.append(dict(points[0]))
                data = {'paper_id':paper_id, 'file_hash':file_hash, 'page':page, 'type':'ink',
                        'color':color, 'opacity':opacity, 'points':points, 'rects':[], 'text':'',
                        'cloud_type':'handwriting', 'cloud_id':sid}
                if width: data['stroke_width'] = width
                key = 'rp-ink:'+sid
                entries[key] = make_entity(key, 'annotation', data, stroke)
                sources[key] = stroke
            except (ValueError, KeyError, TypeError, OverflowError, HTTPException):
                # Geometry rejects invalid pages with HTTPException. Never log
                # raw source records or infer substitute coordinates.
                warnings.append({'kind':'handwriting','page':page,'message':'原手写路径或样式暂不能安全转换，数据保留云端'})
    return entries, sources, warnings
