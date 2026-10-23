import hashlib
import io
import json
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import quote, urlparse
from uuid import uuid4, uuid5, NAMESPACE_URL
from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, BackgroundTasks, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from sqlalchemy import select, or_, cast, String
from sqlalchemy.exc import IntegrityError
from .db import Base, engine, Session, get_db
from .models import User, Token, Group, Member, Entity, Change, Blob, Job, Provider
from .schemas import Credentials, SyncRequest, Operation, ProviderInput, JobInput, GroupInput, MemberInput, MigrationPaper
from pydantic import TypeAdapter, ValidationError
from .security import current_user, hash_password, verify_password, token_digest, cipher, bearer
from .settings import settings
from .entities import scope_for, accessible, record, emit, apply_operation, validate_data
from . import storage
from .pdf import inspect_pdf, export_annotations, render_page
from .providers import discover, relations, metadata_by_doi
from .tasks import run_job


@asynccontextmanager
async def lifespan(app):
    Base.metadata.create_all(engine)
    yield


app = FastAPI(title="PaperDesk", version="0.3.0", lifespan=lifespan,
              description="独立科研文献库 / 本地优先同步。字段和协议见 docs/contracts.md。")
if settings.cors_origins:
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"], allow_headers=["*"])
api = "/api/v1"


@app.get("/health")
def health(db=Depends(get_db)):
    db.execute(select(1))
    return {"status": "ok", "version": "0.3.0"}


def public_user(user):
    return {"id": user.id, "email": user.email, "name": user.name}


def issue_token(db, user):
    raw = secrets.token_urlsafe(48)
    db.add(Token(digest=token_digest(raw), user_id=user.id, expires=time.time() + settings.token_days * 86400))
    db.commit()
    return {"access_token": raw, "token_type": "bearer", "user": public_user(user)}


@app.post(api + "/auth/register", status_code=201)
def register(body: Credentials, db=Depends(get_db)):
    if not settings.registration_open:
        raise HTTPException(403, "注册已关闭")
    user = User(id=str(uuid4()), email=body.email, name=body.name, password=hash_password(body.password))
    db.add(user)
    try:
        db.flush()
        return issue_token(db, user)
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "邮箱已注册")


@app.post(api + "/auth/login")
def login(body: Credentials, db=Depends(get_db)):
    user = db.scalar(select(User).where(User.email == body.email))
    if not user or not verify_password(body.password, user.password):
        raise HTTPException(401, "邮箱或密码不正确")
    return issue_token(db, user)


@app.get(api + "/auth/me")
def me(user=Depends(current_user)):
    return public_user(user)


@app.post(api + "/auth/logout")
def logout(auth=Depends(bearer), user=Depends(current_user), db=Depends(get_db)):
    token = db.get(Token, token_digest(auth.credentials))
    db.delete(token); db.commit()
    return {"ok": True}


@app.post(api + "/sync")
def sync(body: SyncRequest, user=Depends(current_user), db=Depends(get_db)):
    # SQLite only admits one writer; BEGIN IMMEDIATE also serializes the initial
    # idempotency lookup. PostgreSQL uses scope owner FOR UPDATE in scope_for.
    if engine.dialect.name == "sqlite":
        db.connection().exec_driver_sql("BEGIN IMMEDIATE")
    scope = scope_for(db, user, body.scope, write=bool(body.operations))
    results = [apply_operation(db, user, scope, operation) for operation in body.operations]
    changes = db.scalars(select(Change).where(Change.scope == scope, Change.seq > body.cursor).order_by(Change.seq).limit(501)).all()
    page = changes[:500]
    response = {"results": results, "changes": [{"seq": c.seq, **c.record} for c in page],
                "cursor": page[-1].seq if page else body.cursor, "has_more": len(changes) > 500}
    db.commit()
    return response


@app.get(api + "/library")
def library(scope="personal", kind="paper", q="", user=Depends(current_user), db=Depends(get_db)):
    scope = scope_for(db, user, scope)
    statement = select(Entity).where(Entity.scope == scope, Entity.kind == kind, Entity.deleted == False)
    if q:
        statement = statement.where(cast(Entity.data, String).ilike("%" + q.replace("%", "\\%").replace("_", "\\_") + "%", escape="\\"))
    return {"items": [record(e) for e in db.scalars(statement.order_by(Entity.updated.desc()))]}


