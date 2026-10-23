"""Research safeguards; the unknown native write envelope is not a contract."""
import copy
import json

import httpx
import pytest
from fastapi import HTTPException

from backend.readpaper import APP, DOC
from backend.tests.test_cloud_files import FilesUpstream
from scripts.verify_readpaper_ink_live import LEGACY_PATH, NATIVE_PATH, stroke_matches, verify
from scripts import verify_readpaper_ink_live as ink_live
from scripts.verify_readpaper_live import TITLE, fixture


class InkResearchUpstream(FilesUpstream):
    def __init__(self):
        super().__init__()
        self.content = fixture()
        self.marks = []
        self.legacy = []
        self.mutations = []
        self.fail_legacy_read_once = False

    def respond(self, request):
        path = request.url.path.removeprefix('/api')
        if path == DOC+'/userDoc/getDocIndex':
            response = super().respond(request)
            body = response.json()
            body['data']['folderInfos'][0]['docInfos'][0]['docName'] = TITLE
            return httpx.Response(200, json=body)
        if path == APP+LEGACY_PATH:
            self.mutations.append('legacy-create')
            self.legacy = [{'type': 2, 'pageNumber': 1, 'drawAnnotation': {'nsDataUrl': ''}}]
            return httpx.Response(200, json={'status': 1, 'data': 'legacy-test-id'})
        if path == APP+NATIVE_PATH:
            self.mutations.append('native-candidate')
            # A generic validation rejection is the observed live outcome.
            return httpx.Response(200, json={'status': 0, 'message': '不能为null\n'})
        if path.endswith('/pdfMark/v3/web/getByNote') and self.legacy:
            if self.fail_legacy_read_once:
                self.fail_legacy_read_once = False
                raise httpx.ReadTimeout('sensitive upstream details must not be logged')
            return httpx.Response(200, json={'status': 1, 'data': self.legacy})
        if path.endswith('/pdfMark/v2/web/delete') and self.legacy:
            assert json.loads(request.content)['id'] == 'legacy-test-id'
            self.mutations.append('legacy-delete')
            self.legacy = []
            return httpx.Response(200, json={'status': 1, 'data': {}})
        return super().respond(request)


def test_accepted_legacy_record_is_not_a_native_creation_pass(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    upstream = InkResearchUpstream()
    monkeypatch.setattr(ink_live, 'ReadPaper', lambda cookies: upstream.remote())
    remote = upstream.remote()
    report = {'checks': {}}
    try:
        verify(remote, {}, report, legacy_control=True)
        assert all(report['checks'].values())
        assert report['legacy_control']['result'] == 'accepted'
        assert report['native_creation_verified'] is False
        assert report['independent_native_geometry_verified'] is False
        assert report['native_candidate']['result'] == 'required_field_unknown'
        assert upstream.mutations == ['legacy-create', 'legacy-delete', 'native-candidate']
        assert not upstream.legacy and list(tmp_path.rglob('*')) == []
        assert 'legacy-test-id' not in json.dumps(report)
    finally:
        remote.close()


@pytest.mark.parametrize('guard', ['wrong-pdf', 'nonempty-note'])
def test_research_refuses_existing_content_and_never_cleans_it(guard):
    upstream = InkResearchUpstream()
    if guard == 'wrong-pdf':
        upstream.content = fixture(2)
    else:
        upstream.legacy = [{'type': 2, 'pageNumber': 1, 'drawAnnotation': {'nsDataUrl': ''}}]
    original = copy.deepcopy(upstream.legacy)
    remote = upstream.remote()
    try:
        with pytest.raises(RuntimeError):
            verify(remote, {}, {'checks': {}}, legacy_control=True)
        assert upstream.mutations == [] and upstream.legacy == original
    finally:
        remote.close()


def test_legacy_receipt_is_cleaned_after_readback_transport_failure():
    upstream = InkResearchUpstream()
    upstream.fail_legacy_read_once = True
    remote = upstream.remote()
    report = {'checks': {}}
    try:
        with pytest.raises(HTTPException):
            verify(remote, {}, report, legacy_control=True)
        assert not upstream.legacy and upstream.mutations == ['legacy-create', 'legacy-delete']
        assert report['checks']['test_cloud_records_cleanup_confirmed']
    finally:
        remote.close()


def test_stroke_verification_requires_geometry_and_captured_pressure():
    expected = {'id': 'synthetic-stroke', 'tooltype': 1, 'drawShapeType': 0, 'lineHexColor': '#338AFF',
                'lineAlpha': 1, 'lineWidth': 3, 'points': [{'x': 95, 'y': 190, 'pressure': .4}]}
    assert stroke_matches(copy.deepcopy(expected), expected)
    assert not stroke_matches({'nsDataUrl': ''}, expected)
    assert not stroke_matches({'id': expected['id']}, expected)
    changed = copy.deepcopy(expected)
    changed['points'][0]['pressure'] = .8
    assert not stroke_matches(changed, expected)
