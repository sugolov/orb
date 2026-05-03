# orb-backend

FastAPI backend for the orb shell. Phase 0 — see `../AGENTS.md` for the
build log and `../ARCH.md` for the project roadmap.

## Layout

```
backend/
├── pyproject.toml      # deps only (no package, no console script)
├── .env.example
├── README.md
└── src/
    └── main.py         # the entire backend lives here
```

## Setup

```sh
cd backend
cp .env.example .env             # paste ANTHROPIC_API_KEY (optional in v0)
uv venv
uv pip install -r <(uv pip compile pyproject.toml)
```

## Run

```sh
.venv/bin/uvicorn --app-dir src main:app --reload --host 127.0.0.1 --port 8000
```

Or as a script:

```sh
.venv/bin/python src/main.py
```

Health: <http://127.0.0.1:8000/health>.
