FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/packages/contracts:/app/services/api

WORKDIR /app

COPY services/api/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY packages/contracts /app/packages/contracts
COPY services/api /app/services/api
COPY apps/web/public/brand/meetings-ai-avatar-1024.png /app/brand/meetings-ai-avatar-1024.png

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
