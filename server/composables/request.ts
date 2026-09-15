import type {
  ExtractedRouteMethod,
  NitroFetchOptions,
  NitroFetchRequest,
  TypedInternalResponse,
} from "nitropack/types";
import type { FetchError } from "ofetch";

export type DropFetch = <
  T = unknown,
  R extends NitroFetchRequest = NitroFetchRequest,
  O extends NitroFetchOptions<R> = NitroFetchOptions<R>,
>(
  request: R,
  opts?: O & { failTitle?: string; params?: { [key: string]: string } },
) => Promise<
  // sometimes there is an error, other times there isn't
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  TypedInternalResponse<
    R,
    T,
    NitroFetchOptions<R> extends O ? "get" : ExtractedRouteMethod<R, O>
  >
>;

export const $dropFetch: DropFetch = async (rawRequest, opts) => {
  const requestParts = rawRequest.toString().split("/");
  requestParts.forEach((part, index) => {
    if (!part.startsWith(":")) {
      return;
    }
    const partName = part.slice(1);
    const replacement = opts?.params?.[partName] as string | undefined;
    if (!replacement) {
      return;
    }
    requestParts[index] = replacement;

    delete opts?.params?.[partName];
  });
  const request = requestParts.join("/");

  // If not in setup
  if (!getCurrentInstance()?.proxy) {
    try {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore Excessive stack depth comparing types
      return await $fetch(request, opts);
    } catch (e) {
      if (import.meta.client && opts?.failTitle) {
        console.warn(e);
        createModal(
          ModalType.Notification,
          {
            title: opts.failTitle,
            description:
              (e as FetchError)?.data?.message ?? (e as string).toString(),
            //buttonText: $t("common.close"),
          },
          (_, c) => c(),
        );
      }
      throw e;
    }
  }

  const id = request.toString();

  const state = useState(id);
  if (state.value) {
    // Deep copy.
    // Cannot use structuredClone here: h3 hands SSR-internal $fetch results
    // back as null-prototype objects, which structuredClone rejects inside the
    // Nitro runtime ("#<Object> could not be cloned"), failing server render
    // while state is cached. The cached payload is API JSON, so a JSON
    // round-trip is both a valid deep copy and clone-safe.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let object: any;
    try {
      // The JSON round-trip is deliberate: structuredClone must not be used
      // here (see comment above).
      // eslint-disable-next-line unicorn/prefer-structured-clone
      object = JSON.parse(JSON.stringify(state.value));
    } catch (cloneError) {
      console.error("$dropFetch deep copy failed for", id, cloneError);
      throw cloneError;
    }
    // Never use again on client
    if (import.meta.client) state.value = undefined;
    return object;
  }

  const headers = useRequestHeaders(["cookie", "authorization"]);
  const data = await $fetch(request, {
    ...opts,
    headers: { ...headers, ...opts?.headers },
  });
  if (import.meta.server) state.value = data;
  return data;
};

export function isClientRequest() {
  const existingState = useState("clientMode", () => false);
  if (import.meta.server) {
    const headers = useRequestHeaders(["User-Agent"]);
    const calculatedClientRequest =
      headers["user-agent"] == "Drop Desktop Client";
    existingState.value = calculatedClientRequest;
  }

  return existingState.value;
}
