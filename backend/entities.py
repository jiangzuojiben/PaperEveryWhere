import hashlib
import json
import time
import re
import math
from uuid import uuid4
from fastapi import HTTPException
from sqlalchemy import select
from .models import User, Group, Member, Entity, Change, Receipt, Blob


def scope_for(db, user, requested="personal", write=False):
    if requested in ("personal", f"u:{user.id}"):
        # Lock the scope owner to serialize writes AND cursor reads in PostgreSQL.
        db.execute(select(User).where(User.id == user.id).with_for_update()).scalar_one()
        return f"u:{user.id}"
    if not requested.startswith("g:"):
        raise HTTPException(403, "不可访问此文献库")
    group_id = requested[2:]
    group = db.execute(select(Group).where(Group.id == group_id).with_for_update()).scalar_one_or_none()
    member = db.get(Member, (group_id, user.id))
    if not group or not member or (write and member.role == "viewer"):
        raise HTTPException(403, "没有小组访问权限")
    return requested


def accessible(db, user, entity_id, write=False):
    entity = db.get(Entity, str(entity_id))
    if not entity:
        raise HTTPException(404, "记录不存在")
    scope_for(db, user, entity.scope, write=write)
    return entity


def record(entity):
    return {"id": entity.id, "scope": entity.scope, "kind": entity.kind, "revision": entity.revision,
            "data": entity.data, "deleted": entity.deleted, "updated": entity.updated}


def emit(db, entity):
    db.flush()
    db.add(Change(scope=entity.scope, entity_id=entity.id, record=record(entity)))


