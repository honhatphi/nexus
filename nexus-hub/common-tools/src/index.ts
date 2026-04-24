export { CodeParser, parseSource, detectLanguage } from "./universal-parser.js";
export type {
  SupportedLanguage,
  SymbolKind,
  SymbolInfo,
  Parameter,
  FunctionCall,
  InfraKind,
  InfraPattern,
  ClassInfo,
  FunctionInfo,
  ParseResult,
  DagTaskInfo,
  DagInfo,
} from "./types.js";
export { EXTENSION_MAP, toLegacyFunctionInfo } from "./types.js";

export { SyncServiceKnowledge } from "./sync-tool.js";
export type { SyncToolConfig, SyncReport } from "./sync-tool.js";

// Pipeline exports
export { PipelineEngine } from "./pipeline/index.js";
export { filesystemPhase } from "./pipeline/phase-0-filesystem.js";
export { parsePhase } from "./pipeline/phase-1-parse.js";
export { graphUpsertPhase } from "./pipeline/phase-2-graph.js";
export { vectorUpsertPhase } from "./pipeline/phase-3-vectors.js";
export { metadataPhase } from "./pipeline/phase-4-metadata.js";
export { importResolutionPhase } from "./pipeline/phase-5-imports.js";
export { heritagePhase } from "./pipeline/phase-6-heritage.js";
export { communityPhase } from "./pipeline/phase-7-community.js";
export { kafkaLinkagePhase } from "./pipeline/phase-8a-kafka-linkage.js";
export { httpLinkagePhase } from "./pipeline/phase-8b-http-linkage.js";
export { grpcLinkagePhase } from "./pipeline/phase-8c-grpc-linkage.js";
export { messagingLinkagePhase } from "./pipeline/phase-8d-messaging-linkage.js";
export { processTracingPhase } from "./pipeline/phase-8-process.js";
export { typeResolutionPhase } from "./pipeline/phase-9-types.js";
export { createEmptyContext } from "./pipeline/types.js";

// Parser exports
export { isOpenApiFile, parseOpenApiSpec } from "./parser/openapi-spec.js";
export {
  isDockerComposeFile,
  parseDockerCompose,
} from "./parser/docker-compose.js";
export type {
  PipelineContext,
  PipelineDeps,
  PipelinePhase,
  PipelineReport,
  PhaseResult,
  PhaseError,
  PipelineStats,
  FileEntry,
  GraphClient,
  VectorClient,
  CodeParserInterface,
} from "./pipeline/types.js";
export type { StalenessInfo } from "./pipeline/phase-4-metadata.js";
export { getCommitCount } from "./pipeline/phase-4-metadata.js";
