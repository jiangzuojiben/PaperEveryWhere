import hashlib
import hmac
import secrets
import time
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from cryptography.fernet import Fernet
from .db import Session
from .models import Token, User
from .settings import settings


bearer = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1)
    return f"{salt.hex()}:{digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    salt, expected = stored.split(":")
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1)
    return hmac.compare_digest(digest.hex(), expected)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def current_user(auth: HTTPAuthorizationCredentials | None = Depends(bearer)) -> User:
    if not auth:
        raise HTTPException(401, "请登录")
    with Session() as db:
        token = db.get(Token, token_digest(auth.credentials))
        user = db.get(User, token.user_id) if token and token.expires > time.time() else None
        if not user:
            raise HTTPException(401, "登录已过期")
        return user


def cipher() -> Fernet:
    if settings.encryption_key:
        return Fernet(settings.encryption_key.encode())
    key_path = settings.data_dir / "encryption.key"
    if not key_path.exists():
        try:
            with key_path.open("xb") as stream:
                stream.write(Fernet.generate_key())
        except FileExistsError:
            pass
    return Fernet(key_path.read_bytes())
