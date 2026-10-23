"""Online adapter contract tests with an inert, per-test ReadPaper server.

Never mutate the user's actual ReadPaper library or use real credentials.
"""
from contextlib import closing
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import time

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.readpaper import ReadPaper, APP, DOC, NOTE, normal_to_rect, rect_to_normal
from backend import cloud_main as cloud

PDF = Path(__file__).resolve().parents[2] / 'client/test/fixtures/reader.pdf'
HEADERS = {'X-PaperDesk-Session': 'ephemeral-v1'}


class Upstream:
    def __init__(self):
        self.requests = []
        self.content = PDF.read_bytes()
        self.mark = {'type': 0, 'pageNumber': 1, 'select': {'uuid': '11', 'documentId': 'note1', 'styleId': 3,
            'rectangle': [{'x': 30, 'y': 30, 'width': 100, 'height': 14, 'pageNumber': 1}], 'rectStr': 'source quote', 'idea': 'idea'}}
        self.marks = [self.mark]
        self.summary = 'Original summary'
        self.location = 2
        self.fail = None

    def respond(self, request):
        body = json.loads(request.content) if request.content else {}
        path = request.url.path.removeprefix('/api')
        self.requests.append((request.method, path, body, dict(request.headers)))
        if self.fail and self.fail in path:
            raise httpx.ReadTimeout('signed-url-and-secret-must-not-leak')
        if path == DOC+'/userDoc/getDocIndex':
            result = {'totalDocCount': 1, 'folderInfos': [{'folderId': '1', 'name': 'Physics', 'docInfos': [
                {'pdfId': '1', 'docId': 'd1', 'docName': 'Online paper.pdf'}]}], 'unclassifiedDocInfos': []}
        elif path == APP+'/paperNote/getOwnerPaperNoteBaseInfo':
            result = {'pdfId': '1', 'noteId': 'note1', 'pdfUrl': 'https://pdf.cdn.readpaper.com/fixture.pdf?signature=private'}
        elif path == APP+'/aiKnowledge/pdf/getPdfStatusInfo/v2':
            result = {'hasPdfAccessFlag': True, 'pdfUrl': 'https://pdf.cdn.readpaper.com/fixture.pdf?signature=private'}
        elif path.endswith('/pdfMark/v3/web/getByNote'): result = self.marks
        elif path.endswith('/pdfMark/v3/web/draw/getByNote'): result = []
        elif path == NOTE+'/noteShape/getList': result = {'list': []}
        elif path.endswith('/summary/getByNoteId'): result = {'content': self.summary}
        elif path.endswith('/summary/saveOrUpdate'): self.summary = body['content']; result = {}
        elif path.endswith('/getLocation'): result = {'location': json.dumps({'currentPage': self.location})}
        elif path.endswith('/record'): self.location = json.loads(body['location'])['currentPage']; result = {}
        elif path.endswith('/pdfMark/v2/web/save'):
            raw = {k: v for k, v in body.items() if k in ('type', 'pageNumber', 'select', 'rect', 'textBox')}
            part = raw.get('select') or raw.get('rect') or raw.get('textBox')
            part['id' if raw['type'] == 4 else 'uuid'] = '22'
            self.marks.append(raw); result = '22'
        elif path.endswith('/pdfMark/v2/web/update'):
            field = {0: 'select', 1: 'rect', 4: 'textBox'}[body['type']]
            key = body[field].get('uuid') or body[field].get('id')
            self.marks = [body if ((m.get(field) or {}).get('uuid') or (m.get(field) or {}).get('id')) == key else m for m in self.marks]
            result = {}
        elif path.endswith('/pdfMark/v2/web/delete'):
            self.marks = [m for m in self.marks if str((m.get('select') or m.get('rect') or m.get('textBox') or {}).get('uuid')) != body['id']]
            result = {}
        else: raise AssertionError('Unexpected upstream endpoint: '+path)
        return httpx.Response(200, json={'status': 1, 'data': result})

    def download(self, request):
        assert 'authorization' not in request.headers
        assert 'cookie' not in request.headers
        return httpx.Response(200, content=self.content)

    def remote(self):
        return ReadPaper({'aiKnowledge-token': 'fake-token'},
            client=httpx.Client(base_url='https://readpaper.com/api', transport=httpx.MockTransport(self.respond)),
            cdn=httpx.Client(transport=httpx.MockTransport(self.download)))