def validate_data(db, user, scope, kind, data, entity_id=None):
    if len(json.dumps(data, ensure_ascii=False)) > 2_000_000:
        raise HTTPException(422, "记录过大")
    folder_ids = data.get('folder_ids', [])
    if not isinstance(folder_ids, list) or len(folder_ids) > 1000 or any(not isinstance(x, str) for x in folder_ids):
        raise HTTPException(422, '文件夹关联必须为 ID 数组')
    for folder_id in folder_ids:
        folder = db.get(Entity, folder_id)
        if not folder or folder.kind != 'folder' or folder.scope != scope or folder.deleted:
            raise HTTPException(422, '文件夹关联必须属于当前文献库')
    for key in ("paper_id", "folder_id", "parent_id", "version_id"):
        reference = data.get(key)
        if reference:
            parent = db.get(Entity, reference)
            if not parent or parent.scope != scope or parent.deleted:
                raise HTTPException(422, f"{key} 必须属于当前文献库")
            expected_kind = {"paper_id": "paper", "folder_id": "folder", "parent_id": "folder", "version_id": "version"}[key]
            if parent.kind != expected_kind:
                raise HTTPException(422, f"{key} 的目标记录类型不匹配")
    if kind == 'folder':
        seen = {str(entity_id)} if entity_id else set()
        parent_id = data.get('parent_id')
        while parent_id:
            if parent_id in seen:
                raise HTTPException(422, '文件夹不能包含循环父子关系')
            seen.add(parent_id)
            parent = db.get(Entity, parent_id)
            parent_id = parent.data.get('parent_id') if parent else None
    if data.get("file_id"):
        blob = db.get(Blob, data["file_id"])
        # New references may only publish one's own files; existing shared files
        # are retained through the entity edit path below.
        published = db.scalar(select(Entity.id).where(Entity.scope == scope, Entity.deleted == False,
                                                      Entity.data["file_id"].as_string() == data["file_id"]))
        if not blob or (blob.owner_id != user.id and not published):
            raise HTTPException(403, "无权引用此文件")
    if kind == "annotation":
        for field, maximum, allow_zero in (
            ('opacity', 1, True), ('fill_opacity', 1, True),
            ('font_size', 1, False), ('stroke_width', .1, False),
        ):
            if field in data:
                value = data[field]
                if (isinstance(value, bool) or not isinstance(value, (float, int))
                        or not math.isfinite(value)
                        or not (0 <= value <= maximum if allow_zero else 0 < value <= maximum)):
                    raise HTTPException(422, f'无效批注样式：{field}')
        if not isinstance(data.get('points', []), list) or not isinstance(data.get('rects', []), list):
            raise HTTPException(422, '批注坐标必须为数组')
        if not isinstance(data.get('color', '#edb83c'), str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', data.get('color', '#edb83c')):
            raise HTTPException(422, '无效批注颜色')
        if data.get("type") not in {"highlight", "ink", "rectangle", "text", "line"}:
            raise HTTPException(422, "无效批注类型")
        if not isinstance(data.get("page"), int) or data["page"] < 1:
            raise HTTPException(422, "页码从 1 开始")
        for point in data.get("points", []):
            if not isinstance(point, dict) or not all(isinstance(point.get(k, .5), (float, int)) for k in ('x', 'y', 'pressure')):
                raise HTTPException(422, '无效笔迹点')
            if not (0 <= point.get("x", -1) <= 1 and 0 <= point.get("y", -1) <= 1 and 0 <= point.get("pressure", 1) <= 1):
                raise HTTPException(422, "笔迹坐标或压感无效")
        for rect in data.get("rects", []):
            if not isinstance(rect, list) or len(rect) != 4 or not all(isinstance(v, (float, int)) and 0 <= v <= 1 for v in rect) or rect[0] > rect[2] or rect[1] > rect[3]:
                raise HTTPException(422, "批注矩形无效")


def apply_operation(db, user, scope, op):
    fingerprint = hashlib.sha256(json.dumps({"scope": scope, **op.model_dump(mode="json")}, sort_keys=True).encode()).hexdigest()
    receipt = db.get(Receipt, (user.id, str(op.op_id)))
    if receipt:
        if receipt.request_hash != fingerprint:
            raise HTTPException(409, "操作标识已用于不同请求")
        return receipt.result
    entity = db.get(Entity, str(op.entity_id))
    if entity and entity.scope != scope:
        raise HTTPException(403, "记录不属于当前文献库")
    if entity and entity.kind != op.kind:
        raise HTTPException(422, "不能改变记录类型")
    actual = entity.revision if entity else 0
    if op.base_revision != actual:
        result = {"op_id": str(op.op_id), "status": "conflict", "current": record(entity) if entity else None}
        if op.kind == "note" and not op.deleted and entity and not entity.deleted:
            validate_data(db, user, scope, op.kind, op.data, op.entity_id)
            copy = Entity(id=str(uuid4()), scope=scope, kind="note", data={**op.data, "conflict_of": entity.id}, revision=1)
            db.add(copy)
            emit(db, copy)
            result["conflict_copy"] = record(copy)
    else:
        if op.kind == "comment":
            op.data = {**op.data, "author": user.name, "author_id": user.id}
        if not op.deleted:
            validate_data(db, user, scope, op.kind, op.data, op.entity_id)
        elif op.kind == 'folder':
            dependent = db.scalar(select(Entity.id).where(Entity.scope == scope, Entity.deleted == False,
                (Entity.data['parent_id'].as_string() == str(op.entity_id)) |
                (Entity.data['folder_id'].as_string() == str(op.entity_id))))
            if dependent:
                raise HTTPException(422, '请先移出文件夹中的文献和子文件夹')
            for paper in db.scalars(select(Entity).where(Entity.scope == scope, Entity.kind == 'paper', Entity.deleted == False)):
                if str(op.entity_id) in paper.data.get('folder_ids', []):
                    raise HTTPException(422, '请先移出文件夹中的文献和子文件夹')
        if entity is None:
            entity = Entity(id=str(op.entity_id), scope=scope, kind=op.kind, data=op.data, revision=0)
            db.add(entity)
        entity.revision += 1
        entity.data = op.data
        entity.deleted = op.deleted
        entity.updated = time.time()
        emit(db, entity)
        result = {"op_id": str(op.op_id), "status": "applied", "record": record(entity)}
    db.add(Receipt(user_id=user.id, op_id=str(op.op_id), request_hash=fingerprint, result=result))
    db.flush()
    return result