@app.post(api + "/files", status_code=201)
async def upload(file: UploadFile = File(...), attachment: bool = False, user=Depends(current_user), db=Depends(get_db)):
    maximum = settings.max_upload_mb * 1024 * 1024
    content = bytearray()
    while chunk := await file.read(1024 * 1024):
        content.extend(chunk)
        if len(content) > maximum:
            raise HTTPException(413, "文件超过上传限制")
    if not content:
        raise HTTPException(422, "文件为空")
    is_pdf = bytes(content[:5]) == b"%PDF-"
    pdf_metadata = {}
    if not attachment and not is_pdf:
        raise HTTPException(422, "请选择 PDF 文件")
    digest = hashlib.sha256(content).hexdigest()
    existing = db.scalar(select(Blob).where(Blob.owner_id == user.id, Blob.sha256 == digest))
    if existing:
        return {"id": existing.id, "sha256": digest, "duplicate": True, "size": existing.size}
    if is_pdf:
        try:
            # Validate structure cheaply; expensive extraction belongs to jobs.
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(content))
            if reader.is_encrypted and not reader.decrypt(""):
                raise HTTPException(422, "PDF 已加密，请先解锁后导入")
            len(reader.pages)
            metadata = reader.metadata or {}
            pdf_metadata = {key: str(metadata.get('/' + key, ''))[:2000] for key in ('Title', 'Author', 'Subject')}
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(422, "PDF 已损坏或不受支持")
    key = f"{user.id}/{digest}"
    storage.put(key, bytes(content))
    blob = Blob(id=str(uuid4()), owner_id=user.id, sha256=digest,
                filename=Path(file.filename or "document.pdf").name[:255], size=len(content),
                media_type="application/pdf" if is_pdf else "application/octet-stream", storage_key=key)
    db.add(blob)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        blob = db.scalar(select(Blob).where(Blob.owner_id == user.id, Blob.sha256 == digest))
    return {"id": blob.id, "sha256": digest, "size": blob.size, "duplicate": False, "metadata": pdf_metadata}


def allowed_blob(db, user, file_id):
    blob = db.get(Blob, file_id)
    if not blob:
        raise HTTPException(404, "文件不存在")
    if blob.owner_id == user.id:
        return blob
    candidates = db.scalars(select(Entity).where(Entity.deleted == False, Entity.data["file_id"].as_string() == file_id)).all()
    for entity in candidates:
        try:
            scope_for(db, user, entity.scope)
            return blob
        except HTTPException:
            continue
    raise HTTPException(404, "文件不存在")


@app.get(api + "/files/{file_id}")
def download(file_id: str, user=Depends(current_user), db=Depends(get_db)):
    blob = allowed_blob(db, user, file_id)
    return Response(storage.get(blob.storage_key), media_type=blob.media_type,
                    headers={"Content-Disposition": "inline; filename*=UTF-8''" + quote(blob.filename), "ETag": f'"{blob.sha256}"'})


@app.get(api + "/files/{file_id}/pages/{page}.png")
def thumbnail(file_id: str, page: int, user=Depends(current_user), db=Depends(get_db)):
    blob = allowed_blob(db, user, file_id)
    try:
        return Response(render_page(storage.get(blob.storage_key), page, .5), media_type="image/png")
    except Exception:
        raise HTTPException(422, "无法渲染此页")


@app.get(api + "/papers/{paper_id}/export.pdf")
def export_pdf(paper_id: str, user=Depends(current_user), db=Depends(get_db)):
    paper = accessible(db, user, paper_id)
    version = accessible(db, user, paper.data["active_version_id"]) if paper.data.get("active_version_id") else paper
    blob = allowed_blob(db, user, version.data.get("file_id"))
    annotations = db.scalars(select(Entity).where(Entity.scope == paper.scope, Entity.kind == "annotation", Entity.deleted == False,
        Entity.data["paper_id"].as_string() == paper_id, Entity.data["file_hash"].as_string() == blob.sha256)).all()
    try:
        output = export_annotations(storage.get(blob.storage_key), [a.data for a in annotations])
        return Response(output, media_type="application/pdf", headers={"Content-Disposition": "attachment; filename=annotated.pdf"})
    except (ValueError, KeyError):
        raise HTTPException(422, "批注导出失败，请检查文献文件")


@app.get(api + "/papers/{paper_id}/citation")
def citation(paper_id: str, format: Literal["bibtex", "ris"] = "bibtex", user=Depends(current_user), db=Depends(get_db)):
    paper = accessible(db, user, paper_id)
    data = paper.data
    authors = data.get("authors", [])
    if format == "ris":
        import rispy
        text = rispy.dumps([{"type_of_reference": "JOUR", "title": data.get("title", ""), "authors": authors,
                            "year": str(data.get("year") or ""), "doi": data.get("doi", ""), "journal_name": data.get("journal", "")}])
    else:
        import bibtexparser
        database = bibtexparser.bibdatabase.BibDatabase()
        database.entries = [{"ENTRYTYPE": "article", "ID": "paper" + paper_id[:8], "title": data.get("title", ""),
            "author": " and ".join(authors), "year": str(data.get("year") or ""), "doi": data.get("doi", ""), "journal": data.get("journal", "")}]
        text = bibtexparser.dumps(database)
    return Response(text, media_type="text/plain; charset=utf-8")


