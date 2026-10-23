from contextlib import closing
from email.parser import BytesParser
from email import policy
import hashlib
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import cloud_main as cloud
from backend.readpaper import APP, DOC
from backend.tests.test_cloud_bridge import Upstream, HEADERS
from scripts.verify_readpaper_live import fixture


class FilesUpstream(Upstream):
    def __init__(self):
        super().__init__()
        self.version2 = fixture(2)
        self.current_pdf = '1'
        self.uploaded = False
        self.multipart_count = 0
        self.token_checks = 0
        self.fail_upload = False
        self.conflict = False
        self.cancelled = False
        self.ink = []
        self.selections = 0
        self.match_upload = False
        self.shared_note = False

    def respond(self, request):
        path = request.url.path.removeprefix('/api')
        if path == APP+'/pdfApi/upload/uploadPdfDoc':
            self.multipart_count += 1
            assert request.headers['access-control-request-token'] == 'upload-session-private'
            if self.fail_upload: raise httpx.ReadTimeout('must-not-leak-token')
            message = BytesParser(policy=policy.default).parsebytes(
                b'Content-Type: '+request.headers['content-type'].encode()+b'\r\n\r\n'+request.content)
            pdf = next(part for part in message.iter_parts() if part.get_param('name', header='content-disposition') == 'pdfFile')
            assert pdf.get_payload(decode=True) == self.version2
            return httpx.Response(200, json={'status':1,'data':'private-upload-token'})
        body = json.loads(request.content) if request.content else {}
        if path == DOC+'/userDoc/getDocIndex':
            # Actual cloud behaviour: collection index is stable across select.
            docs = [{'pdfId':'1','docId':'d1','docName':'Online paper.pdf','paperId':'100'}]
            if self.uploaded and not self.match_upload: docs.append({'pdfId':'3','docId':'d3','docName':'New 中文.pdf','paperId':'-1'})
            result = {'totalDocCount':len(docs),'folderInfos':[{'folderId':'1','name':'Physics','docInfos':docs}], 'unclassifiedDocInfos':[]}
        elif path.endswith('/getUserInfo'): result = {'accessToken':'upload-session-private'}
        elif path.endswith('/GetPdfNeedUploadPdf'):
            result = {'needUpload':False,'docInfo':{'pdfId':'1'}} if body['md5'] == hashlib.md5(self.content).hexdigest() else {'needUpload':True}
        elif path.endswith('/GetUserDocCreateStatus'):
            assert body['token'] == 'private-upload-token'
            self.token_checks += 1
            if self.cancelled: result = {'status':5}
            elif self.conflict: result = {'status':6}
            elif self.token_checks < 2: result = {'status':2}
            else:
                self.uploaded = True
                if self.match_upload: self.current_pdf = '3'
                result = {'status':3,'docInfo':{'pdfId':'3'}}
        elif path.endswith('/cancelUserDocCreate'):
            self.cancelled = True; result = {'nextStatus':5}
        elif path.endswith('/resolveConflict'):
            assert body['useOrigin'] is True
            self.uploaded = True; result = {'docInfo':{'pdfId':'3'}}
        elif path.endswith('/aiKnowledge/paper/versions'):
            result = {'publicVersions':[
                {'pdfId':pid,'type':1,'name':'Version '+pid,'curVersion':pid==self.current_pdf}
                for pid in (('1','2','3') if self.uploaded and self.match_upload else ('1','2'))],
                'privateVersions':[{'type':0,'jumpUrl':'https://untrusted.invalid/','name':'External link'}]}
        elif path == APP+'/pdf/select':
            assert body['paperId'] == '100'; self.current_pdf = str(body['pdfId']); self.selections += 1; result = {}
        elif path.endswith('/getOwnerPaperNoteBaseInfo'):
            pid = body['pdfId']; result = {'pdfId':pid,'noteId':'note1' if self.shared_note else 'note'+pid,'pdfUrl':'https://pdf.cdn.readpaper.com/1.pdf'}
        elif path.endswith('/getPdfStatusInfo/v2'):
            result = {'hasPdfAccessFlag': True, 'pdfUrl':'https://pdf.cdn.readpaper.com/'+body['pdfId']+'.pdf'}
        elif path.endswith('/pdfMark/v3/web/draw/getByNote'): result = self.ink
        elif path.endswith('/pdfMark/v2/web/pencil/batch/delete'):
            for draw in self.ink:
                draw['webDrawV2']['webDrawItems'] = [p for p in draw['webDrawV2']['webDrawItems'] if p['id'] not in body['id']]
            result = {}
        elif path.endswith('/pdfMark/v3/web/getByNote') and dict(request.url.params).get('noteId') == 'note2': result = []
        else: return super().respond(request)
        return httpx.Response(200, json={'status':1,'data':result})

    def download(self, request):
        assert 'cookie' not in request.headers and 'authorization' not in request.headers
        return httpx.Response(200, content=self.content if request.url.path == '/1.pdf' else self.version2)


