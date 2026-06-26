# vg in a container. Publishes to GHCR/Docker Hub via the release pipeline.
# Usage: docker run --rm -v "$PWD":/repo ghcr.io/vibgrate/vg vg -C /repo
FROM node:22-alpine

# Install the published CLI (provides the `vg` bin). Pin in the release pipeline.
RUN npm install -g @vibgrate/cli

WORKDIR /repo
ENTRYPOINT ["vg"]
CMD ["--help"]
