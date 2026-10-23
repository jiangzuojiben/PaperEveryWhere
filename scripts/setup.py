"""Generate independent local deployment secrets without printing credentials."""
from pathlib import Path
import secrets
from cryptography.fernet import Fernet

root = Path(__file__).resolve().parents[1]
target = root / '.env'
if target.exists():
    raise SystemExit('.env already exists; preserving existing secrets.')
target.write_text('\n'.join([
    'POSTGRES_PASSWORD=' + secrets.token_urlsafe(32),
    'MINIO_ROOT_USER=paperdesk',
    'MINIO_ROOT_PASSWORD=' + secrets.token_urlsafe(32),
    'PAPERDESK_ENCRYPTION_KEY=' + Fernet.generate_key().decode(),
    'PAPERDESK_OPENALEX_KEY=', 'PAPERDESK_CROSSREF_EMAIL=', '',
]), encoding='utf-8')
print('Created .env. Back up this file with your deployment; secrets were not printed.')