@pytest.fixture
def connected_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    upstream = FilesUpstream()
    with TestClient(cloud.app, client=('127.0.0.1',321)) as client:
        remote = upstream.remote()
        credentials = cloud.connect_remote(remote)
        headers = {**HEADERS,'Authorization':'Bearer '+credentials['access_token']}
        yield client, headers, upstream, remote, tmp_path


def upload(client, headers, content):
    return client.post('/api/v1/uploads', headers={**headers,'Content-Type':'application/pdf',
                       'X-PaperDesk-Filename':'New%20%E4%B8%AD%E6%96%87.pdf'}, content=content)


def test_raw_upload_confirmed_duplicate_and_no_runtime_files(connected_files):
    client, headers, upstream, remote, directory = connected_files
    started = upload(client, headers, upstream.version2)
    assert started.status_code == 200 and started.json()['state'] == 'processing'
    assert 'private-upload-token' not in started.text
    identifier = started.json()['id']
    completed = client.get('/api/v1/uploads/'+identifier, headers=headers)
    assert completed.json()['state'] == 'completed' and completed.json()['paper_id'] == 'rp-paper:3'
    assert upstream.multipart_count == 1
    remote.prepare('rp-paper:3')
    assert remote.pdf_bytes == upstream.version2
    assert upload(client, headers, upstream.content).json()['state'] == 'duplicate'
    assert upstream.multipart_count == 1
    assert list(directory.rglob('*')) == []
    assert client.post('/api/v1/auth/logout',headers=headers).status_code == 200
    assert not remote.transfers and remote.pdf_bytes is None


@pytest.mark.parametrize('content,filename,status', [(b'bad','bad.pdf',422),(b'','empty.pdf',413),(b'%PDF-not-valid','bad.pdf',422),(b'bad','../bad.pdf',422)])
def test_invalid_pdf_never_reaches_upstream(connected_files, content, filename, status):
    client, headers, upstream, _, directory = connected_files
    result = client.post('/api/v1/uploads',headers={**headers,'Content-Type':'application/pdf','X-PaperDesk-Filename':filename},content=content)
    assert result.status_code == status and upstream.multipart_count == 0
    assert list(directory.rglob('*')) == []


def test_upload_rejects_spooling_protocol_and_oversize(connected_files, monkeypatch):
    client, headers, upstream, _, _ = connected_files
    assert client.post('/api/v1/uploads',headers=headers,files={'file':('x.pdf',upstream.content)}).status_code == 415
    monkeypatch.setattr(cloud,'MAX_PDF_BYTES',8)
    assert upload(client,headers,upstream.content).status_code == 413
    assert upstream.multipart_count == 0


