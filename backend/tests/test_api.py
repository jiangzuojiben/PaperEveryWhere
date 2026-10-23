import os
import io
import tempfile
from uuid import uuid4
from pathlib import Path
os.environ['PAPERDESK_DATA_DIR'] = tempfile.mkdtemp(prefix='paperdesk-tests-')
os.environ['PAPERDESK_DATABASE_URL'] = 'sqlite:///' + str(Path(os.environ['PAPERDESK_DATA_DIR']) / 'test.db')
from fastapi.testclient import TestClient
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter
import pytest
from backend.main import app
from backend.db import Base, engine, Session
from backend.models import Provider
import httpx


@pytest.fixture(autouse=True)
def tables():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)


@pytest.fixture
def client():
    with TestClient(app) as client:
        yield client


def account(client, email='one@example.com'):
    response = client.post('/api/v1/auth/register', json={'email': email, 'password': 'test-password-123'})
    assert response.status_code == 201, response.text
    body = response.json()
    return {'Authorization': 'Bearer ' + body['access_token']}, body['user']


def test_metadata_lookup_normalizes_doi_and_does_not_mutate_library(client, monkeypatch):
    from backend import providers
    headers, _ = account(client)
    real_client = httpx.Client
    def handle(request):
        assert str(request.url).startswith('https://api.crossref.org/works/10.1000%2Fexample')
        return httpx.Response(200, json={'message': {'DOI': '10.1000/example', 'title': ['Provider title'],
            'author': [{'given': 'Ada', 'family': 'Lovelace'}], 'published': {'date-parts': [[2025]]},
            'abstract': '<jats:p>A &amp; B</jats:p>', 'volume': '12', 'ISSN': ['1234-5678']}})
    monkeypatch.setattr(providers.httpx, 'Client', lambda **kwargs: real_client(transport=httpx.MockTransport(handle), **kwargs))
    response = client.get('/api/v1/metadata', params={'doi': ' https://doi.org/10.1000/example '}, headers=headers)
    assert response.status_code == 200, response.text
    metadata = response.json()['metadata']
    assert metadata['authors'] == ['Ada Lovelace'] and metadata['abstract'] == 'A & B'
    assert metadata['year'] == 2025 and metadata['volume'] == '12'
    assert client.get('/api/v1/library', headers=headers).json()['items'] == []
    assert client.get('/api/v1/metadata', params={'doi': 'file:///etc/passwd'}, headers=headers).status_code == 422


@pytest.mark.parametrize('status,expected', [(404, 404), (429, 502), (503, 502)])
def test_metadata_lookup_upstream_failure(client, monkeypatch, status, expected):
    from backend import providers
    headers, _ = account(client)
    real_client = httpx.Client
    monkeypatch.setattr(providers.httpx, 'Client', lambda **kwargs: real_client(
        transport=httpx.MockTransport(lambda _: httpx.Response(status)), **kwargs))
    assert client.get('/api/v1/metadata', params={'doi': '10.1000/missing'}, headers=headers).status_code == expected


def test_folder_cycles_and_nonempty_deletion_are_atomic(client):
    headers, _ = account(client)
    parent = operation('folder', {'title': 'Research'})
    child = operation('folder', {'title': 'Rendering', 'parent_id': parent['entity_id']})
    paper = operation(data={'title': 'Paper', 'folder_id': child['entity_id']})
    assert sync(client, headers, [parent, child, paper]).status_code == 200
    cycle = operation('folder', {'title': 'Research', 'parent_id': child['entity_id']}, parent['entity_id'], 1)
    assert sync(client, headers, [cycle]).status_code == 422
    assert sync(client, headers, [operation('folder', {}, child['entity_id'], 1, True)]).status_code == 422
    assert sync(client, headers, [operation('paper', {'title': 'Paper', 'folder_id': parent['entity_id']}, paper['entity_id'], 1),
        operation('folder', {}, child['entity_id'], 1, True)]).status_code == 200
    folders = client.get('/api/v1/library', params={'kind': 'folder'}, headers=headers).json()['items']
    assert len(folders) == 1 and not folders[0]['data'].get('parent_id')


