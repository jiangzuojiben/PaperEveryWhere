"""Bounded, opt-in native-ink research on the fixed synthetic cloud fixture.

Only aggregate outcomes are persisted. An accepted legacy metadata record is
deliberately distinguished from a native stroke with verified geometry.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import uuid

from backend.readpaper import APP, ReadPaper
from scripts.verify_readpaper_live import current_cookies, fixture, protected_snapshot, select_test

NATIVE_PATH = '/pdfMark/v2/ios/pencil/batch/save'
LEGACY_PATH = '/pdfMark/v2/ios/save'


def stroke_matches(actual, expected):
    """A receipt or an empty legacy URL never proves a native stroke exists."""
    if not isinstance(actual, dict):
        return False
    keys = ('id', 'tooltype', 'drawShapeType', 'lineHexColor', 'lineAlpha', 'lineWidth', 'points')
    return all(key in actual and actual[key] == expected[key] for key in keys)


def observe(remote, context):
    marks = remote.call('GET', APP+'/pdfMark/v3/web/getByNote',
                        {'noteId': context['noteId'], 'handtext': 'true'}) or []
    drawings = remote.call('GET', APP+'/pdfMark/v3/web/draw/getByNote',
                           {'noteId': context['noteId'], 'fetchAll': 'true', 'handwrite': 'true'}) or []
    strokes = [item for wrapper in drawings for item in
               (wrapper.get('webDrawV2') or {}).get('webDrawItems') or []]
    return marks, drawings, strokes


def request_candidate(remote, path, body):
    # No retry of a mutation. A transport error has an unknown result.
    response = remote.client.post(APP+path, json=body)
    result = response.json()
    message = result.get('message') or result.get('msg') or ''
    labels = {'不能为null\n': 'required_field_unknown', '不能为null': 'required_field_unknown',
              '缺少笔触信息': 'pencil_missing', '标注缺少页码信息': 'page_missing', '缺少paperId': 'paper_missing'}
    summary = {'http_status': response.status_code, 'status': result.get('status'),
               'result': labels.get(message, 'accepted' if result.get('status') == 1 else 'rejected'),
               'receipt_type': type(result.get('data')).__name__}
    receipt = result.get('data') if result.get('status') == 1 else None
    return summary, receipt


def verify(remote, cookies, report, *, legacy_control=False):
    paper = select_test(remote)
    protected = protected_snapshot(remote, paper['id'])
    remote.prepare(paper['id'])
    if hashlib.sha256(remote.pdf_bytes).digest() != hashlib.sha256(fixture()).digest():
        raise RuntimeError('Fixed synthetic fixture bytes differ; refusing writes')
    context = dict(remote.contexts[paper['id']])
    marks, drawings, _ = observe(remote, context)
    if marks or drawings:
        raise RuntimeError('The synthetic fixture is not empty; refusing writes or cleanup')
    legacy_id = None
    stroke = {'id': str(uuid.uuid4()), 'tooltype': 1, 'drawShapeType': 0,
              'lineHexColor': '#338AFF', 'lineAlpha': 1, 'lineWidth': 3,
              'points': [{'x': 95, 'y': 190, 'pressure': .4}, {'x': 190, 'y': 220, 'pressure': .8}]}
    base = {'orgId': '535992339879038976', 'appId': 'aiKnowledge', 'noteId': context['noteId'],
            'pdfId': context['pdfId'], 'paperId': paper['data']['source_paper_id'], 'pageNumber': 1}
    report['checks']['synthetic_bytes_and_empty_cloud_fixture_confirmed'] = True
    try:
        if legacy_control:
            # Isolate the old schema's page field. No original nsDataUrl is used.
            result, receipt = request_candidate(remote, LEGACY_PATH,
                {**base, 'page': 1, 'type': 2, 'pencil': {'nsDataUrl': ''}})
            report['legacy_control'] = result
            if isinstance(receipt, (str, int)):
                legacy_id = str(receipt)
            marks, _, strokes = observe(remote, context)
            report['checks']['legacy_record_readback'] = bool(legacy_id) and any(
                mark.get('type') == 2 and (mark.get('drawAnnotation') or {}).get('nsDataUrl') == '' for mark in marks)
            report['checks']['legacy_acceptance_not_misreported_as_native_ink'] = not strokes
            if legacy_id:
                remote.call('DELETE', APP+'/pdfMark/v2/web/delete',
                            {'id': legacy_id, 'annotationId': legacy_id, 'noteId': context['noteId']})
                legacy_id = None
            if any(observe(remote, context)[:2]):
                raise RuntimeError('Legacy control cleanup not confirmed; native probe skipped')
        result, _ = request_candidate(remote, NATIVE_PATH,
            {**base, 'page': 1, 'type': 5, 'pencils': [{**stroke, 'page': 1, 'pageNumber': 1}]})
        report['native_candidate'] = {**result, 'path': NATIVE_PATH,
                                      'authority': 'bounded hypothesis; absent from desktop write calls'}
        _, _, strokes = observe(remote, context)
        report['native_creation_verified'] = any(stroke_matches(item, stroke) for item in strokes)
        second = ReadPaper(cookies)
        try:
            second.index()
            second.prepare(paper['id'])
            _, _, second_strokes = observe(second, second.contexts[paper['id']])
            report['independent_native_geometry_verified'] = any(stroke_matches(item, stroke) for item in second_strokes)
            report['checks']['independent_session_readback_consistent'] = (
                report['native_creation_verified'] == report['independent_native_geometry_verified'])
        finally:
            second.close()
    finally:
        # Cleanup is scoped to a verified empty dedicated fixture, never a user
        # paper or a note with preexisting records. Receipt stays in RAM only.
        if legacy_id:
            remote.call('DELETE', APP+'/pdfMark/v2/web/delete',
                        {'id': legacy_id, 'annotationId': legacy_id, 'noteId': context['noteId']})
        _, _, strokes = observe(remote, context)
        identifiers = [str(item['id']) for item in strokes if item.get('id')]
        if identifiers:
            remote.call('DELETE', APP+'/pdfMark/v2/web/pencil/batch/delete', {'id': identifiers})
        marks, drawings, _ = observe(remote, context)
        report['checks']['test_cloud_records_cleanup_confirmed'] = not marks and not drawings
        remote.index()
        report['checks']['original_library_memberships_unchanged'] = protected_snapshot(remote, paper['id']) == protected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute-writes', action='store_true')
    parser.add_argument('--legacy-control', action='store_true')
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if not args.execute_writes or args.report.exists():
        raise SystemExit('Explicit --execute-writes and a fresh report path are required')
    report = {'format': 'paperdesk-native-ink-research-live-v1',
              'checked_at': datetime.now(timezone.utc).isoformat(), 'desktop_ui_used': False,
              'business_storage': 'memory-only', 'scope': 'fixed synthetic test PDF only',
              'checks': {}, 'research_checks_passed': False, 'native_creation_verified': False,
              'independent_native_geometry_verified': False}
    cookies = current_cookies()
    remote = ReadPaper(cookies)
    try:
        verify(remote, cookies, report, legacy_control=args.legacy_control)
        report['research_checks_passed'] = all(report['checks'].values())
    except Exception as exc:
        # No exception message: upstream bodies/URLs/identifiers can be sensitive.
        report['error_type'] = type(exc).__name__
        report['error_status'] = getattr(exc, 'status_code', None)
    finally:
        remote.close()
        cookies.clear()
        report['session_released'] = remote.pdf_bytes is None and not remote.client.cookies
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
    if not report['research_checks_passed']:
        raise SystemExit(1)
    if not (report['native_creation_verified'] and report['independent_native_geometry_verified']):
        raise SystemExit(2)  # Explicitly incomplete; never a native-creation pass.


if __name__ == '__main__':
    main()