def test_upload_timeout_is_unknown_not_retried_or_claimed_saved(connected_files):
    client, headers, upstream, remote, directory = connected_files
    upstream.fail_upload = True
    response = upload(client,headers,upstream.version2)
    assert response.status_code == 502 and 'must-not-leak' not in response.text
    assert upstream.multipart_count == 1 and list(remote.transfers.values())[0]['state'] == 'unknown'
    assert not upstream.uploaded and list(directory.rglob('*')) == []


def test_upload_conflict_requires_explicit_resolution(connected_files):
    client, headers, upstream, _, _ = connected_files
    upstream.conflict = True
    operation = upload(client,headers,upstream.version2).json()
    assert operation['state'] == 'conflict' and not upstream.uploaded
    resolved = client.post('/api/v1/uploads/'+operation['id']+'/resolve',headers=headers,json={'keep_existing':True})
    assert resolved.status_code == 200 and resolved.json()['state'] == 'duplicate'


def test_upload_cancel_and_other_session_isolation(connected_files):
    client, headers, upstream, _, _ = connected_files
    operation = upload(client,headers,upstream.version2).json()
    other = cloud.connect_remote(FilesUpstream().remote())
    other_headers = {**HEADERS,'Authorization':'Bearer '+other['access_token']}
    assert client.get('/api/v1/uploads/'+operation['id'],headers=other_headers).status_code == 404
    cancelled = client.post('/api/v1/uploads/'+operation['id']+'/cancel',headers=headers)
    assert cancelled.json()['state'] == 'cancelled' and not upstream.uploaded


def test_version_selection_uses_new_pdf_identity_and_no_old_annotations(connected_files):
    client, headers, upstream, remote, directory = connected_files
    old = client.get('/api/v1/papers/rp-paper:1/session',headers=headers).json()
    old_hash = next(e for e in old['entries'] if e['kind']=='paper')['data']['file_hash']
    listing = client.get('/api/v1/papers/rp-paper:1/versions',headers=headers).json()
    assert len(listing['versions']) == 2 and all(v['pdf_id'] in ('1','2') for v in listing['versions'])
    selected = client.post('/api/v1/papers/rp-paper:1/versions/select',headers=headers,json={'pdf_id':'2'})
    assert selected.status_code == 200 and selected.json()['paper_id'] == 'rp-paper:1'
    assert remote.pdf_bytes is None and remote.sources == {}
    new = client.get('/api/v1/papers/rp-paper:1/session',headers=headers).json()
    assert not any(e['kind']=='annotation' for e in new['entries'])
    assert any(w['kind']=='version' for w in new['unsupported'])
    assert next(e for e in new['entries'] if e['kind']=='paper')['data']['file_hash'] != old_hash
    assert upstream.selections == 1 and list(directory.rglob('*')) == []
    remote.release()
    remote.index()
    assert remote.paper('rp-paper:1')['data']['source_pdf_id'] == '1'
    remote.prepare('rp-paper:1')
    assert remote.paper('rp-paper:1')['data']['source_pdf_id'] == '2'
    assert remote.pdf_bytes == upstream.version2


def test_arbitrary_pdf_cannot_be_selected_or_private_pdf_faked_as_version(connected_files):
    client, headers, upstream, remote, _ = connected_files
    response = client.post('/api/v1/papers/rp-paper:1/versions/select',headers=headers,json={'pdf_id':'999'})
    assert response.status_code == 422 and upstream.selections == 0
    remote.documents['1']['paperId'] = '-1'
    assert client.get('/api/v1/papers/rp-paper:1/versions',headers=headers).json()['supported'] is False
    response = client.post('/api/v1/uploads?version_of=rp-paper:1',headers={**headers,'Content-Type':'application/pdf','X-PaperDesk-Filename':'x.pdf'},content=upstream.version2)
    assert response.status_code == 422 and upstream.multipart_count == 0