@app.get(api + "/discover")
def search(q: str = Query(min_length=1, max_length=500), source: Literal["crossref", "openalex"] = "crossref", page: int = Query(default=1, ge=1, le=100), user=Depends(current_user)):
    return discover(q, source, page)


@app.put(api + "/providers/{kind}")
def set_provider(kind: Literal["ai", "translation"], body: ProviderInput, user=Depends(current_user), db=Depends(get_db)):
    url = urlparse(body.endpoint)
    if url.scheme not in ("http", "https") or not url.netloc or url.username or url.password or url.query or url.fragment:
        raise HTTPException(422, "服务地址应为不含凭据、查询参数的 HTTP(S) 基础地址")
    provider = db.get(Provider, (user.id, kind))
    if provider is None:
        if not body.api_key:
            raise HTTPException(422, "首次配置必须提供 API Key")
        provider = Provider(user_id=user.id, kind=kind, config={}, secret="")
        db.add(provider)
    provider.config = {"endpoint": body.endpoint, "model": body.model}
    if body.api_key is not None:
        provider.secret = cipher().encrypt(body.api_key.encode()).decode()
    db.commit()
    return {"configured": True}


@app.get(api + "/discover/relations")
def get_relations(doi: str = Query(max_length=500), user=Depends(current_user)):
    return relations(doi)


@app.get(api + '/metadata')
def get_metadata(doi: str = Query(max_length=500), user=Depends(current_user)):
    return metadata_by_doi(doi)


@app.get(api + "/providers")
def providers(user=Depends(current_user), db=Depends(get_db)):
    return {p.kind: {**p.config, "configured": True} for p in db.scalars(select(Provider).where(Provider.user_id == user.id))}


def dispatch(job, background):
    if settings.redis_url:
        run_job.delay(job.id)
    else:
        background.add_task(run_job.run, job.id)


@app.post(api + "/jobs", status_code=202)
def create_job(body: JobInput, background: BackgroundTasks, user=Depends(current_user), db=Depends(get_db)):
    paper = accessible(db, user, str(body.paper_id))
    if paper.kind != 'paper' or paper.deleted:
        raise HTTPException(422, '请选择有效文献')
    version = accessible(db, user, paper.data['active_version_id']) if paper.data.get('active_version_id') else paper
    if version is not paper and (version.kind != 'version' or version.deleted or version.data.get('paper_id') != paper.id):
        raise HTTPException(422, 'PDF 版本不属于此文献')
    blob = allowed_blob(db, user, version.data.get('file_id'))
    if body.file_hash and body.file_hash != blob.sha256:
        raise HTTPException(409, 'PDF 版本已变化，请重新打开阅读器再发起任务')
    request = {**body.model_dump(mode='json'), '_file_id': blob.id, 'file_hash': blob.sha256}
    job = Job(id=str(uuid4()), user_id=user.id, kind=body.kind, request=request)
    db.add(job); db.commit()
    dispatch(job, background)
    return {"id": job.id, "state": "queued"}


def own_job(db, user, job_id):
    job = db.get(Job, job_id)
    if not job or job.user_id != user.id:
        raise HTTPException(404, "任务不存在")
    accessible(db, user, job.request["paper_id"])
    return job


@app.get(api + '/jobs')
def list_jobs(paper_id: str, limit: int = Query(default=30, ge=1, le=100),
              user=Depends(current_user), db=Depends(get_db)):
    accessible(db, user, paper_id)
    jobs = db.scalars(select(Job).where(Job.user_id == user.id,
        Job.request['paper_id'].as_string() == paper_id).order_by(Job.created.desc(), Job.id).limit(limit))
    return {'items': [{'id': j.id, 'kind': j.kind, 'state': j.state,
                      'progress': j.progress, 'created': j.created} for j in jobs]}


@app.get(api + "/jobs/{job_id}")
def get_job(job_id: str, user=Depends(current_user), db=Depends(get_db)):
    job = own_job(db, user, job_id)
    return {"id": job.id, "kind": job.kind, "state": job.state, "progress": job.progress, "result": job.result, "error": job.error, "attempts": job.attempts}


