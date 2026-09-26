"""Portable embedding column: native pgvector on PostgreSQL, JSON text elsewhere.

Production stores embeddings in a dimension-less ``vector`` column so several
embedding models can coexist. Approximate-nearest-neighbour indexes are partial
expression indexes per supported dimension (see ``VECTOR_INDEX_DIMENSIONS``);
queries must cast with the same expression to use them. SQLite (tests, local
fallback) stores the same list as JSON and scores it in Python.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import Text
from sqlalchemy.types import TypeDecorator, UserDefinedType

# Dimensions that get an HNSW cosine index in PostgreSQL. Other dimensions still
# work, via an exact scan, which is acceptable for small per-workspace corpora.
VECTOR_INDEX_DIMENSIONS: tuple[int, ...] = (1536, 3072, 1024, 768)


class _PgVector(UserDefinedType):
    cache_ok = True

    def get_col_spec(self, **kw: Any) -> str:
        return "vector"


def vector_literal(values: list[float]) -> str:
    """pgvector's text input format, e.g. ``[0.1,0.2]``."""
    return "[" + ",".join(repr(float(value)) for value in values) + "]"


def parse_vector(value: Any) -> list[float] | None:
    if value is None:
        return None
    if isinstance(value, list):
        return [float(item) for item in value]
    text = str(value).strip()
    if not text:
        return None
    return [float(item) for item in json.loads(text)]


class EmbeddingVector(TypeDecorator):
    """A list[float] that is ``vector`` in PostgreSQL and JSON text elsewhere."""

    impl = Text
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(_PgVector())
        return dialect.type_descriptor(Text())

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        values = [float(item) for item in value]
        if dialect.name == "postgresql":
            return vector_literal(values)
        return json.dumps(values)

    def process_result_value(self, value, dialect):
        return parse_vector(value)


# Let SQLAlchemy's inspector recognise existing pgvector columns (schema validation reflects them).
try:
    from sqlalchemy.dialects.postgresql.base import ischema_names as _pg_ischema_names

    _pg_ischema_names.setdefault("vector", _PgVector)
except ImportError:  # pragma: no cover - PostgreSQL dialect is always bundled with SQLAlchemy
    pass
