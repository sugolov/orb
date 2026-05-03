# orb-backend

Backend for the orb shell. See [`../ARCH.md`](../ARCH.md) for the full design.

## Setup

```sh
uv venv
source .venv/bin/activate
uv pip install -e ".[dev]"
```

## Run

```sh
orb-backend
# or: uvicorn orb_backend.main:app --reload
```

Server listens on `http://127.0.0.1:8000`. Health check at `/health`.

## Layout

```
backend/
├── pyproject.toml
└── src/
    └── orb_backend/
        ├── __init__.py
        └── main.py        # FastAPI app — extend per ARCH §4
```
