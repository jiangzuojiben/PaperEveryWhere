"""Create offline annotated-page proofs and verify the migrated local workspace."""
import argparse
from collections import Counter, defaultdict
from contextlib import closing
import hashlib
import io
import json
import logging
from pathlib import Path
import sqlite3
import sys

from PIL import ImageChops
from pypdf import PdfReader, PdfWriter
import pypdfium2 as pdfium

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.pdf import export_annotations


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def make_previews(root):
    logging.getLogger('pypdf').setLevel(logging.ERROR)
    annotations = read(root / 'native-overlays.json')['annotations']
    grouped = defaultdict(list)
    for annotation in annotations:
        grouped[annotation['file_hash']].append(annotation)
    proofs = []
    folder = root / 'annotation-previews'
    folder.mkdir(exist_ok=True)
    screenshots = root / 'overlay-render-checks'
    screenshots.mkdir(exist_ok=True)
    for paper in read(root / 'complete-manifest.json')['papers']:
        items = grouped.get(paper['sha256'])
        if not items:
            continue
        original = root / paper['file']
        if digest(original) != paper['sha256']:
            raise ValueError('Original PDF changed')
        pages = sorted({a['page'] for a in items})
        page_map = {page: index + 1 for index, page in enumerate(pages)}
        reader = PdfReader(original)
        writer = PdfWriter()
        writer.append(reader, pages=[p - 1 for p in pages], import_outline=False)
        writer.add_metadata({'/Title': paper['title'] + ' - annotated pages',
                             '/Subject': 'Proof copy; original page numbers are in previews-index.json.'})
        selected = io.BytesIO()
        writer.write(selected)
        proof = export_annotations(selected.getvalue(), [{**a, 'page': page_map[a['page']]} for a in items])
        pdf_id = paper['source_id'].rsplit(':', 1)[1]
        path = folder / (pdf_id + '.pdf')
        path.write_bytes(proof)
        checks = []
        with pdfium.PdfDocument(path) as document:
            for index, source_page in enumerate(pages):
                with closing(document[index]) as page:
                    with closing(page.render(scale=1, draw_annots=True)) as bitmap:
                        image = bitmap.to_pil().convert('RGB')
                    with closing(page.render(scale=1, draw_annots=False)) as bitmap:
                        base = bitmap.to_pil().convert('RGB')
                    difference = ImageChops.difference(image, base)
                    box = difference.getbbox()
                    if not box:
                        raise ValueError(f'No visible overlay on {pdf_id} page {source_page}')
                    checks.append({'source_page': source_page, 'preview_page': index + 1,
                                   'render_size': image.size, 'changed_bbox': box,
                                   'annotation_count': sum(a['page'] == source_page for a in items)})
                    # Keep one review image per document; every page is checked above.
                    if index == 0:
                        image.save(screenshots / f'{pdf_id}-p{source_page}.png')
        proofs.append({'file': path.relative_to(root).as_posix(), 'sha256': digest(path),
                       'pages': len(pages), 'source_pages': pages, 'source_id': paper['source_id'],
                       'title': paper['title'], 'original_file': paper['file'],
                       'original_sha256': paper['sha256'], 'render_checks': checks})
        print(json.dumps({'preview': pdf_id, 'pages': len(pages), 'overlays': len(items)}), flush=True)
    index = {'format': 'paperdesk-annotated-page-proofs-v1', 'previews': proofs,
             'description': 'Only annotated pages, ordered as in original PDFs. Source pages are one-based; originals remain byte-identical.',
             'rendered_pages': sum(p['pages'] for p in proofs)}
    (root / 'previews-index.json').write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding='utf-8')
    return index


def verify_database(root, database):
    expected = read(root / 'native-overlays.json')['annotations']
    manifest = read(root / 'complete-manifest.json')
    with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        integrity = db.execute('PRAGMA integrity_check').fetchone()[0]
        if integrity != 'ok':
            raise ValueError('Database integrity failure')
        entities = {r[0]: {'kind': r[1], 'scope': r[2], 'data': json.loads(r[3]), 'deleted': bool(r[4])}
                    for r in db.execute('SELECT id,kind,scope,data,deleted FROM entities')}
        papers = {r['data'].get('source_id'): r['data'] for r in entities.values() if r['kind'] == 'paper' and not r['deleted']}
        for item in manifest['papers']:
            if papers[item['source_id']]['file_hash'] != item['sha256']:
                raise ValueError('Paper PDF identity mismatch')
            blob = db.execute('SELECT bytes FROM blobs WHERE hash=?', (item['sha256'],)).fetchone()
            if not blob or hashlib.sha256(blob[0]).hexdigest() != item['sha256']:
                raise ValueError('Database blob hash mismatch')
        for annotation in expected:
            actual = entities[annotation['id']]
            if actual['kind'] != 'annotation' or actual['deleted']:
                raise ValueError('Overlay missing from database')
            if any(actual['data'].get(k) != v for k, v in annotation.items() if k != 'id'):
                raise ValueError('Overlay data does not match reviewed conversion')
            if annotation['id'] not in entities[annotation['source_note_id']]['data']['overlay_ids']:
                raise ValueError('Original note not linked to overlay')
        order = []
        for seq, payload in db.execute('SELECT seq,payload FROM outbox ORDER BY seq'):
            op = json.loads(payload)
            order.append(op['entity_id'])
            if entities[op['entity_id']]['data'] != op['data']:
                raise ValueError('Pending sync data differs from saved entity')
        positions = {identifier: i for i, identifier in enumerate(order)}
        for identifier in order:
            data = entities[identifier]['data']
            references = [data.get(k) for k in ('paper_id', 'folder_id', 'parent_id')] + data.get('folder_ids', [])
            for ref in filter(None, references):
                if ref in positions and positions[ref] >= positions[identifier]:
                    raise ValueError('Pending sync dependency order is invalid')
        return {'integrity_check': integrity, 'entity_counts': dict(Counter(v['kind'] for v in entities.values() if not v['deleted'])),
                'original_pdf_hashes_verified': len(manifest['papers']),
                'native_overlays_verified': len(expected), 'note_links_verified': len(expected),
                'pending_sync_operations': len(order), 'outbox_dependencies': 'pass'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('export', type=Path)
    parser.add_argument('--database', type=Path)
    parser.add_argument('--reuse-previews', action='store_true')
    args = parser.parse_args()
    index = read(args.export / 'previews-index.json') if args.reuse_previews else make_previews(args.export)
    for preview in index['previews']:
        if digest(args.export / preview['file']) != preview['sha256']:
            raise ValueError('Preview hash mismatch')
    report = {'preview_documents': len(index['previews']), 'preview_pages_rendered': index['rendered_pages'],
              'all_pages_have_visible_overlay': True,
              'verification_boundary': 'Offline PDFium renders and database readback; no desktop or mobile UI operated.'}
    if args.database:
        report['database'] = verify_database(args.export, args.database)
    (args.export / 'overlay-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