def test_multiple_folder_references_are_scoped_and_prevent_deletion(client):
    headers, _ = account(client)
    a = operation('folder', {'title': 'A'})
    b = operation('folder', {'title': 'B'})
    paper = operation(data={'title': 'Both', 'folder_id': a['entity_id'],
                            'folder_ids': [a['entity_id'], b['entity_id']]})
    assert sync(client, headers, [a, b, paper]).status_code == 200
    assert sync(client, headers, [operation('folder', {}, b['entity_id'], 1, True)]).status_code == 422
    other, _ = account(client, 'other@example.com')
    assert sync(client, other, [operation(data={'title': 'Wrong scope', 'folder_ids': [a['entity_id']]})]).status_code == 422
    assert sync(client, headers, [operation(data={'folder_ids': [123]})]).status_code == 422
    assert sync(client, headers, [operation(data={'title': 'Moved', 'folder_ids': [a['entity_id']]},
                                          entity_id=paper['entity_id'], revision=1),
                                  operation('folder', {}, b['entity_id'], 1, True)]).status_code == 200


def test_figures_extract_caption_page_crop_and_rotation(client):
    from PIL import Image, ImageDraw
    from reportlab.lib.utils import ImageReader
    headers, _ = account(client)
    image = Image.new('RGB', (400, 240), 'white')
    draw = ImageDraw.Draw(image); draw.rectangle((20, 20, 300, 180), fill='blue')
    png = io.BytesIO(); image.save(png, format='PNG')
    output = io.BytesIO(); pdf = canvas.Canvas(output, pagesize=(600, 800))
    pdf.drawImage(ImageReader(io.BytesIO(png.getvalue())), 100, 300, width=400, height=240)
    pdf.drawString(100, 282, 'Figure 1. A reproducible chart candidate')
    pdf.showPage(); pdf.drawImage(ImageReader(io.BytesIO(png.getvalue())), 0, 0, width=600, height=800)
    pdf.save()
    file = client.post('/api/v1/files', headers=headers, files={'file': ('figures.pdf', output.getvalue())}).json()
    paper = operation(data={'title': 'Figures', 'file_id': file['id'], 'file_hash': file['sha256']})
    assert sync(client, headers, [paper]).status_code == 200
    task = client.post('/api/v1/jobs', headers=headers, json={'kind': 'figures', 'paper_id': paper['entity_id']}).json()
    result = client.get('/api/v1/jobs/' + task['id'], headers=headers).json()
    assert result['state'] == 'completed', result
    figures = result['result']['figures']
    assert len(figures) == 1
    assert figures[0]['page'] == 1 and figures[0]['label'] == 'Figure 1'
    assert 'reproducible' in figures[0]['caption'] and not figures[0]['caption_verified']
    import base64
    crop = Image.open(io.BytesIO(base64.b64decode(figures[0]['image_base64'])))
    assert crop.width > crop.height and crop.getpixel((100, 100))[2] > 150
    from backend.figures import figure_candidates
    writer = PdfWriter(); writer.append(PdfReader(io.BytesIO(output.getvalue())))
    writer.pages[0].rotate(90); rotated = io.BytesIO(); writer.write(rotated)
    rotated_result = figure_candidates(rotated.getvalue(), pages=[1])
    assert len(rotated_result['figures']) == 1
    assert all(0 <= value <= 1 for value in rotated_result['figures'][0]['rect'])


def test_task_pins_file_version_and_rejects_stale_hash(client, monkeypatch):
    from backend.models import Job, Entity
    from backend.tasks import run_job
    headers, _ = account(client); paper_id, file = paper_with_file(client, headers)
    monkeypatch.setattr('backend.main.dispatch', lambda *_: None)
    assert client.post('/api/v1/jobs', headers=headers, json={'kind': 'extract', 'paper_id': paper_id,
        'file_hash': '0' * 64}).status_code == 409
    task = client.post('/api/v1/jobs', headers=headers, json={'kind': 'extract', 'paper_id': paper_id}).json()
    with Session() as db:
        request = db.get(Job, task['id']).request
        assert request['_file_id'] == file['id'] and request['file_hash'] == file['sha256']
        paper = db.get(Entity, paper_id); paper.data = {**paper.data, 'file_id': None, 'file_hash': '1' * 64}; db.commit()
    run_job.run(task['id'])
    result = client.get('/api/v1/jobs/' + task['id'], headers=headers).json()
    assert result['state'] == 'completed' and result['result']['file_hash'] == file['sha256']


