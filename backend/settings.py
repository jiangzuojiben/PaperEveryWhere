from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PAPERDESK_", env_file=".env", extra="ignore")
    data_dir: Path = Path(".data")
    database_url: str = "sqlite:///.data/paperdesk.db"
    encryption_key: str = ""
    redis_url: str = ""
    s3_endpoint: str = ""
    s3_bucket: str = "paperdesk"
    s3_access_key: str = ""
    s3_secret_key: str = ""
    openalex_key: str = ""
    crossref_email: str = ""
    max_upload_mb: int = 200
    registration_open: bool = True
    token_days: int = 30
    cors_origins: list[str] = []


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
