from typing import Literal, Any
from uuid import UUID
from pydantic import BaseModel, Field, field_validator


class Credentials(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=10, max_length=256)
    name: str = Field(default="研究者", min_length=1, max_length=120)

    @field_validator("email")
    @classmethod
    def email_normalized(cls, value):
        if "@" not in value or " " in value:
            raise ValueError("邮箱格式不正确")
        return value.strip().lower()


Kind = Literal["paper", "version", "attachment", "folder", "annotation", "note", "progress", "comment", "session"]


class Operation(BaseModel):
    op_id: UUID
    entity_id: UUID
    kind: Kind
    base_revision: int = Field(ge=0)
    deleted: bool = False
    data: dict[str, Any] = Field(default_factory=dict)


class SyncRequest(BaseModel):
    scope: str = "personal"
    cursor: int = Field(default=0, ge=0)
    operations: list[Operation] = Field(default_factory=list, max_length=200)


class ProviderInput(BaseModel):
    endpoint: str = Field(max_length=1000)
    model: str = Field(default="", max_length=120)
    api_key: str | None = Field(default=None, max_length=4096)


class JobInput(BaseModel):
    kind: Literal["extract", "ocr", "ask", "summarize", "translate", "figure", "figures"]
    paper_id: UUID
    question: str = Field(default="", max_length=20000)
    target_language: str = Field(default="简体中文", max_length=100)
    pages: list[int] = Field(default_factory=list, max_length=1000)
    image_base64: str = Field(default="", max_length=8_000_000)
    file_hash: str | None = Field(default=None, pattern=r'^[0-9a-f]{64}$')


class GroupInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class MemberInput(BaseModel):
    email: str
    role: Literal["editor", "viewer"] = "editor"


class MigrationPaper(BaseModel):
    source_id: str = Field(min_length=1, max_length=500)
    title: str = Field(max_length=2000)
    authors: list[str] = Field(default_factory=list, max_length=2000)
    tags: list[str] = Field(default_factory=list, max_length=1000)
    year: int | str | None = None
    doi: str = ""
    journal: str = ""
    folder: str = ""
    filename: str = ""
    file_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    notes: list[str | dict] = Field(default_factory=list, max_length=10000)
    annotations: list[dict] = Field(default_factory=list, max_length=10000)
    progress: dict | None = None