def test_native_shared_note_is_reloaded_and_version_warning_shown(connected_files):
    client, headers, upstream, remote, _ = connected_files
    upstream.shared_note = True
    original = remote.details('rp-paper:1')
    old_hash = remote.paper('rp-paper:1')['data']['file_hash']
    selected = remote.select_version('rp-paper:1', '2')
    updated = remote.details(selected['paper_id'])
    assert remote.paper(selected['paper_id'])['data']['file_hash'] != old_hash
    assert {e['id'] for e in original['entries'] if e['kind']=='annotation'} == {
        e['id'] for e in updated['entries'] if e['kind']=='annotation'}
    assert any(w['kind']=='version' and '共享' in w['message'] for w in updated['unsupported'])


def test_native_ink_read_and_delete_known_protocol(connected_files):
    client, headers, upstream, _, directory = connected_files
    upstream.ink = [{'webDrawV2':{'pageNumber':1,'webDrawItems':[{'id':'stroke1','tooltype':1,'drawShapeType':0,
        'lineHexColor':'#338AFF','lineAlpha':.8,'lineWidth':0,'points':[
            {'x':95,'y':190,'pressure':.25,'size':{'width':3,'height':4}},
            {'x':190,'y':200,'pressure':.75,'size':{'width':6,'height':8}}]}]}}]
    detail = client.get('/api/v1/papers/rp-paper:1/session',headers=headers).json()
    stroke = next(e for e in detail['entries'] if e['id']=='rp-ink:stroke1')
    assert stroke['data']['points'][0]['x'] == pytest.approx(.1)
    assert stroke['data']['points'][0]['width'] == pytest.approx(5/950)
    assert stroke['data']['points'][1]['pressure'] == .75
    removed = client.post('/api/v1/entities',headers=headers,json={'kind':'annotation','id':stroke['id'],
        'base_revision':stroke['revision'],'data':stroke['data'],'deleted':True})
    assert removed.status_code == 200 and removed.json()['deleted']
    assert list(directory.rglob('*')) == []


def test_native_eraser_page_not_rendered_as_unerased_ink(connected_files):
    client, headers, upstream, _, _ = connected_files
    upstream.ink = [{'webDrawV2':{'pageNumber':1,'webDrawItems':[{'id':'erase','tooltype':4,'points':[]}]}},
                    {'webDrawV2':{'pageNumber':1,'webDrawItems':[{'id':'old','tooltype':1,'points':[]}]}}]
    detail = client.get('/api/v1/papers/rp-paper:1/session',headers=headers).json()
    assert not any(e['id'].startswith('rp-ink:') for e in detail['entries'])
    assert any(w['kind']=='handwriting' for w in detail['unsupported'])


def test_native_fixed_width_does_not_invent_pressure(connected_files):
    client, headers, upstream, _, _ = connected_files
    upstream.ink = [{'webDrawV2':{'pageNumber':1,'webDrawItems':[{'id':'fixed','tooltype':1,'drawShapeType':0,
        'lineHexColor':'#338AFF','lineAlpha':1,'lineWidth':3,'points':[{'x':95,'y':190},{'x':190,'y':200}]}]}}]
    detail = client.get('/api/v1/papers/rp-paper:1/session',headers=headers).json()
    stroke = next(e for e in detail['entries'] if e['id']=='rp-ink:fixed')['data']
    assert stroke['stroke_width'] == pytest.approx(3/950)
    assert all('pressure' not in point for point in stroke['points'])


@pytest.mark.parametrize('matched',[True,False])
def test_new_version_upload_must_match_target_paper_and_native_version_set(connected_files, matched):
    client, headers, upstream, _, _ = connected_files
    upstream.match_upload = matched
    created = client.post('/api/v1/uploads?version_of=rp-paper:1',headers={**headers,'Content-Type':'application/pdf','X-PaperDesk-Filename':'new-version.pdf'},content=upstream.version2).json()
    result = client.get('/api/v1/uploads/'+created['id'],headers=headers).json()
    assert result['state'] == ('completed' if matched else 'unmatched')
    if not matched: assert '未匹配' in result['reason']
