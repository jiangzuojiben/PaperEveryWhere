"""ReadPaper's upload state machine and native paper-version selection.

Only RAM holds upload bytes and operation tokens. Mutations are never retried.
"""
import hashlib
import secrets

import httpx
import pypdfium2 as pdfium
from fastapi import HTTPException
from .pdf import pdf_lock

APP = '/microService-app-aiKnowledge'
MAX_PDF_BYTES = 256 * 1024 * 1024


def validate_pdf(content, filename):
    if not isinstance(filename, str) or not filename.strip() or len(filename) > 240 or any(c in filename for c in '\r\n/\\\x00'):
        raise HTTPException(422, '无效PDF文件名')
    if not filename.lower().endswith('.pdf'):
        raise HTTPException(422, '请选择PDF文件')
    if not content or len(content) > MAX_PDF_BYTES:
        raise HTTPException(413, 'PDF不能为空且不能超过256MB')
    if not content.startswith(b'%PDF-'):
        raise HTTPException(422, '文件不是PDF')
    try:
        with pdf_lock, pdfium.PdfDocument(content) as document:
            if not len(document): raise ValueError('Empty document')
    except (pdfium.PdfiumError, ValueError) as exc:
        raise HTTPException(422, 'PDF损坏或需要密码，请先解密后上传') from exc


