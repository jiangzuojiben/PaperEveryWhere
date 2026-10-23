"""Bounded ReadPaper cloud diagnostics; no AI jobs, uploads or account changes.

Explicit --use-current-session reads only ReadPaper's two session cookies into
memory. Reports retain response status, field names and allowlisted capability
values, never cookies, raw profiles, signed URLs or response error text.
"""
import argparse
import base64
from contextlib import closing
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3

import httpx

CHECKS = [
    ('translation_channels', 'GET', '/microService-app-aiKnowledge/aiKnowledge/ts/getTranslateTabList'),
    ('effective_account_privileges', 'GET', '/microService-app-aiKnowledge/vip/profile'),
    ('ai_bean_balance', 'GET', '/readpaper-pay/pay/bean/count'),
    ('system_questions', 'GET', '/microservice-ai-reading/systemQuestion/list'),
    ('fulltext_translation_rights', 'POST', '/microService-app-aiKnowledge/fullTextTranslate/getRightInfo'),
    ('scim_config', 'GET', '/microservice-ai-reading/scim/getConfig'),
]
PRIVILEGES = {
    'readingEnable', 'polishEnable', 'aiTranslateEnable', 'aiReadingDocumentPageCountLimit',
    'wordSelectionTranslateCountLimit', 'ocrTranslateCountLimit', 'fullTextTranslationCountLimit',
    'fullTextTranslatePageCountLimit', 'aiTranslateConsumeBeanCount', 'readingAskQuestion',
}


def summarize(name, response):
    body = response.json()
    data = body.get('data')
    row = {'name': name, 'http_status': response.status_code, 'status': body.get('status'),
           'code': body.get('code'), 'data_type': type(data).__name__}
    if isinstance(data, dict):
        row['data_keys'] = sorted(data)
    else:
        return row
    if name == 'effective_account_privileges':
        roles = data.get('vipRoles') or []
        effective = (roles[0].get('vipPrivilege') or {}) if roles else {}
        row.update(role_count=len(roles), vip_type=roles[0].get('vipType') if roles else None,
                   basis='vipRoles[0].vipPrivilege; top-level vipPrivilege is not effective',
                   capabilities={key: effective[key] for key in sorted(PRIVILEGES) if key in effective})
    elif name == 'ai_bean_balance':
        keys = ('aiBeanCount', 'aiBeanCountCostEveryQuesion', 'aiBeanCountCostEveryAiTranslate')
        row['quota'] = {key: data.get(key) for key in keys}
    elif name == 'translation_channels':
        row['channels'] = [v for v in data.get('translateType', []) if isinstance(v, str)]
    elif name == 'fulltext_translation_rights':
        row['remaining'] = data.get('remainCount')
    elif name == 'scim_config':
        row['capabilities'] = {key: data.get(key) for key in ('canUse', 'remainingTimes')}
    elif name == 'system_questions':
        row['question_count'] = len(data.get('items') or [])
    return row


def probe(use_current_session, paper_id=None):
    headers = {'Authorization': 'Basic ' + base64.b64encode(b'aiKnowledge:readpaper_com').decode(),
               'Origin': 'https://readpaper.com', 'Referer': 'https://readpaper.com/', 'i18n': 'zh'}
    results = []
    with httpx.Client(base_url='https://readpaper.com/api', headers=headers,
                      timeout=30, follow_redirects=False) as client:
        if use_current_session:
            cookie_db = Path(os.environ['APPDATA']) / 'ReadPaper' / 'Cookies'
            with closing(sqlite3.connect(cookie_db.resolve().as_uri() + '?mode=ro', uri=True)) as database:
                values = dict(database.execute("SELECT name,value FROM cookies WHERE host_key='.readpaper.com' "
                                              "AND name IN ('aiKnowledge-token','aiKnowledge-UID')"))
            if not values.get('aiKnowledge-token'):
                raise ValueError('No readable current ReadPaper session; login required in the original application')
            for key, value in values.items():
                client.cookies.set(key, value, domain='readpaper.com', path='/')
        checks = [(*check, {}) for check in CHECKS]
        if paper_id:
            if not paper_id.isdigit():
                raise ValueError('paper-id must be an existing numeric scholarly paper ID')
            checks.append(('paper_detail', 'POST', '/microService-app-aiKnowledge/aiKnowledge/paper/getById', {'id': paper_id}))
        for name, method, path, payload in checks:
            try:
                response = client.request(method, path, **({'json': payload} if method == 'POST' else {}))
                row = summarize(name, response)
            except (httpx.HTTPError, ValueError, TypeError, KeyError) as error:
                row = {'name': name, 'error_type': type(error).__name__}
            results.append({'method': method, 'path': path, **row})
        if use_current_session:
            with httpx.Client(base_url=client.base_url, headers=headers, timeout=30,
                              follow_redirects=False) as anonymous:
                response = anonymous.get('/readpaper-pay/pay/bean/count')
                results.append({'method': 'GET', 'path': '/readpaper-pay/pay/bean/count',
                                **summarize('anonymous_ai_bean_control', response)})
    return {'format': 'paperdesk-readpaper-cloud-readonly-probe-v1',
            'checked_at': datetime.now(timezone.utc).isoformat(),
            'session_mode': 'current-original-application' if use_current_session else 'anonymous',
            'desktop_ui_used': False, 'ai_jobs_submitted': 0, 'uploads': 0,
            'token_refresh_attempts': 0, 'raw_credentials_saved': False, 'checks': results}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--use-current-session', action='store_true')
    parser.add_argument('--paper-id')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Choose a new output file to preserve earlier diagnostics')
    report = probe(args.use_current_session, args.paper_id)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