@app.post(api + "/jobs/{job_id}/cancel")
def cancel_job(job_id: str, user=Depends(current_user), db=Depends(get_db)):
    job = own_job(db, user, job_id)
    if job.state in ("queued", "running"):
        job.state = "cancelled"; db.commit()
    return {"state": job.state}


@app.post(api + "/jobs/{job_id}/retry", status_code=202)
def retry_job(job_id: str, background: BackgroundTasks, user=Depends(current_user), db=Depends(get_db)):
    job = own_job(db, user, job_id)
    if job.state not in ("failed", "cancelled"):
        raise HTTPException(409, "仅可重试失败或已取消任务")
    # New attempt identity prevents an in-flight cancelled worker publishing to
    # a retried task that has already changed state back to queued.
    retry = Job(id=str(uuid4()), user_id=user.id, kind=job.kind, request=job.request)
    db.add(retry); db.commit(); dispatch(retry, background)
    return {"id": retry.id, "state": "queued", "retry_of": job.id}


@app.get(api + "/groups")
def groups(user=Depends(current_user), db=Depends(get_db)):
    entries = db.execute(select(Group, Member.role).join(Member, Group.id == Member.group_id).where(Member.user_id == user.id)).all()
    return {"items": [{"id": g.id, "name": g.name, "role": role, "owner_id": g.owner_id} for g, role in entries]}


@app.post(api + "/groups", status_code=201)
def create_group(body: GroupInput, user=Depends(current_user), db=Depends(get_db)):
    group = Group(id=str(uuid4()), name=body.name, owner_id=user.id)
    db.add(group); db.add(Member(group_id=group.id, user_id=user.id, role="owner")); db.commit()
    return {"id": group.id, "name": group.name}


@app.get(api + "/groups/{group_id}/members")
def members(group_id: str, user=Depends(current_user), db=Depends(get_db)):
    scope_for(db, user, "g:" + group_id)
    return {"items": [{**public_user(u), "role": m.role} for u, m in db.execute(select(User, Member).join(Member, User.id == Member.user_id).where(Member.group_id == group_id))]}


def group_owner(db, user, group_id):
    scope_for(db, user, "g:" + group_id, write=True)
    group = db.get(Group, group_id)
    if group.owner_id != user.id:
        raise HTTPException(403, "仅组主可管理成员")


@app.put(api + "/groups/{group_id}/members")
def add_member(group_id: str, body: MemberInput, user=Depends(current_user), db=Depends(get_db)):
    group_owner(db, user, group_id)
    target = db.scalar(select(User).where(User.email == body.email.strip().lower()))
    if not target:
        raise HTTPException(404, "请对方先注册 PaperDesk 账号")
    if target.id == user.id:
        raise HTTPException(422, "不能修改组主角色")
    member = db.get(Member, (group_id, target.id))
    if member:
        member.role = body.role
    else:
        db.add(Member(group_id=group_id, user_id=target.id, role=body.role))
    db.commit()
    return {"ok": True}


@app.delete(api + "/groups/{group_id}/members/{user_id}")
def remove_member(group_id: str, user_id: str, user=Depends(current_user), db=Depends(get_db)):
    group_owner(db, user, group_id)
    if user_id == user.id:
        raise HTTPException(422, "不能移除组主")
    member = db.get(Member, (group_id, user_id))
    if member:
        db.delete(member); db.commit()
    return {"ok": True}


@app.post(api + "/migration/preview")
async def migration_preview(file: UploadFile = File(...), user=Depends(current_user)):
    content = await file.read(10 * 1024 * 1024 + 1)
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, "迁移清单过大")
    try:
        suffix = Path(file.filename or "").suffix.lower()
        if suffix == ".bib":
            import bibtexparser
            entries = [{"source_id": e.get("ID"), "title": e.get("title", ""), "authors": e.get("author", "").split(" and "), "doi": e.get("doi", ""), "year": e.get("year")} for e in bibtexparser.loads(content.decode("utf-8-sig")).entries]
        elif suffix == ".ris":
            import rispy
            entries = [{"source_id": str(i), "title": e.get("title", ""), "authors": e.get("authors", []), "doi": e.get("doi", ""), "year": e.get("year")} for i, e in enumerate(rispy.loads(content.decode("utf-8-sig")))]
        else:
            parsed = json.loads(content.decode("utf-8-sig"))
            entries = parsed["papers"] if isinstance(parsed, dict) else parsed
        if not isinstance(entries, list) or len(entries) > 10000:
            raise ValueError()
        allowed = {"source_id", "title", "authors", "year", "doi", "journal", "tags", "folder", "notes", "annotations", "progress", "file_hash", "filename"}
        clean = []
        for i, entry in enumerate(entries):
            if not isinstance(entry, dict) or not isinstance(entry.get("title"), str):
                raise ValueError()
            item = {k: v for k, v in entry.items() if k in allowed}
            item["source_id"] = str(item.get("source_id") or f"entry-{i}")
            clean.append(item)
        return {"items": clean, "count": len(clean), "missing_files": sum(not p.get("file_hash") for p in clean),
                "warnings": ["只迁移清单明确包含的字段；原版云端和加密缓存未被读取。", "请用同一导出文件重复导入，以保持来源标识稳定。"]}
    except (ValueError, KeyError, TypeError, UnicodeError):
        raise HTTPException(422, "无法识别清单，请提供 PaperDesk JSON、BibTeX 或 RIS")


