FROM rust:1.94.1-bookworm AS builder

ARG FDB_VERSION=7.4.8

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl libclang-dev protobuf-compiler && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/foundationdb
RUN package="foundationdb-clients_${FDB_VERSION}-1_amd64.deb" && \
    url="https://github.com/apple/foundationdb/releases/download/${FDB_VERSION}/${package}" && \
    curl --fail --location --retry 3 --output "$package" "$url" && \
    curl --fail --location --retry 3 --output "${package}.sha256" "${url}.sha256" && \
    sha256sum --check "${package}.sha256" && \
    dpkg -i "$package" && \
    rm -rf /tmp/foundationdb

WORKDIR /app
COPY dfs/protocol/ dfs/protocol/
COPY dfs/server/ dfs/server/

RUN --mount=type=cache,id=dfs-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=dfs-cargo-git,target=/usr/local/cargo/git \
    cargo build --manifest-path dfs/server/Cargo.toml --release --locked --bin dfs-api

FROM debian:bookworm-slim AS dfs

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates libstdc++6 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/lib/libfdb_c.so /usr/lib/libfdb_c.so
COPY --from=builder /app/dfs/server/target/release/dfs-api /usr/local/bin/dfs-api

ARG COMMIT_HASH
ARG COMMIT_HASH_LONG
ARG DD_GIT_REPOSITORY_URL=https://github.com/dust-tt/dust
ARG DD_GIT_COMMIT_SHA=${COMMIT_HASH_LONG}
ENV DD_GIT_REPOSITORY_URL=${DD_GIT_REPOSITORY_URL}
ENV DD_GIT_COMMIT_SHA=${DD_GIT_COMMIT_SHA}
ENV DFS_LISTEN=0.0.0.0:50051

EXPOSE 50051

CMD ["dfs-api"]
