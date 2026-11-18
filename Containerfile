FROM docker.io/library/python:3.13-alpine

# git is optional: it powers Settings → Sync → Git. openssh lets it push over SSH.
RUN apk add --no-cache git openssh-client

WORKDIR /app
COPY server.py ./
COPY static ./static
# The notes a fresh install starts with (a tour of every feature). Delete them any time.
COPY examples ./examples

# /data holds the first account's notes (/data/vault), added accounts (/data/vaults),
# and the account list, sessions and share links (/data/.polarboard-server).
ENV POLARBOARD_DATA=/data \
    POLARBOARD_HOST=0.0.0.0 \
    POLARBOARD_PORT=8787 \
    PYTHONUNBUFFERED=1

VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["python", "server.py"]
