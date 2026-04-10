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
} from "./types.js";
export { EXTENSION_MAP, toLegacyFunctionInfo } from "./types.js";

export { SyncServiceKnowledge } from "./sync-tool.js";
export type { SyncToolConfig, SyncReport } from "./sync-tool.js";