class ReadPaperFiles:
    def _paper_source(self, identifier):
        paper = self.paper(identifier)
        # getDocIndex keeps the collection's PDF id after /pdf/select changes
        # curVersion. The owned document, rather than the selected PDF, grants
        # access to the version collection.
        source = next((doc for doc in self.documents.values()
                       if str(doc['docId']) == paper['data']['source_doc_id']), None)
        if not source:
            raise HTTPException(409, '文献清单已变化，请刷新')
        return source

    def versions(self, identifier):
        source = self._paper_source(identifier)
        paper_id = source.get('paperId')
        if paper_id in (None, '', 0, '0', -1, '-1'):
            return {'supported': False, 'versions': [], 'can_upload': False,
                    'reason': 'ReadPaper未为此独立PDF提供论文版本集合；可单独上传为新文献'}
        raw = self.call('GET', APP+'/aiKnowledge/paper/versions', {'paperId': paper_id}) or {}
        versions = []
        for group in ('publicVersions', 'privateVersions'):
            for version in raw.get(group) or []:
                # External links are not PDF versions and must never be downloaded
                # with the account client or treated as switchable PDF objects.
                if version.get('type') != 1 or not version.get('pdfId'):
                    continue
                versions.append({'pdf_id': str(version['pdfId']), 'title': version.get('name') or 'PDF版本',
                    'date': version.get('datePrefix') or '', 'current': bool(version.get('curVersion')),
                    'latest': bool(version.get('lastVersion')), 'group': 'private' if group == 'privateVersions' else 'public'})
        return {'supported': True, 'versions': versions, 'can_upload': True}

    def select_version(self, identifier, pdf_id):
        source = dict(self._paper_source(identifier))
        versions = self.versions(identifier)
        chosen = next((v for v in versions['versions'] if v['pdf_id'] == pdf_id), None)
        if not chosen:
            raise HTTPException(422, '所选版本不属于此文献的ReadPaper版本集合')
        if not chosen['current']:
            self.call('POST', APP+'/pdf/select', {'paperId': source['paperId'], 'pdfId': pdf_id})
        confirmed = self.versions(identifier)
        if not any(v['pdf_id'] == pdf_id and v['current'] for v in confirmed['versions']):
            raise HTTPException(502, '云端版本切换尚未读回确认，请刷新核对')
        self.release()
        self.index()
        target = next((v for v in self.entries.values() if v['kind'] == 'paper' and
                       v['data']['source_doc_id'] == str(source['docId'])), None)
        if target is None:
            raise HTTPException(502, 'ReadPaper文献归属已变化，请刷新文献库')
        target['data'].update(source_pdf_id=pdf_id)
        target['data'].pop('file_hash', None)
        target['data'].pop('pages', None)
        # A version has its own PDF/note identity. Never carry annotations across.
        return {'paper_id': target['id'], 'entries': list(self.entries.values())}

    def _upload_view(self, operation):
        return {key: value for key, value in operation.items() if key not in ('token','expected_paper_id') and not key.startswith('_')}

    def upload(self, content, filename, folder_id=None, version_of=None):
        validate_pdf(content, filename)
        folder = ''
        if folder_id:
            entry = self.entries.get(folder_id)
            if not entry or entry['kind'] != 'folder': raise HTTPException(422, '目标文件夹不在当前账号')
            folder = folder_id.removeprefix('rp-folder:')
        paper_id = ''
        if version_of:
            if not self.versions(version_of)['can_upload']:
                raise HTTPException(422, '此独立PDF没有ReadPaper论文版本集合，请作为新文献上传')
            paper_id = str(self._paper_source(version_of)['paperId'])
        params = {'groupId': '', 'classifyId': '', 'paperId': paper_id,
                  'scene': 1 if version_of else 0, 'folderId': folder}
        preflight = self.call('POST', APP+'/userDoc/GetPdfNeedUploadPdf',
                              {'md5': hashlib.md5(content).hexdigest(), 'fileName': filename, **params}) or {}
        if len(self.transfers) >= 20:
            removable = next((k for k, v in self.transfers.items() if v['state'] in ('completed', 'duplicate', 'cancelled', 'failed', 'unmatched')), None)
            if removable is None: raise HTTPException(429, '待核对上传过多，请先处理已有上传')
            self.transfers.pop(removable)
        identifier = secrets.token_urlsafe(24)
        operation = {'id': identifier, 'state': 'uploading', 'filename': filename,
                     'sha256': hashlib.sha256(content).hexdigest(), 'paper_id': None, 'token': '', 'expected_paper_id':paper_id}
        self.transfers[identifier] = operation
        if not preflight.get('needUpload'):
            operation['token'] = preflight.get('queryStatusToken') or preflight.get('token') or ''
            if preflight.get('conflictDocInfo'):
                operation['state'] = 'conflict'
            elif preflight.get('docInfo'):
                self._finish_upload(operation, preflight['docInfo'], duplicate=True)
            else:
                operation['state'] = 'pending'
            return self._upload_view(operation)
        try:
            profile = self.call('POST', '/microService-user/user/authorization/getUserInfo', {})
            if not profile.get('accessToken'): raise HTTPException(401, 'ReadPaper上传会话不可用，请重新连接')
            response = self.client.post(APP+'/pdfApi/upload/uploadPdfDoc',
                data={key: str(value) for key, value in params.items()},
                files={'pdfFile': (filename, content, 'application/pdf')},
                headers={'Access-Control-Request-Token': profile['accessToken']}, timeout=90)
            body = response.json()
            if response.status_code >= 400 or body.get('status') != 1 or not isinstance(body.get('data'), str):
                raise HTTPException(502, 'ReadPaper未确认上传，请刷新文献库核对，勿重复提交')
            operation['token'] = body['data']
            operation['state'] = 'processing'
        except (httpx.HTTPError, ValueError, HTTPException) as exc:
            operation['state'] = 'unknown'
            if isinstance(exc, HTTPException): raise
            raise HTTPException(502, '上传结果未知；没有自动重试，请刷新文献库核对') from exc
        return self.upload_status(identifier)

    def _finish_upload(self, operation, doc, duplicate=False):
        pdf_id = str(doc.get('pdfId') or '')
        if not pdf_id: raise HTTPException(502, '云端上传结果缺少PDF标识')
        operation.update(_pdf_id=pdf_id, pdf_id=pdf_id, _duplicate=duplicate)
        self.index()
        target = next((v for v in self.entries.values() if v['kind'] == 'paper' and v['data']['source_pdf_id'] == pdf_id), None)
        expected = operation.get('expected_paper_id')
        if target is None and expected:
            candidates = [v for v in self.entries.values() if v['kind'] == 'paper' and v['data'].get('source_paper_id') == expected]
            target = next((v for v in candidates if any(item['pdf_id'] == pdf_id for item in self.versions(v['id'])['versions'])), None)
        if target is None:
            operation['state'] = 'processing'
            return
        if expected:
            if target['data'].get('source_paper_id') != expected:
                operation.update(state='unmatched',paper_id=target['id'],token='',
                                 reason='文件已被云端收录，但未匹配目标论文，未建立所选论文的新版本')
                return
            if not any(v['pdf_id'] == pdf_id for v in self.versions(target['id'])['versions']):
                operation['state'] = 'processing'
                return
        operation.update(state='duplicate' if duplicate else 'completed', paper_id=target['id'], token='')

    def upload_status(self, identifier):
        operation = self.transfers.get(identifier)
        if not operation: raise HTTPException(404, '上传不属于本次会话')
        if operation['state'] == 'processing' and not operation['token'] and operation.get('_pdf_id'):
            self._finish_upload(operation, {'pdfId':operation['_pdf_id']}, duplicate=operation.get('_duplicate',False))
        if operation['state'] in ('completed', 'duplicate', 'cancelled', 'failed', 'conflict', 'unmatched') or not operation['token']:
            return self._upload_view(operation)
        result = self.call('POST', APP+'/userDoc/GetUserDocCreateStatus', {'token': operation['token']}) or {}
        state = result.get('status')
        if state in (3, 7, 8) and result.get('docInfo'):
            self._finish_upload(operation, result['docInfo'])
        elif state == 6:
            operation['state'] = 'conflict'
        elif state == 5:
            operation.update(state='cancelled', token='')
        elif state in (4, 9, 10):
            operation.update(state='failed', token='')
        else:
            operation['state'] = 'processing'
        return self._upload_view(operation)

    def resolve_upload(self, identifier, keep_existing):
        operation = self.transfers.get(identifier)
        if not operation or operation['state'] != 'conflict' or not operation['token']:
            raise HTTPException(409, '此上传没有待处理的云端冲突')
        result = self.call('POST', APP+'/userDoc/resolveConflict', {'token': operation['token'], 'useOrigin': keep_existing}) or {}
        if not result.get('docInfo'): raise HTTPException(502, '云端冲突处理结果尚未确认，请刷新核对')
        self._finish_upload(operation, result['docInfo'], duplicate=keep_existing)
        return self._upload_view(operation)

    def cancel_upload(self, identifier):
        operation = self.transfers.get(identifier)
        if not operation: raise HTTPException(404, '上传不属于本次会话')
        if operation['state'] in ('completed', 'duplicate', 'cancelled', 'failed', 'unmatched'): return self._upload_view(operation)
        if not operation['token']: raise HTTPException(409, '上传结果未知，请刷新文献库核对')
        result = self.call('POST', APP+'/userDoc/cancelUserDocCreate', {'token': operation['token']}) or {}
        if result.get('nextStatus') == 5:
            operation.update(state='cancelled', token='')
        else:
            self.upload_status(identifier)
        return self._upload_view(operation)
