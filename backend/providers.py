import httpx
import re
from html import unescape
from urllib.parse import quote
from fastapi import HTTPException
from .settings import settings


def normalize_crossref(item):
    date = item.get("published", {}).get("date-parts", [[]])[0]
    return {"source": "crossref", "doi": item.get("DOI"), "title": (item.get("title") or [""])[0],
            "authors": [" ".join(filter(None, [a.get("given"), a.get("family")])) for a in item.get("author", [])],
            "year": date[0] if date else None, "journal": (item.get("container-title") or [""])[0],
            "url": item.get("URL"), "references": item.get("reference", []), "citation_count": item.get("is-referenced-by-count"),
            "abstract": unescape(re.sub(r'<[^>]+>', '', item.get('abstract') or '')),
            "volume": item.get('volume'), "issue": item.get('issue'), "pages": item.get('page'),
            "publisher": item.get('publisher'), "issn": item.get('ISSN', []), "isbn": item.get('ISBN', []),
            "publication_type": item.get('type')}


def metadata_by_doi(doi: str):
    doi = re.sub(r'^https?://(?:dx\.)?doi\.org/', '', doi.strip(), flags=re.I)
    doi = re.sub(r'^doi:\s*', '', doi, flags=re.I)
    if not re.fullmatch(r'10\.\d{4,9}/\S+', doi) or len(doi) > 500:
        raise HTTPException(422, '请提供有效 DOI')
    params = {'mailto': settings.crossref_email} if settings.crossref_email else {}
    try:
        with httpx.Client(timeout=25, follow_redirects=True) as client:
            response = client.get('https://api.crossref.org/works/' + quote(doi, safe=''), params=params)
            if response.status_code == 404:
                raise HTTPException(404, 'Crossref 未收录此 DOI，可继续手工编辑')
            response.raise_for_status()
            return {'source': 'crossref', 'metadata': normalize_crossref(response.json()['message'])}
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        raise HTTPException(502, '元数据服务暂时不可用，请稍后重试') from exc


def discover(query: str, source="crossref", page=1):
    try:
        with httpx.Client(timeout=25, follow_redirects=True) as client:
            if source == "openalex":
                params = {"search": query, "per-page": 20, "page": page}
                if settings.openalex_key:
                    params["api_key"] = settings.openalex_key
                response = client.get("https://api.openalex.org/works", params=params)
                response.raise_for_status()
                result = response.json()
                return {"total": result.get("meta", {}).get("count", 0), "items": [{"source": "openalex", "source_id": w["id"],
                    "doi": w.get("doi"), "title": w.get("title"), "year": w.get("publication_year"),
                    "authors": [a["author"]["display_name"] for a in w.get("authorships", [])],
                    "citation_count": w.get("cited_by_count"), "references": w.get("referenced_works", []),
                    "url": (w.get("primary_location") or {}).get("landing_page_url"),
                    "pdf_url": (w.get("best_oa_location") or {}).get("pdf_url")} for w in result.get("results", [])]}
            params = {"query.bibliographic": query, "rows": 20, "offset": (page - 1) * 20}
            if settings.crossref_email:
                params["mailto"] = settings.crossref_email
            response = client.get("https://api.crossref.org/works", params=params)
            response.raise_for_status()
            result = response.json()["message"]
            return {"total": result["total-results"], "items": [normalize_crossref(w) for w in result["items"]]}
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        raise HTTPException(502, "学术数据源暂时不可用，请稍后重试") from exc


def complete(config, secret, messages):
    endpoint = config["endpoint"].rstrip("/")
    with httpx.Client(timeout=120) as client:
        response = client.post(endpoint + "/chat/completions", headers={"Authorization": f"Bearer {secret}"},
            json={"model": config["model"], "messages": messages, "temperature": 0.2})
        response.raise_for_status()
        return response.json()["choices"][0]["message"]["content"]


def relations(doi: str):
    doi = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", doi.strip(), flags=re.I)
    if not re.match(r"^10\.\d{4,9}/\S+$", doi):
        raise HTTPException(422, "请提供有效 DOI")
    params = {"api_key": settings.openalex_key} if settings.openalex_key else {}
    try:
        with httpx.Client(timeout=25, follow_redirects=True) as client:
            response = client.get("https://api.openalex.org/works/https://doi.org/" + quote(doi, safe="/"), params=params)
            response.raise_for_status(); work = response.json()
            identifier = work['id'].rsplit('/', 1)[-1]
            def projected(items):
                return [{"id": w['id'], "title": w.get('title', ''), "doi": w.get('doi'), "year": w.get('publication_year'),
                         "authors": [a['author']['display_name'] for a in w.get('authorships', [])]} for w in items]
            references = work.get('referenced_works', [])[:20]
            refs = []
            if references:
                ids = '|'.join(value.rsplit('/', 1)[-1] for value in references)
                ref_response = client.get('https://api.openalex.org/works', params={**params, 'filter': 'openalex:' + ids, 'per-page': 20})
                ref_response.raise_for_status(); refs = projected(ref_response.json().get('results', []))
            cited = client.get('https://api.openalex.org/works', params={**params, 'filter': 'cites:' + identifier, 'per-page': 20})
            cited.raise_for_status()
            related = work.get('related_works', [])[:10]
            similar = []
            if related:
                related_response = client.get('https://api.openalex.org/works', params={**params, 'filter': 'openalex:' + '|'.join(v.rsplit('/', 1)[-1] for v in related), 'per-page': 10})
                related_response.raise_for_status(); similar = projected(related_response.json().get('results', []))
            return {'work': projected([work])[0], 'references': refs, 'cited_by': projected(cited.json().get('results', [])),
                    'related': similar, 'reference_total': len(work.get('referenced_works', [])), 'citation_total': work.get('cited_by_count'), 'source': 'openalex', 'limit': 20}
    except (httpx.HTTPError, KeyError, ValueError):
        raise HTTPException(502, "引用关系暂不可用；OpenAlex 可能要求配置 API Key，或尚未收录此 DOI")
