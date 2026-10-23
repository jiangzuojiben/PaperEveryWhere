"""ReadPaper transport and page-coordinate adapter. All state is session memory.

No database, filesystem cache, retries of mutations, or ReadPaper AI calls.
Endpoint contracts are independently implemented from the retained research.
"""
from collections import defaultdict
from contextlib import closing
import copy
import hashlib
import json
import math
from urllib.parse import urlsplit

import httpx
import pypdfium2 as pdfium
from fastapi import HTTPException
from .pdf import pdf_lock
from .readpaper_files import ReadPaperFiles
from .readpaper_ink import decode_drawings

APP = '/microService-app-aiKnowledge'
DOC = '/microservice-readpaper-doc'
NOTE = '/microservice-note'
COLORS = {1: '#338AFF', 2: '#80E639', 3: '#FFFF00', 4: '#FF8C19', 5: '#F24030'}
SHAPE_COLORS = {1: '#1F71E0', 2: '#FFC53D', 3: '#E66045', 4: '#73D13D', 5: '#262625'}


def fingerprint(value):
    return int(hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12], 16)


def entity(identifier, kind, data, raw=None):
    return {'id': identifier, 'kind': kind, 'scope': 'personal', 'revision': fingerprint(raw if raw is not None else data),
            'data': data, 'deleted': False}


def rotate_rect(x, y, width, height, page_width, page_height, rotation):
    if rotation == 90:
        return page_height-y-height, x, height, width
    if rotation == 180:
        return page_width-x-width, page_height-y-height, width, height
    if rotation == 270:
        return y, page_width-x-width, height, width
    return x, y, width, height


def rect_to_normal(rect, geometry, source_unrotated=True):
    w, h, rotation = geometry
    x, y, rw, rh = (float(rect[k]) for k in ('x', 'y', 'width', 'height'))
    if source_unrotated:
        ow, oh = (h, w) if rotation in (90, 270) else (w, h)
        x, y, rw, rh = rotate_rect(x, y, rw, rh, ow, oh, rotation)
    result = [x/w, y/h, (x+rw)/w, (y+rh)/h]
    if rw <= 0 or rh <= 0 or any(not math.isfinite(v) or v < -1e-6 or v > 1.000001 for v in result):
        raise ValueError('Unsupported annotation rectangle')
    return [min(1, max(0, v)) for v in result]


def normal_to_rect(rect, geometry, page, unrotate=True):
    if not isinstance(rect, list) or len(rect) != 4 or any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1 for v in rect):
        raise HTTPException(422, '批注矩形必须为页面内归一化坐标')
    l, t, r, b = rect
    if r <= l or b <= t:
        raise HTTPException(422, '批注矩形不能为空')
    w, h, rotation = geometry
    x, y, rw, rh = l*w, t*h, (r-l)*w, (b-t)*h
    if unrotate:
        x, y, rw, rh = rotate_rect(x, y, rw, rh, w, h, (360-rotation) % 360)
    return {'x': x, 'y': y, 'width': rw, 'height': rh, 'pageNumber': page, 'rotation': 0}


def nearest_color(color, palette):
    if not isinstance(color, str) or len(color) != 7 or not color.startswith('#'):
        raise HTTPException(422, '无效批注颜色')
    try:
        rgb = tuple(int(color[i:i+2], 16) for i in (1, 3, 5))
    except ValueError as exc:
        raise HTTPException(422, '无效批注颜色') from exc
    return min(palette, key=lambda k: sum((a-int(palette[k][i:i+2], 16))**2 for a, i in zip(rgb, (1, 3, 5))))


