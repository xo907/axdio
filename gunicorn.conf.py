# Gunicorn settings for Axdio. One worker process on purpose: the library index, players,
# downloads and audits live in that process's memory. Threads handle concurrency.
import os

bind = f"0.0.0.0:{os.environ.get('PORT', '7865')}"
workers = 1
worker_class = "gthread"
threads = int(os.environ.get("WEB_THREADS", "48"))   # each playing listener holds a thread while streaming
timeout = 60                  # a stuck worker is restarted; long streams are fine with gthread
graceful_timeout = 20
keepalive = 5
worker_tmp_dir = "/dev/shm"
accesslog = "-" if os.environ.get("ACCESS_LOG", "").lower() in ("1", "true", "yes") else None
errorlog = "-"
loglevel = os.environ.get("LOG_LEVEL", "info")
