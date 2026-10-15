FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd -r -u 10001 app && mkdir -p /data/uploads && chown app /data/uploads
COPY app ./app
COPY web ./web
USER app
EXPOSE 8000
# --proxy-headers trusts X-Forwarded-For only from the Caddy container's network
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--timeout-keep-alive", "5"]
