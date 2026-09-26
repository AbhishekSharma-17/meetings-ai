"""Image input for text-generation requests (vision OCR / figure description).

Images travel in ``TextGenerationRequest.metadata[INPUT_IMAGES_KEY]`` as a list of
``data:image/...;base64,...`` URLs so the shared contract stays unchanged. Without
images, both helpers return the plain prompt string, so existing calls send the
exact same payload as before.
"""

from __future__ import annotations

from meetings_contracts import TextGenerationRequest

from .base import ProviderExecutionError

INPUT_IMAGES_KEY = "input_images"
MAX_INPUT_IMAGES = 8
_ALLOWED_PREFIXES = ("data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,")


def input_images(request: TextGenerationRequest) -> list[str]:
    raw = request.metadata.get(INPUT_IMAGES_KEY)
    if not raw:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_INPUT_IMAGES:
        raise ProviderExecutionError("image input must be a short list of data URLs")
    if any(not isinstance(item, str) or not item.startswith(_ALLOWED_PREFIXES) for item in raw):
        # Only inline images: never let a request make the provider fetch an arbitrary URL.
        raise ProviderExecutionError("image input must be PNG, JPEG or WebP data URLs")
    return raw


def chat_user_content(request: TextGenerationRequest) -> str | list[dict[str, object]]:
    """OpenAI-compatible Chat Completions user content (OpenRouter, local servers)."""
    images = input_images(request)
    if not images:
        return request.prompt
    return [{"type": "text", "text": request.prompt}] + [
        {"type": "image_url", "image_url": {"url": image}} for image in images
    ]


def responses_user_content(request: TextGenerationRequest) -> str | list[dict[str, object]]:
    """OpenAI Responses API user content."""
    images = input_images(request)
    if not images:
        return request.prompt
    return [{"type": "input_text", "text": request.prompt}] + [
        {"type": "input_image", "image_url": image} for image in images
    ]
