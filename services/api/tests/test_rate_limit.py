import pytest
from fastapi import HTTPException

from app.rate_limit import SlidingWindowLimiter, prep_generation_limiter


def test_sliding_window_blocks_after_limit_per_key() -> None:
    limiter = SlidingWindowLimiter(2, 60, "slow down")
    limiter.check("user-a")
    limiter.check("user-a")
    with pytest.raises(HTTPException) as blocked:
        limiter.check("user-a")
    assert blocked.value.status_code == 429 and blocked.value.detail == "slow down"
    limiter.check("user-b")  # other users keep their own window


def test_factories_return_independent_limiters() -> None:
    first, second = prep_generation_limiter(), prep_generation_limiter()
    for _ in range(first.limit):
        first.check("same-user")
    second.check("same-user")
