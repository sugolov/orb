<h1 align="center">orb</h1>

<p align="center">
  <img src="images/orb.png" alt="orb" />
</p>

<p align="center"><i>who up pondering they orb</i></p>

## Setup

This repo has two pieces: a Python backend (`backend/`) and a static frontend (`frontend/`). See [`ARCH.md`](ARCH.md) for the design.

### Backend

Requires [uv](https://docs.astral.sh/uv/) and Python 3.11+.

```sh
cd backend
uv venv
source .venv/bin/activate
uv pip install -e ".[dev]"
orb-backend                         # starts FastAPI on :8000
```

### Frontend

```sh
cd frontend
npm run dev                         # serves on :5173
# then open http://localhost:5173/orb-shell.html
```
