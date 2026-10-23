FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 VAULTDESK_DB=/data/vaultdesk.sqlite3
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt \
    && useradd --create-home --uid 10001 vaultdesk \
    && mkdir /data && chown vaultdesk:vaultdesk /data
COPY __init__.py app.py /app/cloud/
USER vaultdesk
EXPOSE 8766
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8766/health', timeout=3)"
CMD ["python", "-m", "uvicorn", "cloud.app:app", "--host", "0.0.0.0", "--port", "8766", "--no-proxy-headers"]
