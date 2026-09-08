/**
 * Session-failure learning — public barrel.
 *
 * `scanSessions` (eight agent transcript formats → one `Session` shape),
 * `detectLoops` (measured waste), `analyze` (deterministic digest + rules),
 * `renderLearnBlock` / `writeLearnBlock` (marker block in the instructions
 * file), `learnVerbosity` (+ save/load) and the optional `runCliAnalyzer`.
 */

export type {
  AgentId,
  Digest,
  ErrorCategory,
  FailingCommand,
  Loop,
  LoopKind,
  Recovery,
  Rule,
  RuleTarget,
  ScanOptions,
  Scanner,
  Session,
  SessionSource,
  ToolCall,
  Turn,
  TurnKind,
  VerbosityProfile,
  VerbosityStats,
} from './types.js';
export { AGENT_IDS, isAgentId } from './types.js';
export { classifyError, isErrorContent, normalizeToolName, inputSummary, makeToolCall, stringifyOutput, truncateHeadTail, parseTimestamp, countWords, contentText, homeDir } from './shared.js';
export { SCANNERS, scannerFor, scanSessions, projectMatches, compareSessions, parseDuration } from './scan.js';
export type { ScanSessionsOptions } from './scan.js';
export { SessionBuilder, feedChatRecord, sessionFromChatRecords } from './scanners/common.js';
export { claudeScanner, claudeConfigDir, decodeClaudeProjectDir } from './scanners/claude.js';
export { codexScanner, normalizeCodexTool, parseCodexOutput } from './scanners/codex.js';
export { geminiScanner } from './scanners/gemini.js';
export { grokScanner, extractGrokOutput } from './scanners/grok.js';
export { opencodeScanner, opencodeDataDir } from './scanners/opencode.js';
export { cursorScanner, decodeCursorSlug } from './scanners/cursor.js';
export { copilotScanner } from './scanners/copilot.js';
export { aiderScanner, parseAiderHistory, aiderHistoryFiles } from './scanners/aider.js';
export { detectLoops, detectLoopsAcross, canonicalSignature, errorSignature, formatLoopsForDigest, signatureTokens, compareLoops, DEFAULT_MIN_OCCURRENCES, BYTES_PER_TOKEN, LOOPS_DIGEST_HEADER } from './loops.js';
export {
  analyze,
  applyLoopWeighting,
  compareRules,
  renderDigestText,
  renderAnalyzerPrompt,
  renderPriorPatterns,
  stripFencedJson,
  validateAnalyzerOutput,
  parseAnalyzerOutput,
  ANALYZER_SYSTEM_PROMPT,
  ANALYZER_USER_PREFIX,
  ANALYZER_OUTPUT_SCHEMA,
  MAX_DIGEST_TOKENS,
  SECTION_ORDER,
  SECTION_LOOPS,
  SECTION_ENVIRONMENT,
  SECTION_PATHS,
  SECTION_SEARCH,
  SECTION_COMMANDS,
  SECTION_PREFERENCES,
  SECTION_RETRIES,
  SECTION_PERMISSIONS,
} from './analyzer.js';
export type { AnalyzeOptions } from './analyzer.js';
export { runCliAnalyzer, cliCommand, extractStreamResult, defaultSpawn, DEFAULT_CLI_TIMEOUT_MS, DEFAULT_CLI_IDLE_TIMEOUT_MS } from './cli-analyzer.js';
export type { CliAnalyzerOptions, CliAnalyzerResult, SpawnFn, ChildLike } from './cli-analyzer.js';
export {
  LEARN_BEGIN,
  LEARN_END,
  LEARN_HEADING,
  DEFAULT_LEARN_TARGET,
  KNOWN_LEARN_TARGETS,
  renderLearnBlock,
  renderLearnSections,
  rulesToSections,
  extractLearnBlock,
  parseLearnSections,
  stripLearnBlock,
  mergeLearnSections,
  mergeLearnBlock,
  unifiedDiff,
  writeLearnBlock,
  resolveLearnTarget,
} from './writer.js';
export type { LearnSection, WriteLearnResult } from './writer.js';
export { learnVerbosity, verbositySignals, verbosityStats, recommendLevel, saveVerbosityProfile, loadVerbosityProfile, READING_WPM, SKIP_READ_FRACTION, MIN_WORDS_FOR_SKIP, LONG_OUTPUT_FLOOR } from './verbosity.js';
export type { VerbositySignals } from './verbosity.js';
export { learnStatePath, readLearnState, recordLearnRun, lastLearnRun } from './state.js';
export type { LearnRun, LearnState } from './state.js';
