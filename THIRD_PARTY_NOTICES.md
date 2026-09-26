# Third-party attribution and redistribution

The root [LICENSE](LICENSE) applies to original Meetings AI material, not a blanket relicensing of its dependencies, downloaded models or third-party assets. Preserve original notices and license texts when redistributing source, images or other artifacts.

## Vexa capture subsystem

- Upstream: [Vexa-ai/vexa](https://github.com/Vexa-ai/vexa).
- License: Apache-2.0; retained in [vendor/vexa/LICENSE](vendor/vexa/LICENSE).
- Base revision: `cbaf88c6530d5e41368fc2df80e33c53240bd49e` (`v0.12.27`).
- Meetings AI fork: [AbhishekSharma-17/vexa](https://github.com/AbhishekSharma-17/vexa), branch `meetings-ai-integration`.
- Pinned fork revision: `1a8084e9a7f57a79902ed9bad9ae3b5c11c01e10`.
- Original Vexa work remains attributed to its upstream contributors; Meetings AI integration modifications are separate from the upstream release.

The fork modifies gateway capability reporting, meeting bot spawning, signed STT routing and tests, and the Lite Makefile. Its change history records these modifications. Preserve prominent modification notices on modified upstream files in future distributions as required by Apache 2.0; do not remove existing copyright notices.

The submodule includes its own [third-party artifact inventory](vendor/vexa/THIRD_PARTY_LICENSES.md) and [license directory](vendor/vexa/licenses/). Preserve those files with redistributed artifacts. That inventory covers image-baked components such as Valkey and diarization model weights and is distinct from this application's dependency list.

The Railway overlay is built on a pinned Vexa image, not an independently reimplemented capture engine. An image release must carry licenses for everything actually distributed in that image.

## Application dependencies

Meetings AI uses Next.js/React, TypeScript, Tailwind CSS, Base UI, Lucide and next-themes on the frontend, and FastAPI, Pydantic, Uvicorn, SQLAlchemy, Psycopg, cryptography and document-processing packages on the backend. This is an attribution overview, **not a complete license audit or SBOM**.

Exact JavaScript versions are recorded in `apps/web/package-lock.json` and the root lockfile. Python constraints are in `services/api/requirements.txt`; resolved Python/container dependencies depend on the build. Their package license files and metadata remain authoritative. Transitive dependencies, native binaries and container OS packages must be included in any release inventory.

Before distributing a release:

1. Inventory the exact resolved dependencies and final container layers, preferably using an SPDX or CycloneDX SBOM.
2. Review their license obligations, including native libraries and any copyleft components. Do not assume all dependencies inherit Apache 2.0.
3. Include required license texts, copyright notices and any required source/source offers with the distributed artifact.
4. Review downloaded STT/diarization models separately: model weights and datasets may have terms different from the runtime code.
5. Record new copied third-party code/assets here, preserve their notices and mark modifications.

## Hosted services and branding

OpenAI, OpenRouter, Composio, Resend, Railway, Google, Microsoft, Zoom and Calendly are independent services with their own API, privacy and brand terms. They are not licensed by this repository. Provider names and logos are used for identification; no affiliation or endorsement is claimed. Review brand permissions before distributing modified provider artwork.

Original Meetings AI assets are covered by the root license unless marked otherwise. The Apache license does not grant trademark rights or permission to imply endorsement. Recording data and customer documents are operator data, not open-source sample content.