class ReadPaper(ReadPaperFiles):
    def __init__(self, cookies, *, client=None, cdn=None):
        self.client = client or httpx.Client(base_url='https://readpaper.com/api', timeout=35, follow_redirects=False)
        self.cdn = cdn or httpx.Client(timeout=90, follow_redirects=False)
        self.client.headers.update({'Authorization': 'Basic YWlLbm93bGVkZ2U6cmVhZHBhcGVyX2NvbQ==',
                                    'Origin': 'https://readpaper.com', 'Referer': 'https://readpaper.com/', 'i18n': 'zh'})
        for key in ('aiKnowledge-token', 'aiKnowledge-UID'):
            if cookies.get(key):
                self.client.cookies.set(key, cookies[key], domain='readpaper.com', path='/')
        self.entries = {}
        self.documents = {}
        self.contexts = {}
        self.active = None
        self.pdf_bytes = None
        self.geometries = []
        self.sources = {}
        self.unrepresented = []
        self.transfers = {}

    def close(self):
        self.client.cookies.clear()
        self.client.close()
        self.cdn.close()
        self.entries.clear(); self.documents.clear(); self.contexts.clear(); self.sources.clear()
        self.pdf_bytes = None; self.geometries = []; self.active = None; self.unrepresented.clear()
        self.transfers.clear()

    def call(self, method, path, data=None):
        try:
            args = {'params': data or {}} if method == 'GET' else {'json': {'orgId': '535992339879038976', 'appId': 'aiKnowledge', **(data or {})}}
            response = self.client.request(method, path, **args)
            body = response.json()
            if response.status_code == 401 or body.get('code') in (1000, 50008, 50010, 50011, 50012, 50014):
                raise HTTPException(401, 'ReadPaper 登录已失效，请重新连接')
            if response.status_code >= 400 or body.get('status') != 1:
                raise HTTPException(502, 'ReadPaper 未确认操作成功；请刷新核对，勿重复提交')
            return body.get('data')
        except (httpx.HTTPError, ValueError) as exc:
            # Exception strings may contain signed URLs or upstream response bodies.
            raise HTTPException(502, 'ReadPaper 请求失败，未确认保存；请刷新核对，勿重复提交') from exc

    def index(self):
        index = self.call('POST', DOC+'/userDoc/getDocIndex')
        entries, documents, memberships = {}, {}, defaultdict(list)

        def walk(items, parent=None):
            for folder in items or []:
                fid = 'rp-folder:'+str(folder['folderId'])
                entries[fid] = entity(fid, 'folder', {'title': folder['name'], 'parent_id': parent})
                for doc in folder.get('docInfos') or []:
                    pid = str(doc['pdfId']); documents[pid] = doc; memberships[pid].append(fid)
                walk(folder.get('childrenFolders'), fid)
        walk(index.get('folderInfos'))
        for doc in index.get('unclassifiedDocInfos') or []:
            documents[str(doc['pdfId'])] = doc
        if len(documents) != index.get('totalDocCount'):
            raise HTTPException(502, 'ReadPaper 文献清单不完整，请刷新重试')
        for pid, doc in documents.items():
            key = 'rp-paper:'+pid
            previous = self.entries.get(key, {}).get('data', {})
            entries[key] = entity(key, 'paper', {**previous, 'title': doc['docName'], 'filename': doc['docName'],
                'source_pdf_id': previous.get('source_pdf_id', pid) if self.active == key else pid,
                'source_doc_id': str(doc['docId']), 'authors': previous.get('authors', []),
                'source_paper_id': str(doc.get('paperId') or ''),
                'folder_ids': memberships[pid], 'folder_id': memberships[pid][0] if memberships[pid] else None,
                'tags': previous.get('tags', []), 'status': '阅读中' if self.active == key else '未读',
                'storage': 'readpaper-cloud'})
        # Keep only active reader details, never resurrect a deleted cloud paper.
        if self.active in entries:
            entries.update({k: v for k, v in self.entries.items() if v['kind'] not in ('paper', 'folder') and v['data'].get('paper_id') == self.active})
        self.entries, self.documents = entries, documents
        return list(entries.values())

    def paper(self, identifier):
        paper = self.entries.get(identifier)
        if not paper or paper['kind'] != 'paper':
            raise HTTPException(404, '此文献不在当前 ReadPaper 账号中')
        return paper

    def prepare(self, identifier):
        paper = self.paper(identifier)
        if self.active == identifier and self.pdf_bytes is not None:
            return
        self.release()
        pid = paper['data']['source_pdf_id']
        versions = self.versions(identifier)
        current = [v['pdf_id'] for v in versions['versions'] if v['current']]
        if len(set(current)) > 1:
            raise HTTPException(502, 'ReadPaper返回多个当前版本，请刷新核对')
        if current:
            pid = current[0]
        context = self.call('POST', APP+'/paperNote/getOwnerPaperNoteBaseInfo', {'pdfId': pid})
        if str(context.get('pdfId')) != pid or not context.get('noteId'):
            raise HTTPException(502, 'ReadPaper 文献上下文不匹配')
        # The note context's URL can still reference the previous version.
        # The reference reader separately resolves access for the selected PDF.
        status = self.call('POST', APP+'/aiKnowledge/pdf/getPdfStatusInfo/v2',
                           {'pdfId': pid, 'noteId': context['noteId']}) or {}
        if status.get('hasPdfAccessFlag') is not True:
            raise HTTPException(403, 'ReadPaper未授予此版本PDF的读取权限')
        url = status.get('pdfUrl', '')
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or parsed.hostname not in ('pdf.cdn.readpaper.com', 'pdf2.cdn.readpaper.com') or parsed.username:
            raise HTTPException(502, 'ReadPaper 文件地址不可用')
        try:
            # Separate client: no account cookies or application header on CDN.
            with self.cdn.stream('GET', url) as response:
                response.raise_for_status()
                content = bytearray()
                for chunk in response.iter_bytes(1024*1024):
                    content.extend(chunk)
                    if len(content) > 256*1024*1024:
                        raise HTTPException(413, '此在线会话最多读取256MB的PDF')
            content = bytes(content)
            if not content.startswith(b'%PDF-'):
                raise HTTPException(502, 'ReadPaper 返回的文件不是PDF')
            with pdf_lock, pdfium.PdfDocument(content) as doc:
                geometries = []
                for i in range(len(doc)):
                    with closing(doc[i]) as page:
                        geometries.append((*page.get_size(), page.get_rotation()))
        except (httpx.HTTPError, pdfium.PdfiumError, ValueError) as exc:
            raise HTTPException(502, 'PDF读取失败，请重新连接文献') from exc
        self.active, self.pdf_bytes, self.geometries = identifier, content, geometries
        self.contexts[identifier] = {k: context[k] for k in ('noteId', 'pdfId')}
        self.contexts[identifier]['multiple_versions'] = len(versions['versions']) > 1
        paper['data'].update(source_pdf_id=pid, file_hash=hashlib.sha256(content).hexdigest(), pages=len(geometries))
        self.entries[identifier] = entity(identifier, 'paper', paper['data'])

    def release(self):
        self.entries = {k: v for k, v in self.entries.items() if v['kind'] in ('paper', 'folder')}
        for entry in self.entries.values():
            if entry['kind'] == 'paper':
                entry['data'].pop('full_text', None)
        self.contexts.clear(); self.sources.clear(); self.unrepresented.clear()
        self.pdf_bytes = None; self.geometries = []; self.active = None

    def geometry(self, page):
        if type(page) is not int or not 1 <= page <= len(self.geometries):
            raise HTTPException(422, '批注页码超出PDF范围')
        return self.geometries[page-1]

    def annotations(self):
        identifier = self.active; context = self.contexts[identifier]
        digest = self.paper(identifier)['data']['file_hash']
        marks = self.call('GET', APP+'/pdfMark/v3/web/getByNote', {'noteId': context['noteId'], 'handtext': 'true'}) or []
        shapes = self.call('POST', NOTE+'/noteShape/getList', {'noteId': context['noteId']}) or {}
        drawings = self.call('GET', APP+'/pdfMark/v3/web/draw/getByNote', {'noteId': context['noteId'], 'fetchAll': 'true', 'handwrite': 'true'}) or []
        entries, sources, unsupported = {}, {}, []
        if context.get('multiple_versions'):
            unsupported.append({'kind': 'version', 'message': 'ReadPaper可能在论文版本间共享笔记和批注；切换后请核对原批注位置。'})
        for index, raw in enumerate(marks):
            part = raw.get('select') or raw.get('rect') or raw.get('textBox') or {}
            sid = str(part.get('uuid') or part.get('id') or '')
            page = raw.get('pageNumber')
            try:
                geometry = self.geometry(page); w, h, _ = geometry
                data = {'paper_id': identifier, 'file_hash': digest, 'page': page, 'rects': [], 'points': [],
                        'text': part.get('idea') or part.get('rectStr') or '', 'cloud_id': sid, 'cloud_type': 'mark',
                        'text_anchor': part.get('rectStr', '')}
                if not sid:
                    raise ValueError('no mark identity')
                if raw['type'] in (0, 1):
                    rects = part.get('rectangle') or []
                    if isinstance(rects, dict): rects = [rects]
                    if not rects: raise ValueError('no_geometry')
                    pages = {r.get('pageNumber', page) for r in rects}
                    if pages != {page}: raise ValueError('cross-page source requires grouped editing')
                    data.update(type='highlight' if raw['type'] == 0 else 'rectangle', color=COLORS[part['styleId']],
                                rects=[rect_to_normal(r, geometry) for r in rects])
                    if raw['type'] == 0: data['opacity'] = .3
                    else: data.update(fill_opacity=.1, stroke_width=1/w)
                elif raw['type'] == 4:
                    fonts = part['fonts']; font = fonts[0]
                    if len(fonts) != 1: raise ValueError('mixed text styles')
                    data.update(type='text', color=font['color'], text=font['content'], font_size=font['fontSize']/950,
                        rects=[rect_to_normal({**part, 'width': part['width']*w/950/1.2, 'height': part['height']*w/950/1.2}, geometry, False)])
                else:
                    raise ValueError('legacy drawing')
                key = 'rp-mark:'+sid
                entries[key] = entity(key, 'annotation', data, raw)
                sources[key] = copy.deepcopy(raw)
            except (ValueError, KeyError, TypeError, HTTPException):
                unsupported.append({'page': page, 'cloud_id': sid, 'kind': 'mark', 'message': '原批注保留云端；此记录暂不能绘制',
                                    'text': part.get('idea') or part.get('rectStr') or ''})
        for shape in shapes.get('list') or []:
            try:
                page = shape['pageNumber']; geo = self.geometry(page); w, h, _ = geo
                key = 'rp-shape:'+str(shape['shapeId'])
                data = {'paper_id': identifier, 'file_hash': digest, 'page': page, 'rects': [], 'points': [], 'text': '',
                        'cloud_id': str(shape['shapeId']), 'cloud_type': 'shape', 'color': SHAPE_COLORS[shape['strokeColor']], 'stroke_width': 1.5/w}
                if shape['type'] == 0:
                    data.update(type='rectangle', rects=[rect_to_normal(shape, geo, False)])
                elif shape['type'] == 2:
                    from math import hypot
                    x, y, ex, ey = [float(shape[k]) for k in ('x', 'y', 'endX', 'endY')]
                    length = hypot(ex-x, ey-y)
                    if not length: raise ValueError('empty arrow')
                    ux, uy, wing = (ex-x)/length, (ey-y)/length, min(8, length/3)
                    pts = [(x,y),(ex,ey),(ex-wing*ux+wing*.5*uy,ey-wing*uy-wing*.5*ux),(ex,ey),(ex-wing*ux-wing*.5*uy,ey-wing*uy+wing*.5*ux)]
                    data.update(type='ink', points=[{'x': px/w, 'y': py/h, 'pressure': .5} for px, py in pts])
                else: raise ValueError('unsupported shape')
                entries[key] = entity(key, 'annotation', data, shape); sources[key] = copy.deepcopy(shape)
            except (ValueError, KeyError, TypeError, HTTPException):
                unsupported.append({'page': shape.get('pageNumber'), 'kind': 'shape', 'message': '原图形保留云端；此记录暂不能绘制'})
        ink, ink_sources, ink_warnings = decode_drawings(drawings, self.geometry, identifier, digest, entity)
        entries.update(ink); sources.update(ink_sources); unsupported.extend(ink_warnings)
        self.entries = {k: v for k, v in self.entries.items() if v['kind'] != 'annotation'}
        self.entries.update(entries); self.sources = sources; self.unrepresented = unsupported
        return list(entries.values())

    def details(self, identifier):
        self.prepare(identifier)
        context = self.contexts[identifier]
        self.annotations()
        summary = self.call('POST', APP+'/paperNote/summary/getByNoteId', {'noteId': context['noteId']}) or {}
        key = 'rp-summary:'+context['pdfId']
        self.entries[key] = entity(key, 'note', {'paper_id': identifier, 'title': 'ReadPaper 阅读笔记', 'category': 'summary',
                                                   'content': summary.get('content') or '', 'cloud_type': 'summary'}, summary.get('content') or '')
        location = self.call('POST', APP+'/noteReadLocation/getLocation', {'noteId': context['noteId']}) or {}
        try: page = json.loads(location.get('location') or '{}').get('currentPage', 1)
        except (ValueError, TypeError): page = 1
        if type(page) is not int or not 1 <= page <= len(self.geometries): page = 1
        key = 'rp-progress:'+context['pdfId']
        self.entries[key] = entity(key, 'progress', {'paper_id': identifier, 'page': page, 'file_hash': self.paper(identifier)['data']['file_hash'],
            'total_pages': len(self.geometries), 'device': 'readpaper-cloud', 'date': '2000-01-01T00:00:00Z'})
        return {'entries': [v for v in self.entries.values() if v['id'] == identifier or v['data'].get('paper_id') == identifier],
                'unsupported': list(self.unrepresented)}

    def write(self, kind, data, identifier=None, base_revision=None, deleted=False):
        paper_id = data.get('paper_id')
        if self.active != paper_id or paper_id not in self.contexts:
            raise HTTPException(409, '阅读会话已变化，请重新打开文献')
        context = self.contexts[paper_id]
        if data.get('file_hash') and data['file_hash'] != self.paper(paper_id)['data']['file_hash']:
            raise HTTPException(409, 'PDF版本已变化，请重新打开文献')
        if kind == 'progress':
            page = data.get('page'); self.geometry(page)
            self.call('POST', APP+'/noteReadLocation/record', {'noteId': context['noteId'], 'location': json.dumps({'currentPage': page, 'currentGroupId': ''})})
            confirmed = self.call('POST', APP+'/noteReadLocation/getLocation', {'noteId': context['noteId']}) or {}
            try: confirmed_page = json.loads(confirmed.get('location') or '{}').get('currentPage')
            except (ValueError, TypeError): confirmed_page = None
            if confirmed_page != page:
                raise HTTPException(502, 'ReadPaper尚未读回目标进度，请刷新核对，勿重复提交')
            result = entity('rp-progress:'+context['pdfId'], kind, {**data, 'device': 'readpaper-cloud'})
        elif kind == 'note':
            key = 'rp-summary:'+context['pdfId']
            if identifier and identifier != key:
                raise HTTPException(422, 'ReadPaper每篇使用一份阅读笔记，请编辑现有阅读笔记')
            raw = self.call('POST', APP+'/paperNote/summary/getByNoteId', {'noteId': context['noteId']}) or {}
            if base_revision is None or fingerprint(raw.get('content') or '') != base_revision:
                raise HTTPException(409, '云端笔记已变化，当前草稿尚未保存，请复制草稿后刷新')
            content = '' if deleted else data.get('content', '')
            if not isinstance(content, str) or len(content) > 500000:
                raise HTTPException(422, '笔记内容过大或无效')
            self.call('POST', APP+'/paperNote/summary/saveOrUpdate', {'noteId': context['noteId'], 'content': content})
            confirmed = self.call('POST', APP+'/paperNote/summary/getByNoteId', {'noteId': context['noteId']}) or {}
            if (confirmed.get('content') or '') != content:
                raise HTTPException(502, 'ReadPaper尚未读回目标笔记，请保留草稿并刷新核对')
            result = entity(key, kind, {**data, 'title': 'ReadPaper 阅读笔记', 'category': 'summary', 'content': content}, content)
        elif kind == 'annotation':
            self.annotations()  # Check the latest cloud snapshot before mutating.
            existing = self.entries.get(identifier)
            if identifier and not existing:
                raise HTTPException(409, '云端批注已删除，请刷新')
            if existing and (base_revision is None or existing['revision'] != base_revision):
                raise HTTPException(409, '云端批注已变化，请刷新后重试')
            if deleted:
                raw = self.sources[identifier]
                if existing['data']['cloud_type'] == 'shape':
                    self.call('POST', NOTE+'/noteShape/delete', {'shapeIds': [str(raw['shapeId'])]})
                elif existing['data']['cloud_type'] == 'handwriting':
                    self.call('DELETE', APP+'/pdfMark/v2/web/pencil/batch/delete', {'id': [existing['data']['cloud_id']]})
                else:
                    sid = existing['data']['cloud_id']
                    self.call('DELETE', APP+'/pdfMark/v2/web/delete', {'id': sid, 'annotationId': sid, 'noteId': context['noteId']})
                self.annotations()
                if identifier in self.entries:
                    raise HTTPException(502, 'ReadPaper仍返回原批注，删除尚未确认；请刷新核对')
                result = {**existing, 'deleted': True}
            else:
                page = data.get('page'); geometry = self.geometry(page)
                rects = data.get('rects') or []
                typ = data.get('type'); text = data.get('text', '')
                if typ not in ('highlight', 'rectangle', 'text') or not rects:
                    raise HTTPException(422, '当前ReadPaper桥接支持文字高亮、矩形和文本框；手写/直线写入尚未验证')
                if not isinstance(text, str) or len(text) > 100000:
                    raise HTTPException(422, '批注文字过大或无效')
                if typ != 'highlight' and len(rects) != 1:
                    raise HTTPException(422, '此类批注需要一个矩形')
                if len(rects) > 2000:
                    raise HTTPException(422, '单条高亮的选区过多')
                font = data.get('font_size', 12/600)
                if type(font) not in (int, float) or not math.isfinite(font) or not 0 < font <= 1:
                    raise HTTPException(422, '无效文本框字号')
                color = nearest_color(data.get('color', '#FFFF00'), COLORS)
                expected_color = COLORS[color]
                payload = {'noteId': context['noteId'], 'pdfId': context['pdfId'], 'pageNumber': page,
                           'position': -1, 'markIdsOfCurrentPage': [], 'type': {'highlight': 0, 'rectangle': 1, 'text': 4}[typ]}
                raw_rects = [normal_to_rect(r, geometry, page, typ != 'text') for r in rects]
                if typ == 'highlight':
                    payload.update(isHighlight=False, select={'documentId': context['noteId'], 'rectangle': raw_rects,
                        'rectStr': data.get('text_anchor') or text, 'idea': text if data.get('text_anchor') else '', 'styleId': color})
                elif typ == 'rectangle':
                    payload['rect'] = {'documentId': context['noteId'], 'rectangle': raw_rects[0], 'styleId': color, 'idea': text}
                else:
                    r = raw_rects[0]; width = geometry[0]
                    payload['textBox'] = {**r, 'id': '', 'width': r['width']*950*1.2/width,
                        'height': r['height']*950*1.2/width, 'borderColor': '',
                        'fonts': [{'content': text, 'fontSize': font*950, 'color': COLORS[color]}]}
                if existing:
                    if existing['data']['cloud_type'] == 'shape':
                        if typ != 'rectangle': raise HTTPException(422, '不可改变原图形类型')
                        if text != existing['data']['text']:
                            raise HTTPException(422, '原图形暂无文字备注写入契约，未保存修改')
                        shape = {**self.sources[identifier], **normal_to_rect(rects[0], geometry, page, False),
                                 'strokeColor': nearest_color(data.get('color'), SHAPE_COLORS)}
                        expected_color = SHAPE_COLORS[shape['strokeColor']]
                        self.call('POST', NOTE+'/noteShape/update', {'annotations': [shape]})
                    else:
                        part_name = {'highlight': 'select', 'rectangle': 'rect', 'text': 'textBox'}[typ]
                        original = self.sources[identifier]
                        if original['type'] != payload['type']: raise HTTPException(422, '不可改变原批注类型')
                        payload[part_name] = {**original.get(part_name, {}), **payload[part_name]}
                        payload[part_name]['id' if typ == 'text' else 'uuid'] = existing['data']['cloud_id']
                        self.call('PUT', APP+'/pdfMark/v2/web/update', payload)
                    key = identifier
                else:
                    sid = self.call('POST', APP+'/pdfMark/v2/web/save', payload)
                    if not isinstance(sid, (str, int)) or isinstance(sid, bool) or not str(sid):
                        raise HTTPException(502, 'ReadPaper未返回批注标识，请刷新核对，勿重复提交')
                    key = 'rp-mark:'+str(sid)
                self.annotations()
                if key not in self.entries:
                    raise HTTPException(502, 'ReadPaper已响应但尚未读回批注，请刷新核对，勿重复提交')
                result = self.entries[key]
                actual = result['data']
                expected_text = (text or data.get('text_anchor', '')) if typ == 'highlight' else text
                geometry_matches = len(actual['rects']) == len(rects) and all(
                    abs(a-b) <= 1e-5 for actual_rect, wanted_rect in zip(actual['rects'], rects)
                    for a, b in zip(actual_rect, wanted_rect))
                if (actual['type'] != typ or actual['page'] != page or actual['color'].lower() != expected_color.lower()
                        or actual['text'] != expected_text or not geometry_matches
                        or (typ == 'text' and abs(actual['font_size']-font) > 1e-6)):
                    raise HTTPException(502, 'ReadPaper读回内容尚未匹配本次修改，请刷新核对，勿重复提交')
        else:
            raise HTTPException(422, '此操作的ReadPaper云端写入尚未适配，未保存本地副本')
        self.entries[result['id']] = result
        return result