@pytest.fixture
def connected(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with TestClient(cloud.app, client=('127.0.0.1', 12345)) as client:
        upstream = Upstream(); connected = cloud.connect_remote(upstream.remote())
        headers = {**HEADERS, 'Authorization': 'Bearer '+connected['access_token']}
        yield client, headers, upstream, tmp_path


def test_cloud_reads_and_release_leave_no_business_files(connected):
    client, headers, upstream, directory = connected
    listing = client.get('/api/v1/library', headers=headers)
    assert listing.status_code == 200 and listing.json()['storage'] == 'memory-only'
    assert listing.headers['cache-control'] == 'no-store, private'
    detail = client.get('/api/v1/papers/rp-paper:1/session', headers=headers).json()
    kinds = {item['kind'] for item in detail['entries']}
    assert kinds == {'paper', 'annotation', 'note', 'progress'}
    pdf = client.get('/api/v1/papers/rp-paper:1/pdf', headers=headers)
    assert hashlib.sha256(pdf.content).digest() == hashlib.sha256(upstream.content).digest()
    assert all('signature' not in json.dumps(item) for item in detail['entries'])
    assert list(directory.rglob('*')) == []
    assert client.delete('/api/v1/papers/rp-paper:1/session', headers=headers).status_code == 200
    session = cloud.sessions[headers['Authorization'][7:]]
    assert session.remote.pdf_bytes is None and not session.remote.contexts and not session.remote.sources
    assert not any(item['kind'] == 'annotation' for item in session.remote.entries.values())


def test_confirmed_create_update_delete_and_source_version_conflict(connected):
    client, headers, upstream, _ = connected
    detail = client.get('/api/v1/papers/rp-paper:1/session', headers=headers).json()
    paper = next(e for e in detail['entries'] if e['kind'] == 'paper')
    data = {'paper_id': paper['id'], 'file_hash': paper['data']['file_hash'], 'type': 'highlight',
            'page': 1, 'rects': [[.1, .1, .4, .12]], 'color': '#FFFF00', 'text': 'new quote'}
    created = client.post('/api/v1/entities', headers=headers, json={'kind': 'annotation', 'data': data})
    assert created.status_code == 200 and created.json()['id'] == 'rp-mark:22'
    sent = next(body for _, path, body, _ in upstream.requests if path.endswith('/pdfMark/v2/web/save'))
    assert sent['noteId'] == 'note1' and sent['select']['rectangle'][0]['pageNumber'] == 1
    value = created.json(); changed = {**value['data'], 'text': 'new idea'}
    updated = client.post('/api/v1/entities', headers=headers, json={'kind': 'annotation', 'data': changed,
        'id': value['id'], 'base_revision': value['revision']})
    assert updated.status_code == 200 and updated.json()['data']['text'] == 'new idea'
    stale = client.post('/api/v1/entities', headers=headers, json={'kind': 'annotation', 'data': data,
        'id': value['id'], 'base_revision': value['revision']})
    assert stale.status_code == 409
    value = updated.json()
    removed = client.post('/api/v1/entities', headers=headers, json={'kind': 'annotation', 'data': value['data'],
        'id': value['id'], 'base_revision': value['revision'], 'deleted': True})
    assert removed.status_code == 200 and removed.json()['deleted'] is True
    assert len(upstream.marks) == 1


def test_note_and_progress_write_ack_and_concurrent_note_guard(connected):
    client, headers, upstream, _ = connected
    detail = client.get('/api/v1/papers/rp-paper:1/session', headers=headers).json()
    note = next(e for e in detail['entries'] if e['kind'] == 'note')
    request = {'kind': 'note', 'id': note['id'], 'base_revision': note['revision'],
               'data': {**note['data'], 'content': 'new body'}}
    assert client.post('/api/v1/entities', headers=headers, json=request).status_code == 200
    assert upstream.summary == 'new body'
    assert client.post('/api/v1/entities', headers=headers, json=request).status_code == 409
    progress = {'kind': 'progress', 'data': {'paper_id': 'rp-paper:1', 'page': 3}}
    assert client.post('/api/v1/entities', headers=headers, json=progress).status_code == 200
    assert upstream.location == 3


def test_no_retry_or_false_ack_after_ambiguous_network_failure(connected):
    client, headers, upstream, _ = connected
    client.get('/api/v1/papers/rp-paper:1/session', headers=headers)
    upstream.fail = '/noteReadLocation/record'
    result = client.post('/api/v1/entities', headers=headers, json={'kind': 'progress', 'data': {'paper_id': 'rp-paper:1', 'page': 3}})
    assert result.status_code == 502 and 'signed-url' not in result.text
    assert sum(path.endswith('/noteReadLocation/record') for _, path, _, _ in upstream.requests) == 1
    assert upstream.location == 2


@pytest.mark.parametrize('kind', ['note', 'progress', 'annotation', 'delete'])
def test_success_response_with_stale_readback_is_not_reported_saved(connected, monkeypatch, kind):
    client, headers, upstream, _ = connected
    detail = client.get('/api/v1/papers/rp-paper:1/session', headers=headers).json()
    remote = cloud.sessions[headers['Authorization'][7:]].remote
    original = remote.call
    def ignore_write(method, path, data=None):
        if path.endswith(('/summary/saveOrUpdate', '/noteReadLocation/record',
                          '/pdfMark/v2/web/update', '/pdfMark/v2/web/delete')):
            return {}
        return original(method, path, data)
    monkeypatch.setattr(remote, 'call', ignore_write)
    if kind == 'progress':
        request = {'kind': kind, 'data': {'paper_id': 'rp-paper:1', 'page': 3}}
    else:
        value = next(e for e in detail['entries'] if e['kind'] == ('annotation' if kind == 'delete' else kind))
        field = 'content' if kind == 'note' else 'text'
        request = {'kind': value['kind'], 'id': value['id'], 'base_revision': value['revision'],
                   'data': {**value['data'], field: 'Modified'}, 'deleted': kind == 'delete'}
    result = client.post('/api/v1/entities', headers=headers, json=request)
    assert result.status_code == 502
    assert upstream.summary == 'Original summary' and upstream.location == 2 and len(upstream.marks) == 1


def test_account_isolation_logout_and_provider_keys_only_in_memory(connected):
    client, headers, upstream, directory = connected
    client.get('/api/v1/papers/rp-paper:1/session', headers=headers)
    result = client.put('/api/v1/providers/ai', headers=headers, json={'endpoint': 'http://127.0.0.1:9999/v1', 'model': 'private', 'api_key': 'private-key'})
    assert result.status_code == 200
    assert 'private-key' not in client.get('/api/v1/providers', headers=headers).text
    assert client.put('/api/v1/providers/ai', headers=headers, json={'endpoint': 'https://readpaper.com/api', 'model': 'wrong'}).status_code == 422
    other = cloud.connect_remote(Upstream().remote())
    other_headers = {**HEADERS, 'Authorization': 'Bearer '+other['access_token']}
    assert client.get('/api/v1/providers', headers=other_headers).json() == {}
    instance = cloud.sessions[headers['Authorization'][7:]]
    assert client.post('/api/v1/auth/logout', headers=headers).status_code == 200
    assert instance.closed and instance.remote.pdf_bytes is None and not instance.providers and not instance.jobs
    assert client.get('/api/v1/library', headers=headers).status_code == 401
    assert list(directory.rglob('*')) == []


def test_expired_session_and_source_scope_are_rejected(connected):
    client, headers, _, _ = connected
    assert client.get('/api/v1/papers/rp-paper:other/session', headers=headers).status_code == 404
    instance = cloud.sessions[headers['Authorization'][7:]]
    instance.touched -= cloud.IDLE_SECONDS + 1
    assert client.get('/api/v1/library', headers=headers).status_code == 401
    cloud.sweep()
    assert instance.closed and not instance.remote.client.cookies


def test_local_session_import_only_loopback_and_no_origin(connected, monkeypatch):
    client, _, upstream, directory = connected
    appdata = directory/'profile'; (appdata/'ReadPaper').mkdir(parents=True)
    dbfile = appdata/'ReadPaper/Cookies'
    with closing(sqlite3.connect(dbfile)) as db:
        db.execute('CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT)')
        db.execute("INSERT INTO cookies VALUES ('.readpaper.com','aiKnowledge-token','fake')"); db.commit()
    monkeypatch.setenv('APPDATA', str(appdata)); monkeypatch.setattr(cloud, 'ReadPaper', lambda cookies: upstream.remote())
    before = dbfile.read_bytes()
    assert client.post('/api/v1/auth/readpaper-local', headers={**HEADERS, 'Origin': 'https://untrusted.test'}).status_code == 403
    assert client.post('/api/v1/auth/readpaper-local', headers={**HEADERS, 'X-Forwarded-For': '127.0.0.1'}).status_code == 403
    assert client.post('/api/v1/auth/readpaper-local', headers=HEADERS).status_code == 200
    assert dbfile.read_bytes() == before
    with TestClient(cloud.app, client=('192.0.2.5', 23)) as remote:
        assert remote.post('/api/v1/auth/readpaper-local', headers=HEADERS).status_code == 403


def test_ai_uses_own_service_and_does_not_call_readpaper_ai(connected, monkeypatch):
    client, headers, upstream, directory = connected
    client.get('/api/v1/papers/rp-paper:1/session', headers=headers)
    client.put('/api/v1/providers/ai', headers=headers, json={'endpoint': 'http://127.0.0.1:9999/v1', 'model': 'self', 'api_key': 'secret'})
    captured = []
    def own(config, messages):
        captured.append((config, messages)); return 'Answer [第1页]'
    monkeypatch.setattr(cloud, 'own_complete', own)
    created = client.post('/api/v1/jobs', headers=headers, json={'kind': 'ask', 'paper_id': 'rp-paper:1', 'pages': [1]})
    assert created.status_code == 200
    identifier = created.json()['id']; result = client.get('/api/v1/jobs/'+identifier, headers=headers).json()
    assert result['state'] == 'completed' and result['result']['sources'] == [{'page': 1}]
    assert captured[0][0]['endpoint'] == 'http://127.0.0.1:9999/v1'
    assert not any('aiAssistReading' in path or '/ts/' in path for _, path, _, _ in upstream.requests)
    assert list(directory.rglob('*')) == []
    other = cloud.connect_remote(Upstream().remote())
    assert client.get('/api/v1/jobs/'+identifier, headers={**HEADERS, 'Authorization': 'Bearer '+other['access_token']}).status_code == 404
    assert client.delete('/api/v1/papers/rp-paper:1/session', headers=headers).status_code == 200
    assert client.get('/api/v1/jobs/'+identifier, headers=headers).status_code == 404


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_coordinate_write_roundtrip_for_page_rotation(rotation):
    geo = (600, 800, rotation)
    normalized = [.2, .3, .6, .35]
    raw = normal_to_rect(normalized, geo, 1)
    assert rect_to_normal(raw, geo) == pytest.approx(normalized)


def test_unsupported_ink_is_not_acknowledged_or_saved_locally(connected):
    client, headers, upstream, directory = connected
    client.get('/api/v1/papers/rp-paper:1/session', headers=headers)
    count = len(upstream.requests)
    result = client.post('/api/v1/entities', headers=headers, json={'kind': 'annotation', 'data': {
        'paper_id': 'rp-paper:1', 'type': 'ink', 'page': 1, 'rects': [[.1,.1,.2,.2]], 'color': '#000000'}})
    assert result.status_code == 422
    assert not any(path.endswith('/pdfMark/v2/web/save') for _, path, _, _ in upstream.requests[count:])
    assert list(directory.rglob('*')) == []


@pytest.mark.parametrize('kind', ['rectangle', 'text'])
def test_rectangle_and_text_roundtrip_from_remote_readback(connected, kind):
    client, headers, upstream, _ = connected
    client.get('/api/v1/papers/rp-paper:1/session', headers=headers)
    value = {'paper_id': 'rp-paper:1', 'type': kind, 'page': 1, 'rects': [[.2, .3, .5, .4]],
             'color': '#338AFF', 'text': 'Chinese 中文', 'font_size': .02}
    result = client.post('/api/v1/entities', headers=headers, json={'kind': 'annotation', 'data': value})
    assert result.status_code == 200
    record = result.json()['data']
    assert record['rects'][0] == pytest.approx(value['rects'][0])
    if kind == 'text': assert record['font_size'] == pytest.approx(.02)
    assert record['text'] == value['text']


def test_pairing_is_single_use_and_requires_tls_for_remote_clients(connected, monkeypatch):
    client, headers, upstream, _ = connected
    monkeypatch.setattr(cloud, 'ReadPaper', lambda cookies: upstream.remote())
    paired = client.post('/api/v1/auth/pairing', headers=headers).json()
    assert paired['single_use'] is True
    result = client.post('/api/v1/auth/pair', headers=HEADERS, json={'code': paired['code']})
    assert result.status_code == 200 and result.json()['access_token'] != headers['Authorization'][7:]
    assert client.post('/api/v1/auth/pair', headers=HEADERS, json={'code': paired['code']}).status_code == 401
    with TestClient(cloud.app, client=('192.0.2.5', 23)) as remote:
        assert remote.post('/api/v1/auth/pair', headers=HEADERS, json={'code': 'x'*40}).status_code == 403


def test_source_cdn_redirect_and_unknown_host_never_receive_credentials(connected):
    client, headers, upstream, _ = connected
    original = upstream.respond
    def malicious(request):
        if request.url.path.endswith('/getPdfStatusInfo/v2'):
            return httpx.Response(200, json={'status': 1, 'data': {'hasPdfAccessFlag': True, 'pdfUrl': 'https://untrusted.example/private'}})
        return original(request)
    remote = cloud.sessions[headers['Authorization'][7:]].remote
    remote.client.close(); remote.client = httpx.Client(base_url='https://readpaper.com/api', transport=httpx.MockTransport(malicious))
    assert client.get('/api/v1/papers/rp-paper:1/session', headers=headers).status_code == 502
    assert remote.pdf_bytes is None


def test_pdf_access_denial_never_downloads_note_context_url(connected):
    client, headers, upstream, _ = connected
    original = upstream.respond
    def denied(request):
        if request.url.path.endswith('/getPdfStatusInfo/v2'):
            return httpx.Response(200, json={'status': 1, 'data': {'hasPdfAccessFlag': False}})
        return original(request)
    remote = cloud.sessions[headers['Authorization'][7:]].remote
    remote.client.close()
    remote.client = httpx.Client(base_url='https://readpaper.com/api', transport=httpx.MockTransport(denied))
    assert client.get('/api/v1/papers/rp-paper:1/session', headers=headers).status_code == 403
    assert remote.pdf_bytes is None and remote.contexts == {}


def test_unknown_mutation_without_revision_cannot_overwrite_summary(connected):
    client, headers, upstream, _ = connected
    client.get('/api/v1/papers/rp-paper:1/session', headers=headers)
    result = client.post('/api/v1/entities', headers=headers, json={'kind': 'note',
        'data': {'paper_id': 'rp-paper:1', 'content': 'overwrite without baseline'}})
    assert result.status_code == 409 and upstream.summary == 'Original summary'
