"""
Clinic Management System - API Proxy
------------------------------------
This FastAPI service runs on port 8001 (managed by supervisor) and simply forwards
every /api/* request to the Node/Express clinic backend that listens on port 3000.

Why: the platform's ingress routes /api/* to port 8001 and everything else to
port 3000. Because the actual clinic backend (Express + SQLite) lives on port
3000, this thin proxy makes /api/* work through the preview URL as well.

On the user's own laptop this file is not used at all -- they only run
`node server.js` which serves both the HTML pages and the /api routes on
port 3000 directly.
"""

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

NODE_UPSTREAM = "http://localhost:3000"

app = FastAPI(title="Clinic API Proxy")

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Persistent async HTTP client (keeps connections warm)
_client = httpx.AsyncClient(base_url=NODE_UPSTREAM, timeout=30.0)


@app.get("/")
async def root():
    return {"status": "ok", "service": "clinic-api-proxy", "upstream": NODE_UPSTREAM}


@app.api_route(
    "/api/{full_path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
)
async def proxy_api(full_path: str, request: Request):
    url = f"/api/{full_path}"
    method = request.method

    # Forward query string
    if request.url.query:
        url = f"{url}?{request.url.query}"

    # Forward headers except hop-by-hop / host
    excluded = {"host", "content-length", "connection", "accept-encoding"}
    headers = {k: v for k, v in request.headers.items() if k.lower() not in excluded}

    body = await request.body()

    try:
        upstream_resp = await _client.request(
            method=method,
            url=url,
            headers=headers,
            content=body if body else None,
        )
    except httpx.RequestError as exc:
        return Response(
            content=f'{{"success":false,"message":"Upstream node server unreachable: {exc}"}}',
            status_code=502,
            media_type="application/json",
        )

    # Strip hop-by-hop headers on the way back
    resp_headers = {
        k: v
        for k, v in upstream_resp.headers.items()
        if k.lower() not in {"content-encoding", "transfer-encoding", "connection", "content-length"}
    }
    return Response(
        content=upstream_resp.content,
        status_code=upstream_resp.status_code,
        headers=resp_headers,
        media_type=upstream_resp.headers.get("content-type", "application/json"),
    )


@app.on_event("shutdown")
async def _close_client():
    await _client.aclose()
