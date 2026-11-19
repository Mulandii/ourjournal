# PocketBase for "Our little journal" — pinned version, checksum-verified.
FROM alpine:3.20
ARG PB_VERSION=0.40.6
ARG PB_SHA256=0e1f609158ed945f809f8a02ae012aa0427129c66ebb63c1aee76f2c0309373f
RUN apk add --no-cache ca-certificates unzip tzdata \
 && wget -q "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_amd64.zip" -O /tmp/pb.zip \
 && echo "${PB_SHA256}  /tmp/pb.zip" | sha256sum -c - \
 && unzip -q /tmp/pb.zip -d /pb && rm /tmp/pb.zip
EXPOSE 8090
CMD ["/pb/pocketbase", "serve", "--http=0.0.0.0:8090", "--dir=/pb_data", "--publicDir=/pb_public", "--migrationsDir=/pb_migrations", "--hooksDir=/pb_hooks"]
