FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY entrypoint.sh gunicorn.conf.py server.py ./
COPY web/ ./web/

# Music is read from /music and everything the server writes goes to /app/config.
# PUID/PGID choose the user the server runs as (the owner of your config folder).
ENV CFG_DIR_MUSIC=/music \
    CONFIG_DIR=/app/config \
    PORT=7865 \
    PUID=1000 \
    PGID=1000

EXPOSE 7865
VOLUME ["/app/config"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PORT', '7865'), timeout=4)" || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
