"""Explicit opt-in live validation, restricted to a uniquely named test paper.

No PDF, cookie, signed URL, note body, cloud identifier or stroke is written to
disk. Only aggregate verification outcomes are retained in the requested report.
Existing user papers are never targets of mutations.
"""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import sqlite3
import time

from reportlab.pdfgen import canvas

from backend.readpaper import ReadPaper

TITLE = 'PaperDesk-Cloud-Validation-20261023.pdf'


def fixture(version=1):
    target = BytesIO()
    pdf = canvas.Canvas(target, pagesize=(600, 800), invariant=1)
    pdf.setTitle('PaperDesk isolated cloud validation 20261023')
    for page in range(1, 3):
        pdf.setFont('Helvetica', 18)
        pdf.drawString(50, 740, 'PaperDesk cloud validation - isolated fixture')
        pdf.setFont('Helvetica', 12)
        pdf.drawString(50, 710, f'Page {page}. Existing user documents are not modified.')
        if version != 1:
            pdf.drawString(50, 680, f'Cloud version {version}: independent PDF and annotation identity.')
        pdf.setStrokeColorRGB(.2, .4, .8)
        pdf.rect(50, 450, 400, 180)
        pdf.showPage()
    pdf.save()
    return target.getvalue()


def current_cookies():
    path = Path(os.environ['APPDATA']) / 'ReadPaper/Cookies'
    with closing(sqlite3.connect(path.resolve().as_uri()+'?mode=ro', uri=True)) as database:
        return dict(database.execute("SELECT name,value FROM cookies WHERE host_key='.readpaper.com' "
                                     "AND name IN ('aiKnowledge-token','aiKnowledge-UID')"))


def select_test(remote):
    entries = remote.index()
    papers = [e for e in entries if e['kind'] == 'paper' and e['data']['title'] == TITLE]
    if len(papers) != 1:
        raise RuntimeError('Exactly one dedicated validation document is required')
    return papers[0]


def protected_snapshot(remote, test_id):
    return sorted((e['id'], e['data']['title'], tuple(sorted(e['data']['folder_ids'])))
                  for e in remote.entries.values() if e['kind'] == 'paper' and e['id'] != test_id
                  and not e['data']['title'].startswith('PaperDesk-Cloud-Validation-'))


def upload_checks(remote, cookies, paper, report):
    content = fixture(2)
    name = 'PaperDesk-Cloud-Validation-v2-20261023.pdf'
    operation = remote.upload(content, name)
    for attempt in range(30):
        if operation['state'] in ('completed', 'duplicate'): break
        if operation['state'] in ('conflict', 'failed', 'cancelled', 'unknown'):
            raise RuntimeError('Dedicated synthetic upload did not complete')
        time.sleep(1)
        operation = remote.upload_status(operation['id'])
    assert operation['state'] in ('completed', 'duplicate')
    report['checks']['memory_pdf_upload_confirmed'] = True
    print('Upload confirmed by cloud library', flush=True)
    repeated = remote.upload(content, name)
    assert repeated['state'] == 'duplicate' and repeated['paper_id'] == operation['paper_id']
    report['checks']['cloud_duplicate_detected_without_reupload'] = True
    other = ReadPaper(cookies)
    try:
        other.index()
        other.prepare(operation['paper_id'])
        assert hashlib.sha256(other.pdf_bytes).hexdigest() == hashlib.sha256(content).hexdigest()
        report['checks']['independent_session_uploaded_pdf_hash'] = True
        assert other.versions(operation['paper_id'])['supported'] is False
        report['checks']['standalone_pdf_versions_not_fabricated'] = True
        supported = next(e['id'] for e in other.entries.values() if e['kind']=='paper' and
                         e['data'].get('source_paper_id') not in (None,'','0','-1'))
        versions = other.versions(supported)
        assert versions['supported'] and versions['versions']
        report['checks']['live_native_versions_read'] = True
        report['native_version_sample_count'] = len(versions['versions'])
    finally:
        other.close()
    report['pending'] = ['Different-version live switch on an isolated scholarly paper', 'Native ink creation protocol']