def operation(kind='paper', data=None, entity_id=None, revision=0, deleted=False):
    return {'op_id': str(uuid4()), 'entity_id': entity_id or str(uuid4()), 'kind': kind, 'base_revision': revision,
            'data': data if data is not None else {'title': 'A paper'}, 'deleted': deleted}


def sync(client, headers, operations=None, scope='personal', cursor=0):
    return client.post('/api/v1/sync', headers=headers, json={'operations': operations or [], 'scope': scope, 'cursor': cursor})


def pdf_bytes():
    output = io.BytesIO(); drawing = canvas.Canvas(output)
    drawing.drawString(60, 720, 'PaperDesk: reproducible research')
    drawing.showPage(); drawing.drawString(60, 720, 'Second page: results and limitations')
    drawing.save(); return output.getvalue()


def paper_with_file(client, headers):
    upload = client.post('/api/v1/files', headers=headers, files={'file': ('example.pdf', pdf_bytes(), 'application/pdf')})
    assert upload.status_code == 201, upload.text
    file = upload.json()
    paper = operation(data={'title': 'Research', 'authors': ['Ada Lovelace'], 'file_id': file['id'], 'file_hash': file['sha256']})
    assert sync(client, headers, [paper]).status_code == 200
    return paper['entity_id'], file


def test_auth_logout(client):
    headers, _ = account(client)
    assert client.get('/api/v1/auth/me', headers=headers).status_code == 200
    assert client.post('/api/v1/auth/register', json={'email': 'one@example.com', 'password': 'test-password-123'}).status_code == 409
    assert client.post('/api/v1/auth/login', json={'email': 'one@example.com', 'password': 'wrong-password'}).status_code == 401
    assert client.post('/api/v1/auth/logout', headers=headers).status_code == 200
    assert client.get('/api/v1/library', headers=headers).status_code == 401


def test_idempotency_and_operation_reuse(client):
    headers, _ = account(client)
    op = operation()
    first = sync(client, headers, [op]).json()
    again = sync(client, headers, [op]).json()
    assert first['results'] == again['results']
    assert len(again['changes']) == 1
    op['data']['title'] = 'Changed payload'
    assert sync(client, headers, [op]).status_code == 409


def test_notes_preserve_conflicts(client):
    headers, _ = account(client)
    paper = operation(); sync(client, headers, [paper])
    note = operation('note', {'paper_id': paper['entity_id'], 'content': 'first'})
    sync(client, headers, [note])
    update = operation('note', {'paper_id': paper['entity_id'], 'content': 'second'}, note['entity_id'], 1)
    sync(client, headers, [update])
    stale = operation('note', {'paper_id': paper['entity_id'], 'content': 'offline edit'}, note['entity_id'], 1)
    result = sync(client, headers, [stale]).json()['results'][0]
    assert result['status'] == 'conflict'
    assert result['current']['data']['content'] == 'second'
    assert result['conflict_copy']['data']['content'] == 'offline edit'
    assert result['conflict_copy']['data']['conflict_of'] == note['entity_id']


def test_cross_account_and_reference_isolation(client):
    first, _ = account(client); second, _ = account(client, 'two@example.com')
    paper = operation(); sync(client, first, [paper])
    assert not sync(client, second).json()['changes']
    assert sync(client, second, [operation(entity_id=paper['entity_id'], revision=1)]).status_code == 403
    assert sync(client, second, [operation('note', {'paper_id': paper['entity_id'], 'content': 'private'})]).status_code == 422


def test_tombstone_and_stale_update(client):
    headers, _ = account(client)
    op = operation(); sync(client, headers, [op])
    delete = operation(entity_id=op['entity_id'], revision=1, deleted=True)
    response = sync(client, headers, [delete]).json()
    assert response['changes'][-1]['deleted'] is True
    stale = operation(entity_id=op['entity_id'], revision=1)
    assert sync(client, headers, [stale]).json()['results'][0]['status'] == 'conflict'
    assert client.get('/api/v1/library', headers=headers).json()['items'] == []


