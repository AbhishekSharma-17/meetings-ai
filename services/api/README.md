# Meetings AI API

The first MVP API stores provider configuration in memory. It never makes a
provider network call, and its public schemas never expose credentials.

From the repository root:

```bash
PYTHONPATH=packages/contracts:services/api \
  uvicorn app.main:app --reload
```

OpenAPI is available at `http://127.0.0.1:8000/docs` and health at `/health`.
