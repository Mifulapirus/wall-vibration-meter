import os

bind = f"0.0.0.0:{os.environ.get('PORT', '5006')}"
# SQLite + low write rate: a couple of workers is plenty. Threads help serve
# the dashboard's parallel API calls without extra processes.
workers = int(os.environ.get("WEB_CONCURRENCY", "2"))
threads = int(os.environ.get("WEB_THREADS", "4"))
timeout = 60
accesslog = "-"
errorlog = "-"