def test_group_viewer_and_revocation(client):
    owner, _ = account(client); viewer, viewer_user = account(client, 'two@example.com')
    group = client.post('/api/v1/groups', headers=owner, json={'name': 'Lab'}).json()
    scope = 'g:' + group['id']
    assert sync(client, viewer, scope=scope).status_code == 403
    assert client.put(f"/api/v1/groups/{group['id']}/members", headers=owner, json={'email': viewer_user['email'], 'role': 'viewer'}).status_code == 200
    assert sync(client, owner, [operation()], scope=scope).status_code == 200
    assert len(sync(client, viewer, scope=scope).json()['changes']) == 1
    assert sync(client, viewer, [operation()], scope=scope).status_code == 403
    client.delete(f"/api/v1/groups/{group['id']}/members/{viewer_user['id']}", headers=owner)
    assert sync(client, viewer, scope=scope).status_code == 403


def test_pdf_dedup_and_file_permissions(client):
    headers, _ = account(client); other, _ = account(client, 'two@example.com')
    _, file = paper_with_file(client, headers)
    repeat = client.post('/api/v1/files', headers=headers, files={'file': ('again.pdf', pdf_bytes(), 'application/pdf')})
    # ReportLab embeds timestamps/IDs; send exact stored bytes to test identity.
    original = client.get('/api/v1/files/' + file['id'], headers=headers).content
    repeat = client.post('/api/v1/files', headers=headers, files={'file': ('again.pdf', original, 'application/pdf')}).json()
    assert repeat['duplicate'] is True and repeat['id'] == file['id']
    assert client.get('/api/v1/files/' + file['id'], headers=other).status_code == 404


def test_damaged_encrypted_and_attachment(client):
    headers, _ = account(client)
    assert client.post('/api/v1/files', headers=headers, files={'file': ('bad.pdf', b'%PDF-broken')}).status_code == 422
    writer = PdfWriter(); writer.add_blank_page(width=100, height=100); writer.encrypt('secret')
    stream = io.BytesIO(); writer.write(stream)
    assert client.post('/api/v1/files', headers=headers, files={'file': ('locked.pdf', stream.getvalue())}).status_code == 422
    attachment = client.post('/api/v1/files?attachment=true', headers=headers, files={'file': ('notes.txt', b'attachment')})
    assert attachment.status_code == 201


def test_export_and_extraction(client):
    headers, _ = account(client)
    paper_id, file = paper_with_file(client, headers)
    annotation = operation('annotation', {'paper_id': paper_id, 'file_hash': file['sha256'], 'page': 1, 'type': 'highlight', 'color': '#edb83c', 'rects': [[.1, .12, .7, .16]], 'text': 'research'})
    assert sync(client, headers, [annotation]).status_code == 200
    exported = client.get(f'/api/v1/papers/{paper_id}/export.pdf', headers=headers)
    assert exported.status_code == 200
    reader = PdfReader(io.BytesIO(exported.content))
    assert reader.pages[0]['/Annots'][0].get_object()['/Subtype'] == '/Highlight'
    assert len(reader.pages) == 2
    task = client.post('/api/v1/jobs', headers=headers, json={'kind': 'extract', 'paper_id': paper_id}).json()
    result = client.get('/api/v1/jobs/' + task['id'], headers=headers).json()
    assert result['state'] == 'completed', result
    assert 'reproducible research' in result['result']['pages'][0]['text']
    assert client.get(f"/api/v1/files/{file['id']}/pages/1.png", headers=headers).content[:8] == b'\x89PNG\r\n\x1a\n'


def test_annotation_bounds(client):
    headers, _ = account(client)
    op = operation('annotation', {'page': 0, 'type': 'ink', 'points': [{'x': 2, 'y': 0}]})
    assert sync(client, headers, [op]).status_code == 422


def test_missing_provider_and_retry(client):
    headers, _ = account(client); paper_id, _ = paper_with_file(client, headers)
    task = client.post('/api/v1/jobs', headers=headers, json={'kind': 'ask', 'paper_id': paper_id}).json()
    result = client.get('/api/v1/jobs/' + task['id'], headers=headers).json()
    assert result['state'] == 'failed' and '配置' in result['error']
    retry = client.post('/api/v1/jobs/' + task['id'] + '/retry', headers=headers).json()
    assert retry['id'] != task['id']


