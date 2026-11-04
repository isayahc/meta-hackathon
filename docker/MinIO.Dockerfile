# Source release includes fixes newer than the last community container release.
FROM golang:1.24-bookworm AS build
RUN go install github.com/minio/minio@RELEASE.2025-10-15T17-29-55Z \
    && cp /go/pkg/mod/github.com/minio/minio@*/LICENSE /tmp/MinIO-LICENSE \
    && go clean -modcache -cache
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home minio && mkdir /data && chown minio:minio /data
COPY --from=build /go/bin/minio /usr/local/bin/minio
COPY --from=build /tmp/MinIO-LICENSE /licenses/MinIO-AGPL.txt
USER minio
ENTRYPOINT ["minio"]
CMD ["server", "/data"]
