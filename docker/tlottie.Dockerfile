# tlottie (MIT, github.com/dkaraush/tlottie) → WASM, собранный из исходников на закреплённом коммите.
# docker build -f docker/tlottie.Dockerfile -o packages/relay-ui/vendor/tlottie .
FROM rust:1.90-slim AS build
ARG TLOTTIE_SHA=92df98dc209bc39b1e567ec74a8c86a0af5239de
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
 && rustup target add wasm32-unknown-unknown
WORKDIR /src
RUN git init -q . && git remote add origin https://github.com/dkaraush/tlottie.git \
 && git fetch -q --depth 1 origin "$TLOTTIE_SHA" && git checkout -q FETCH_HEAD
# no-std: без стандартной библиотеки, panic=abort — меньше бинарник
RUN for v in simd:+simd128 nosimd:-simd128; do name=${v%%:*}; flag=${v#*:}; \
      RUSTFLAGS="-C target-feature=$flag" CARGO_TARGET_DIR=/out/$name cargo build --locked --lib \
        --target wasm32-unknown-unknown --profile release-nostd --no-default-features --features wasm,no-std; \
    done \
 && mkdir /dist && cp /out/simd/wasm32-unknown-unknown/release-nostd/tlottie.wasm /dist/tlottie.wasm \
 && cp /out/nosimd/wasm32-unknown-unknown/release-nostd/tlottie.wasm /dist/tlottie-no-simd.wasm \
 && cp LICENSE /dist/LICENSE && echo "$TLOTTIE_SHA" > /dist/COMMIT
FROM scratch
COPY --from=build /dist/ /