def test_encrypted_provider_secrets(client):
    headers, user = account(client)
    response = client.put('/api/v1/providers/ai', headers=headers, json={'endpoint': 'https://example.com/v1', 'model': 'example', 'api_key': 'test-secret-value'})
    assert response.status_code == 200
    assert 'test-secret-value' not in client.get('/api/v1/providers', headers=headers).text
    with Session() as db:
        assert 'test-secret-value' not in db.get(Provider, (user['id'], 'ai')).secret


def test_migration_preview_and_idempotence(client):
    headers, _ = account(client)
    bibtex = b'@article{a,title={Sample},author={Ada Lovelace},year={2024}}'
    preview = client.post('/api/v1/migration/preview', headers=headers, files={'file': ('export.bib', bibtex)}).json()
    assert preview['count'] == 1
    preview['items'][0]['notes'] = ['Original note']
    first = client.post('/api/v1/migration/commit', headers=headers, json=preview).json()
    second = client.post('/api/v1/migration/commit', headers=headers, json=preview).json()
    assert first['imported'] == 1 and second['skipped'] == 1
    assert len(client.get('/api/v1/library?kind=note', headers=headers).json()['items']) == 1
    paper = client.get('/api/v1/library', headers=headers).json()['items'][0]
    assert 'Sample' in client.get(f"/api/v1/papers/{paper['id']}/citation", headers=headers).text
    assert 'TY  - JOUR' in client.get(f"/api/v1/papers/{paper['id']}/citation?format=ris", headers=headers).text


def test_cursor_pagination_has_no_gaps(client):
    headers, _ = account(client)
    for _ in range(3):
        assert sync(client, headers, [operation() for _ in range(180)]).status_code == 200
    first = sync(client, headers).json()
    assert first['has_more'] and len(first['changes']) == 500
    second = sync(client, headers, cursor=first['cursor']).json()
    assert not second['has_more'] and len(second['changes']) == 40
    assert len({e['id'] for e in first['changes'] + second['changes']}) == 540


def test_ai_task_tracks_sources_and_redacts_errors(client, monkeypatch):
    headers, _ = account(client); paper_id, _ = paper_with_file(client, headers)
    client.put('/api/v1/providers/ai', headers=headers, json={'endpoint': 'https://example.com/v1', 'model': 'configured', 'api_key': 'private-test-value'})
    def answer(config, secret, messages):
        assert secret == 'private-test-value'
        assert '[第1页]' in messages[1]['content']
        return 'The study discusses reproducibility [第1页].'
    monkeypatch.setattr('backend.tasks.complete', answer)
    task = client.post('/api/v1/jobs', headers=headers, json={'kind': 'ask', 'paper_id': paper_id}).json()
    result = client.get('/api/v1/jobs/' + task['id'], headers=headers).json()
    assert result['state'] == 'completed'
    assert {'page': 1} in result['result']['sources']
    import httpx
    def failed(*_): raise httpx.ConnectError('secret private-test-value must not leak')
    monkeypatch.setattr('backend.tasks.complete', failed)
    task = client.post('/api/v1/jobs', headers=headers, json={'kind': 'ask', 'paper_id': paper_id}).json()
    result = client.get('/api/v1/jobs/' + task['id'], headers=headers)
    assert result.json()['state'] == 'failed'
    assert 'private-test-value' not in result.text
    history = client.get('/api/v1/jobs', params={'paper_id': paper_id}, headers=headers).json()['items']
    assert len(history) == 2 and history[0]['state'] == 'failed'
    assert all('request' not in item and 'result' not in item for item in history)
    other, _ = account(client, 'other@example.com')
    assert client.get('/api/v1/jobs', params={'paper_id': paper_id}, headers=other).status_code == 403
    assert client.get('/api/v1/jobs/' + task['id'], headers=other).status_code == 404


def test_migration_folders_and_verified_coordinates(client):
    headers, _ = account(client)
    item = {'source_id': 'rp:123', 'title': 'Imported', 'folder': 'Research/Rendering', 'file_hash': 'a' * 64,
            'notes': ['A note'], 'progress': {'page': 4}, 'annotations': [
                {'coordinate_system': 'normalized-top-left-v1', 'type': 'highlight', 'page': 1, 'rects': [[.1, .1, .3, .2]]},
                {'page': 8, 'legacy_coordinates': [24, 120, 150, 180]}]}
    report = client.post('/api/v1/migration/commit', headers=headers, json={'items': [item]}).json()
    assert report['imported'] == 1 and len(report['failures']) == 1
    assert len(client.get('/api/v1/library?kind=folder', headers=headers).json()['items']) == 2
    assert len(client.get('/api/v1/library?kind=annotation', headers=headers).json()['items']) == 1


