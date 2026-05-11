// ─────────────────────────────────────────────────────────────
// @nexus-hub/core — public API
// ─────────────────────────────────────────────────────────────

// Environment helpers (centralised env-var reading)
export {
  nexusDataDir,
  nexusWorkspaceDir,
  defaultWorkspaceId,
  defaultMaxInputTokens,
  defaultReservedTokens,
} from "./env.js";

// Core façade
export { NexusCore } from "./nexus-core.js";
export type {
  INexusCore,
  NexusCoreOptions,
  SymbolContextInput,
  SymbolContext,
  StalenessInfo,
} from "./nexus-core.js";

// Ports
export type { GraphStore } from "./ports/graph-store.js";
export type { VectorStore, VectorSearchResult } from "./ports/vector-store.js";
export type {
  Retriever,
  SearchInput,
  SearchResult,
  SearchMode,
} from "./ports/retriever.js";
export type {
  CodeIndexer,
  SyncInput,
  SyncSummary,
} from "./ports/code-indexer.js";
export type { MemoryStore } from "./ports/memory-store.js";
export type {
  ArtifactStore,
  StoreArtifactInput,
  ArtifactExcerpt,
} from "./ports/artifact-store.js";
export type { BudgetEstimator } from "./ports/budget-estimator.js";

// Contracts (PR 2)
export type { TokenBudget } from "./contracts/token-budget.js";
export { DEFAULT_BUDGET, MAX_BUDGET } from "./contracts/token-budget.js";
export type { ArtifactRef, ArtifactKind } from "./contracts/artifact.js";
export type {
  TaskLedger,
  Decision,
  CommandSummary,
} from "./contracts/task-ledger.js";
export type {
  ContextPack,
  ContextManifestItem,
  ContextSection,
  ContextMode,
  ContextFreshness,
  ContextItemType,
  BuildContextPackInput,
  ContextPackPreferences,
} from "./contracts/context-pack.js";
export type { ToolOutput } from "./contracts/tool-output.js";

// Adapters
export { MemgraphGraphStore } from "./adapters/memgraph-graph-store.js";
export { ChromadbVectorStore } from "./adapters/chromadb-vector-store.js";
export { ExistingHybridRetriever } from "./adapters/existing-hybrid-retriever.js";
export { ExistingPipelineIndexer } from "./adapters/existing-pipeline-indexer.js";

// Memory Engine (PR 4)
export { InMemoryLedgerStore } from "./memory/ledger-store.js";
export { FileLedgerStore } from "./memory/file-ledger-store.js";
export { LedgerService } from "./memory/ledger-service.js";
export type {
  OpenTaskResult,
  CompactTaskState,
  UpdateLedgerInput,
} from "./memory/ledger-service.js";

// Artifact Store (PR 5)
export { FileArtifactStore } from "./artifacts/file-artifact-store.js";
export { ArtifactService } from "./artifacts/artifact-service.js";
export type { StoreResult } from "./artifacts/artifact-service.js";

// Context Pack Builder (PR 6)
export { ContextPackBuilder } from "./context/context-pack-builder.js";
export { ContextPackStore } from "./context/context-pack-store.js";
export { ContextSectionRenderer } from "./context/context-section-renderer.js";

// Persistent index state (PR 9)
export type {
  FileHashStore,
  FileIndexEntry,
} from "./index-state/file-hash-store.js";
export { InMemoryFileHashStore } from "./index-state/file-hash-store.js";
export { JsonFileHashStore } from "./index-state/json-file-hash-store.js";

// Workspace manifest + resolver (PR 3)
export type {
  WorkspaceManifest,
  WorkspaceState,
  RepoEntry,
  IndexingConfig,
  ContextConfig,
} from "./workspace/workspace-manifest.js";
export { WorkspaceResolver } from "./workspace/workspace-resolver.js";
export { RepoDetector } from "./workspace/repo-detector.js";
export type { DetectedRepo } from "./workspace/repo-detector.js";

// Task workspace (PR 12)
export { TaskWorkspaceManager } from "./task-workspace/task-workspace-manager.js";
export type {
  SpawnWorkspaceInput,
  TaskWorkspaceInfo,
} from "./task-workspace/task-workspace-manager.js";
export { PatchGenerator } from "./task-workspace/patch-generator.js";
export type {
  FilePatch,
  GeneratedPatch,
} from "./task-workspace/patch-generator.js";

// Budget Engine (PR 8)
export {
  estimateTokens,
  estimateObjectTokens,
  evaluateBudget,
  limitOutput,
  DefaultBudgetEstimator,
} from "./budget/budget-engine.js";
export type {
  BudgetDecision,
  BudgetAction,
  LimitedOutput,
} from "./budget/budget-engine.js";
