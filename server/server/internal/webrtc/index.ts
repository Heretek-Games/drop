import { buildIceConfig, type IceConfig, type IceEnv } from "./ice";

/** Read ICE configuration from the process environment. */
function envFromProcess(): IceEnv {
  const rawTtl = process.env.DROP_TURN_TTL_SECONDS;
  const parsedTtl = rawTtl ? Number(rawTtl) : undefined;
  return {
    stunUrls: process.env.DROP_STUN_URLS,
    turnUrls: process.env.DROP_TURN_URLS ?? process.env.DROP_TURN_URL,
    turnSecret: process.env.DROP_TURN_SECRET,
    turnTtlSeconds: parsedTtl,
  };
}

/** ICE servers (STUN + ephemeral TURN credentials) for one user. */
export function getIceConfig(userId: string): IceConfig {
  return buildIceConfig(envFromProcess(), userId);
}

export * from "./ice";
export default getIceConfig;