def test_malformed_migration_and_annotation_return_validation_errors(client):
    headers, _ = account(client)
    bad = {'source_id': 'rp:bad', 'title': 'Invalid', 'annotations': 4}
    assert client.post('/api/v1/migration/commit', headers=headers, json={'items': [bad]}).status_code == 422
    for data in [{'type': 'ink', 'page': 1, 'points': ['not a point']}, {'type': 'highlight', 'page': 1, 'rects': [2]}, {'type': 'text', 'page': 1, 'color': []}]:
        assert sync(client, headers, [operation('annotation', data)]).status_code == 422


def test_scanned_pdf_and_rotated_annotation_render():
    from backend.pdf import inspect_pdf, export_annotations, render_page
    blank = PdfWriter(); blank.add_blank_page(width=200, height=300)
    stream = io.BytesIO(); blank.write(stream)
    assert inspect_pdf(stream.getvalue())['needs_ocr'] is True
    rotated = PdfWriter(); rotated.append(PdfReader(io.BytesIO(pdf_bytes())))
    rotated.pages[0].rotate(90)
    source = io.BytesIO(); rotated.write(source)
    result = export_annotations(source.getvalue(), [{'page': 1, 'type': 'highlight', 'rects': [[.1, .1, .4, .2]], 'color': '#edb83c'}])
    assert len(PdfReader(io.BytesIO(result)).pages) == 2
    from PIL import Image, ImageChops
    before = Image.open(io.BytesIO(render_page(source.getvalue(), 1)))
    after = Image.open(io.BytesIO(render_page(result, 1)))
    assert before.size == after.size
    assert ImageChops.difference(before.convert('RGB'), after.convert('RGB')).getbbox() is not None


def test_line_and_chinese_text_have_explicit_visible_appearances():
    from backend.pdf import export_annotations, render_page
    from PIL import Image, ImageChops
    source = pdf_bytes()
    baseline = Image.open(io.BytesIO(render_page(source, 1))).convert('RGB')
    for kind in ('line', 'text', 'ink'):
        result = export_annotations(source, [{'page': 1, 'type': kind, 'color': '#4562ed', 'rects': [[.1, .2, .6, .3]],
            'points': [{'x': .1, 'y': .2, 'pressure': .2}, {'x': .6, 'y': .3, 'pressure': 1}], 'text': '中文批注 Test'}])
        annotation = PdfReader(io.BytesIO(result)).pages[0]['/Annots'][0].get_object()
        appearance = annotation['/AP']['/N'].get_object()
        assert appearance.get_data()
        after = Image.open(io.BytesIO(render_page(result, 1))).convert('RGB')
        assert ImageChops.difference(baseline, after).getbbox() is not None
        if kind == 'text':
            fonts = appearance['/Resources']['/Font'].values()
            assert any('STSong-Light' in str(f.get_object().get('/BaseFont', '')) for f in fonts)


def test_figure_upload_normalizes_image_mime(client, monkeypatch):
    from PIL import Image
    import base64
    headers, _ = account(client); paper_id, _ = paper_with_file(client, headers)
    client.put('/api/v1/providers/ai', headers=headers, json={'endpoint': 'https://example.com/v1', 'model': 'vision', 'api_key': 'fixture-key'})
    image = io.BytesIO(); Image.new('RGB', (100, 80), 'white').save(image, format='JPEG')
    def complete(config, secret, messages):
        url = messages[1]['content'][1]['image_url']['url']
        assert url.startswith('data:image/png;base64,')
        assert base64.b64decode(url.split(',', 1)[1]).startswith(b'\x89PNG')
        return 'Image explanation [第1页]'
    monkeypatch.setattr('backend.tasks.complete', complete)
    task = client.post('/api/v1/jobs', headers=headers, json={'kind': 'figure', 'paper_id': paper_id, 'pages': [1], 'image_base64': base64.b64encode(image.getvalue()).decode()}).json()
    assert client.get('/api/v1/jobs/' + task['id'], headers=headers).json()['state'] == 'completed'
