"""FastAPI application entrypoint.

Minimal scaffold — endpoints, websocket protocol, agent loop, and persistence
layer are specified in ../../ARCH.md (sections 4.2–4.4) and intended to be
filled in by the architecture agent.
"""

from __future__ import annotations

from fastapi import FastAPI

app = FastAPI(title="orb-backend", version="0.1.0")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


def run() -> None:
    """Entrypoint for `orb-backend` console script."""
    import uvicorn

    uvicorn.run(
        "orb_backend.main:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
    )


if __name__ == "__main__":
    run()