@app.post(api + "/migration/commit")
def migration_commit(body: dict, user=Depends(current_user), db=Depends(get_db)):
    items = body.get("items", [])
    if not isinstance(items, list) or len(items) > 10000:
        raise HTTPException(422, "迁移清单无效")
    try:
        items = [p.model_dump(exclude_none=True) for p in TypeAdapter(list[MigrationPaper]).validate_python(items)]
    except ValidationError:
        raise HTTPException(422, "迁移字段格式无效，请检查作者、标签、笔记、进度及文件哈希")
    scope = scope_for(db, user, "personal", write=True)
    imported = skipped = 0
    failures = []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("source_id"), str) or not isinstance(item.get("title"), str):
            failures.append({"source_id": item.get("source_id") if isinstance(item, dict) else None, "reason": "缺少来源标识或标题"}); continue
        identifier = str(uuid5(NAMESPACE_URL, scope + ":readpaper:" + item["source_id"]))
        if db.get(Entity, identifier):
            skipped += 1; continue
        data = {k: item[k] for k in ("title", "authors", "year", "doi", "journal", "tags", "source_id") if k in item}
        if isinstance(item.get('folder'), str) and item['folder'].strip('/'):
            parent_id = None
            path_parts = []
            for name in item['folder'].replace('\\', '/').strip('/').split('/'):
                if not name or name in ('.', '..'):
                    continue
                path_parts.append(name)
                folder_id = str(uuid5(NAMESPACE_URL, scope + ':folder:' + '/'.join(path_parts)))
                if not db.get(Entity, folder_id):
                    folder = Entity(id=folder_id, scope=scope, kind='folder', revision=1,
                        data={'title': name, **({'parent_id': parent_id} if parent_id else {})})
                    db.add(folder); emit(db, folder)
                parent_id = folder_id
            if parent_id:
                data['folder_id'] = parent_id
        if item.get("file_hash"):
            blob = db.scalar(select(Blob).where(Blob.owner_id == user.id, Blob.sha256 == item["file_hash"]))
            if blob:
                data.update(file_id=blob.id, file_hash=blob.sha256)
        paper = Entity(id=identifier, scope=scope, kind="paper", data=data, revision=1)
        db.add(paper); emit(db, paper)
        for index, note in enumerate(item.get("notes", [])):
            text = note if isinstance(note, str) else str(note.get("content", ""))
            child = Entity(id=str(uuid5(NAMESPACE_URL, identifier + f":note:{index}")), scope=scope, kind="note", revision=1,
                           data={"paper_id": identifier, "content": text, "source_id": item["source_id"]})
            db.add(child); emit(db, child)
        if isinstance(item.get("progress"), dict):
            child = Entity(id=str(uuid5(NAMESPACE_URL, identifier + ":progress")), scope=scope, kind="progress", revision=1,
                           data={**item["progress"], "paper_id": identifier})
            db.add(child); emit(db, child)
        for index, annotation in enumerate(item.get('annotations', [])):
            if not isinstance(annotation, dict) or annotation.get('coordinate_system') != 'normalized-top-left-v1' or not item.get('file_hash'):
                failures.append({'source_id': item['source_id'], 'annotation': index, 'reason': '原版批注坐标尚未验证；仅转换明确声明 normalized-top-left-v1 且绑定文件哈希的批注'})
                continue
            annotation_data = {**annotation, 'paper_id': identifier, 'file_hash': item['file_hash']}
            try:
                validate_data(db, user, scope, 'annotation', annotation_data)
            except HTTPException as exc:
                failures.append({'source_id': item['source_id'], 'annotation': index, 'reason': exc.detail})
                continue
            child = Entity(id=str(uuid5(NAMESPACE_URL, identifier + f':annotation:{index}')), scope=scope, kind='annotation', revision=1, data=annotation_data)
            db.add(child); emit(db, child)
        imported += 1
    db.commit()
    return {"imported": imported, "skipped": skipped, "failures": failures}
