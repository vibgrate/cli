# vg in a container. NOTE: the canonical published image is built from the
# repository-root Dockerfile and ships as ghcr.io/vibgrate/cli — this file is a
# minimal template for building your own local image.
# Usage: docker run --rm -v "$PWD":/work -w /work vg-local scan
FROM node:22-alpine

# Install the published CLI (provides the `vg` bin). Pin in the release pipeline.
RUN npm install -g @vibgrate/cli

WORKDIR /work
ENTRYPOINT ["vg"]
# Bare `vg` scans + maps the working directory.
CMD []
