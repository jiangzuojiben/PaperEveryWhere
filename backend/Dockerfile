FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim fonts-noto-cjk libglib2.0-0 libnss3 && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.lock /app/backend/requirements.lock
RUN pip install --no-cache-dir -r backend/requirements.lock
COPY backend /app/backend
RUN useradd --create-home app && mkdir -p /app/.data && chown -R app:app /app
USER app
EXPOSE 8765
ENV PYTHONDONTWRITEBYTECODE=1
CMD ["uvicorn", "backend.cloud_main:app", "--host", "0.0.0.0", "--port", "8765", "--workers", "1", "--no-access-log"]