def version_checks(remote, cookies, report):
    # Public ReadPaper catalogue page; refuse if it is already in this library.
    public_id = '2948947170'
    title = 'What Does BERT Learn about the Structure of Language?'
    if any(str(d.get('paperId')) == public_id for d in remote.documents.values()):
        raise RuntimeError('Public verification paper is already owned; refusing mutations')
    protected = protected_snapshot(remote, '')
    collected = False
    initial_pdf = None
    cleanup_pdf = None
    try:
        remote.call('POST', '/microService-app-aiKnowledge/userDoc/collectPaper', {'paperId':public_id,'paperTitle':title})
        collected = True
        remote.index()
        paper = next(e for e in remote.entries.values() if e['kind']=='paper' and e['data'].get('source_paper_id') == public_id)
        details = remote.details(paper['id'])
        initial_pdf = paper['data']['source_pdf_id']
        cleanup_pdf = initial_pdf
        initial_hash = remote.paper(paper['id'])['data']['file_hash']
        first_bytes = remote.pdf_bytes
        versions = remote.versions(paper['id'])
        # Remove only our named residue from an interrupted earlier test.
        for value in list(remote.annotations()):
            if value['data'].get('text') == 'PaperDesk isolated version validation':
                remote.write('annotation',value['data'],value['id'],value['revision'],True)
        alternate = next(v for v in versions['versions'] if v['pdf_id'] != initial_pdf)
        created = remote.write('annotation',{'paper_id':paper['id'],'file_hash':initial_hash,'page':1,'type':'highlight',
            'rects':[[.1,.1,.3,.12]],'color':'#338AFF','text':'PaperDesk isolated version validation'})
        initial_note = remote.contexts[paper['id']]['noteId']
        switched = remote.select_version(paper['id'],alternate['pdf_id'])
        second = remote.details(switched['paper_id'])
        report['observations'] = {'selected_pdf_context_changed':remote.contexts[switched['paper_id']]['pdfId'] == alternate['pdf_id'],
            'selected_note_context_changed':remote.contexts[switched['paper_id']]['noteId'] != initial_note,
            'selected_bytes_changed':remote.paper(switched['paper_id'])['data']['file_hash'] != initial_hash,
            'created_mark_absent':all(e['id'] != created['id'] for e in second['entries'])}
        assert report['observations']['selected_pdf_context_changed'], 'Selected version PDF context not confirmed'
        report['checks']['live_cross_version_selection_readback'] = True
        report['checks']['annotation_state_reloaded_from_cloud'] = True
        print('Version selection confirmed; cloud note sharing recorded separately',flush=True)
        independent = ReadPaper(cookies)
        try:
            independent.index()
            target = next(e for e in independent.entries.values() if e['kind']=='paper' and e['data'].get('source_paper_id')==public_id)
            independent.details(target['id'])
            assert independent.paper(target['id'])['data']['source_pdf_id'] == alternate['pdf_id']
            assert (created['id'] not in independent.entries) == report['observations']['created_mark_absent']
            report['checks']['independent_session_selected_version'] = True
        finally: independent.close()
        restored = remote.select_version(switched['paper_id'],initial_pdf)
        remote.details(restored['paper_id'])
        original = remote.entries[created['id']]
        remote.write('annotation',original['data'],original['id'],original['revision'],True)
        report['checks']['version_restored_and_test_annotation_removed'] = True
        # A memory-only metadata revision of this newly collected public paper.
        # No file from the user's original collection is used as test input.
        from pypdf import PdfReader, PdfWriter
        writer = PdfWriter();writer.append(PdfReader(BytesIO(first_bytes)))
        writer.add_metadata({'/PaperDeskValidation':'20261023 isolated in-memory version validation'})
        buffer = BytesIO();writer.write(buffer);new_content = buffer.getvalue()
        operation = remote.upload(new_content,'PaperDesk-Public-Version-Validation-20261023.pdf',version_of=restored['paper_id'])
        for attempt in range(40):
            if operation['state'] in ('completed','duplicate','unmatched','failed','cancelled','unknown'): break
            if operation['state'] == 'conflict':
                operation = remote.resolve_upload(operation['id'],False)
                report['checks']['dedicated_test_conflict_explicitly_resolved'] = True
            else:
                time.sleep(1);operation = remote.upload_status(operation['id'])
        assert operation['state'] in ('completed','duplicate'), 'Native matching-version upload not confirmed'
        selected_upload = remote.select_version(operation['paper_id'], operation['pdf_id'])
        remote.details(selected_upload['paper_id'])
        assert hashlib.sha256(remote.pdf_bytes).hexdigest() == hashlib.sha256(new_content).hexdigest(), 'Uploaded version identity does not match uploaded bytes'
        report['checks']['live_matching_new_version_upload'] = True
        report['checks']['new_version_bytes_verified'] = True
        independent = ReadPaper(cookies)
        try:
            independent.index()
            target = next(e for e in independent.entries.values() if e['kind']=='paper' and e['data'].get('source_paper_id')==public_id)
            independent.prepare(target['id'])
            assert hashlib.sha256(independent.pdf_bytes).hexdigest() == hashlib.sha256(new_content).hexdigest(), 'Independent session version bytes differ'
            report['checks']['independent_session_new_version_bytes'] = True
        finally: independent.close()
        print('Matching new-version upload and bytes verified',flush=True)
    finally:
        if collected:
            try:
                if cleanup_pdf:
                    remote.index()
                    target = next(e for e in remote.entries.values() if e['kind']=='paper' and e['data'].get('source_paper_id')==public_id)
                    restored_target = remote.select_version(target['id'], cleanup_pdf)
                    remote.details(restored_target['paper_id'])
                    for value in list(remote.annotations()):
                        if value['data'].get('text') == 'PaperDesk isolated version validation':
                            remote.write('annotation',value['data'],value['id'],value['revision'],True)
                    report['checks']['test_annotation_cleanup_readback'] = not any(
                        value['data'].get('text') == 'PaperDesk isolated version validation' for value in remote.annotations())
            finally:
                remote.release()
                remote.call('POST','/microService-app-aiKnowledge/userDoc/cancelCollectPaper',{'paperId':public_id})
                remote.index()
                report['checks']['temporary_public_paper_removed'] = not any(e['kind']=='paper' and e['data'].get('source_paper_id')==public_id for e in remote.entries.values())
                report['checks']['existing_library_memberships_unchanged'] = protected_snapshot(remote,'') == protected


