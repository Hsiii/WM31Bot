FROM oven/bun:1.3.9-alpine AS speech-builder

ARG WHISPER_CPP_VERSION=1.9.1
ARG WHISPER_MODEL_SHA256=60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe

RUN apk add --no-cache build-base cmake wget
WORKDIR /build
RUN wget -qO whisper.tar.gz "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${WHISPER_CPP_VERSION}.tar.gz" \
  && tar -xzf whisper.tar.gz --strip-components=1 \
  && cmake -S . -B build \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_OPENMP=OFF \
    -DWHISPER_BUILD_EXAMPLES=ON \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_BUILD_SERVER=OFF \
  && cmake --build build --config Release --target whisper-cli -j2 \
  && install -Dm755 build/bin/whisper-cli /out/whisper-cli
RUN wget -qO /out/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin \
  && echo "${WHISPER_MODEL_SHA256}  /out/ggml-base.bin" | sha256sum -c -

FROM oven/bun:1.3.9-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.9-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

COPY package.json bun.lock ./
RUN apk add --no-cache git
RUN apk add --no-cache espeak-ng ffmpeg libstdc++
RUN bun install --frozen-lockfile --production

COPY --from=builder --chown=bun:bun /app/src ./src
COPY --from=builder --chown=bun:bun /app/contracts ./contracts
COPY --from=builder --chown=bun:bun /app/tsconfig.json ./tsconfig.json
COPY --from=speech-builder /out/whisper-cli /usr/local/bin/whisper-cli
COPY --from=speech-builder /out/ggml-base.bin /opt/minisago-models/ggml-base.bin
RUN mkdir -p /app/state && chown -R bun:bun /app/state

USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["bun", "run", "start"]
