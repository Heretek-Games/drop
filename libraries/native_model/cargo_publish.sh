#!/usr/bin/env bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

set -e
set -x

# CARGO_TOKEN is provided by the environment.
# shellcheck disable=SC2153
ARG_TOKEN="--token=${CARGO_TOKEN:?CARGO_TOKEN is not set}"

cd "$DIR/native_model_macro"
cargo publish "$ARG_TOKEN" "$@"

cd "$DIR"
cargo publish "$ARG_TOKEN" "$@"
