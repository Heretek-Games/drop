export type UISlotName =
  | "game-detail:actions"
  | "game-detail:panels"
  | "game-detail:badges"
  | "settings:tabs"
  | "topbar:status"
  | "sidebar:nav";

export interface UISlotRegistration {
  id: string;
  pluginId: string;
  slot: UISlotName;
  component: unknown;
  order: number;
  label?: string;
  icon?: string;
}

export interface LaunchContext {
  gameId: string;
  gameTitle: string;
  gameDir: string;
  actionId?: string;
  metadata?: Record<string, unknown>;
}

export type LaunchStage =
  | "pre-launch:validate"
  | "pre-launch:prepare"
  | "pre-launch:stage"
  | "pre-launch:network"
  | "launch"
  | "post-exit:cleanup"
  | "post-exit:restore"
  | "post-exit:sync";

export interface LaunchHook {
  stage: LaunchStage;
  order?: number;
  execute: (ctx: LaunchContext) => Promise<void> | void;
}

export interface PlayAction {
  id: string;
  name: string;
  icon?: string;
  isDefault?: boolean;
  execute: (context: LaunchContext) => Promise<void> | void;
}

export interface GameMenuItem {
  id: string;
  label: string;
  icon?: string;
  execute: (gameId: string) => Promise<void> | void;
}

export interface SidebarItem {
  id: string;
  title: string;
  icon?: string;
  type: "button" | "view";
  progressValue?: number;
  activated?: () => void;
  component?: unknown;
}

export interface TopBarItem {
  id: string;
  title: string;
  icon?: string;
  component?: unknown;
  activated?: () => void;
}

export interface ScopedGameFs {
  readFile(gameId: string, relativePath: string): Promise<Uint8Array>;
  writeFile(
    gameId: string,
    relativePath: string,
    data: Uint8Array | string,
  ): Promise<void>;
  backupFile(gameId: string, relativePath: string): Promise<string>;
  restoreFile(gameId: string, relativePath: string): Promise<void>;
  fileExists(gameId: string, relativePath: string): Promise<boolean>;
  deleteFile(gameId: string, relativePath: string): Promise<void>;
}

export interface AntiCheatReport {
  detected: boolean;
  reason?: string;
  binaries?: string[];
}

export interface ScopedGameScanner {
  scanExecutables(
    gameId: string,
  ): Promise<Array<{ relativePath: string; sha256: string; size: number }>>;
  checkAntiCheat(gameId: string): Promise<AntiCheatReport>;
}

export interface ClientPluginStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  listKeys(): Promise<string[]>;
}

export interface ClientPluginWebSocket {
  send(channel: string, data: unknown): Promise<unknown>;
  subscribe(channel: string, listener: (data: unknown) => void): () => void;
}

export interface ClientPluginContext {
  id: string;
  logger: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
    debug(msg: string, ...args: unknown[]): void;
  };
  storage: ClientPluginStorage;
  registerSlot(
    slot: UISlotName,
    component: unknown,
    options?: { order?: number; label?: string; icon?: string },
  ): void;
  registerPlayAction(
    provider: (gameId: string) => Promise<PlayAction[]> | PlayAction[],
  ): () => void;
  registerGameMenuItem(item: GameMenuItem): () => void;
  registerSidebarItem(item: SidebarItem): () => void;
  registerTopBarItem(item: TopBarItem): () => void;
  registerLaunchHook(hook: LaunchHook): () => void;
  gameFs: ScopedGameFs;
  gameScanner: ScopedGameScanner;
  serverWs: ClientPluginWebSocket;
}

export interface ClientPlugin {
  metadata?: {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    category?: string;
  };
  init(ctx: ClientPluginContext): Promise<void> | void;
  teardown?(): Promise<void> | void;
}
