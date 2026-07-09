FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DB_PATH=/data/wallvibe.db \
    PORT=5006

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py gunicorn.conf.py ./
COPY templates ./templates
COPY static ./static

VOLUME ["/data"]
EXPOSE 5006

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','5006')+'/health').read()" || exit 1

CMD ["gunicorn", "-c", "gunicorn.conf.py", "app:app"]