def basic(remote, cookies, paper, report):
    details = remote.details(paper['id'])
    digest = remote.paper(paper['id'])['data']['file_hash']
    if digest != hashlib.sha256(fixture()).hexdigest():
        raise RuntimeError('Dedicated test PDF differs; refusing to write')
    original_note = next(e for e in details['entries'] if e['kind'] == 'note')
    original_progress = next(e for e in details['entries'] if e['kind'] == 'progress')
    created = []
    try:
        for index, kind in enumerate(['highlight', 'rectangle', 'text']):
            value = remote.write('annotation', {'paper_id': paper['id'], 'file_hash': digest, 'page': 1,
                'type': kind, 'rects': [[.1, .2+index*.1, .5, .24+index*.1]], 'color': '#338AFF',
                'text': 'PaperDesk isolated validation '+kind, 'font_size': .02})
            created.append(value)
            report['checks'][kind+'_create_readback'] = True
            print(kind+' create/readback passed', flush=True)
            changed = remote.write('annotation', {**value['data'], 'text': 'PaperDesk verified '+kind, 'color': '#F24030'},
                                   value['id'], value['revision'])
            created[-1] = changed
            report['checks'][kind+'_update_readback'] = True
        summary = remote.write('note', {**original_note['data'], 'content': 'PaperDesk isolated cloud summary validation'},
                               original_note['id'], original_note['revision'])
        report['checks']['summary_write_readback'] = True
        remote.write('progress', {**original_progress['data'], 'page': 2})
        report['checks']['progress_write_readback'] = True
        other = ReadPaper(cookies)
        try:
            other.index()
            reopened = other.details(paper['id'])
            values = {e['id']: e for e in reopened['entries']}
            assert all(values[e['id']]['data']['text'] == e['data']['text'] for e in created)
            assert values[summary['id']]['data']['content'] == summary['data']['content']
            assert next(e for e in values.values() if e['kind']=='progress')['data']['page'] == 2
            report['checks']['independent_session_reopen'] = True
        finally:
            other.close()
        remote.write('note', original_note['data'], summary['id'], summary['revision'])
        remote.write('progress', original_progress['data'])
        report['checks']['test_note_progress_restored'] = True
    finally:
        for value in reversed(created):
            latest = {e['id']: e for e in remote.annotations()}.get(value['id'])
            if latest:
                remote.write('annotation', latest['data'], latest['id'], latest['revision'], True)
        report['checks']['created_annotations_deleted_readback'] = bool(created) and all(
            value['id'] not in {e['id'] for e in remote.annotations()} for value in created)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--execute-writes', action='store_true')
    parser.add_argument('--phase', choices=['basic','upload','versions'], default='basic')
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if not args.execute_writes or args.report.exists():
        raise SystemExit('Explicit --execute-writes and a new report path are required')
    report = {'format':'paperdesk-readpaper-live-validation-v1', 'checked_at':datetime.now(timezone.utc).isoformat(),
              'desktop_ui_used':False, 'business_storage':'memory-only',
              'scope':'temporarily collected public test paper' if args.phase == 'versions' else 'dedicated synthetic test paper',
              'checks':{}, 'phase':args.phase, 'passed':False}
    cookies = current_cookies()
    remote = ReadPaper(cookies)
    try:
        paper = select_test(remote)
        before = protected_snapshot(remote, paper['id'])
        if args.phase == 'basic': basic(remote, cookies, paper, report)
        elif args.phase == 'upload': upload_checks(remote, cookies, paper, report)
        else: version_checks(remote,cookies,report)
        remote.index()
        report['checks']['existing_library_memberships_unchanged'] = protected_snapshot(remote, paper['id']) == before
        report['passed'] = all(report['checks'].values())
    except Exception as exc:
        report['error_type'] = type(exc).__name__
        report['error_status'] = getattr(exc, 'status_code', None)
        # These locally authored HTTP details contain no upstream body or secrets.
        if getattr(exc, 'detail', None): print(exc.detail, flush=True)
        elif isinstance(exc, AssertionError): print(str(exc),flush=True)
    finally:
        remote.close()
        cookies.clear()
        report['session_released'] = remote.pdf_bytes is None and not remote.client.cookies
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False), flush=True)
    if not report['passed']: raise SystemExit(1)


if __name__ == '__main__':
    main()
