import io
from pathlib import Path
from .settings import settings


def s3():
    import boto3
    return boto3.client("s3", endpoint_url=settings.s3_endpoint, aws_access_key_id=settings.s3_access_key,
                        aws_secret_access_key=settings.s3_secret_key)


def put(key: str, content: bytes):
    if settings.s3_endpoint:
        s3().put_object(Bucket=settings.s3_bucket, Key=key, Body=content)
    else:
        path = settings.data_dir / "objects" / key
        path.parent.mkdir(parents=True, exist_ok=True)
        # Immutable, content-addressed objects; atomic replacement.
        import tempfile, os
        fd, temporary = tempfile.mkstemp(dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(content)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


def get(key: str) -> bytes:
    if settings.s3_endpoint:
        return s3().get_object(Bucket=settings.s3_bucket, Key=key)["Body"].read()
    return (settings.data_dir / "objects" / key).read_bytes()
