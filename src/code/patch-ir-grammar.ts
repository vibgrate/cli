/**
 * Constrained-decoding grammars for PatchIR (Fusion Approach B / ADR-005).
 *
 * Spark-tier local models should emit syntactically valid PatchIR JSON so apply
 * never parses free-text tool calls. Providers that support GBNF (llama.cpp via
 * llm-host) receive {@link patchIrGbnf}; others ignore the grammar field.
 *
 * The grammar is intentionally permissive on string contents (file paths, code)
 * while fixing the structural keys and op enum — highest leverage for zero
 * retry loops without needing a full JSON Schema compiler in-process.
 */

/** GBNF that constrains the model to a PatchIR-shaped JSON object (schema patch-ir/0). */
export function patchIrGbnf(): string {
  // GBNF subset understood by llama.cpp-style engines.
  return String.raw`root ::= ws patch
ws ::= [ \t\n]*
patch ::= "{" ws
  "\"schemaVersion\"" ws ":" ws "\"patch-ir/0\"" ws "," ws
  "\"operations\"" ws ":" ws operations ws "," ws
  "\"assumptions\"" ws ":" ws array-any ws "," ws
  "\"requestedVerification\"" ws ":" ws array-any ws "," ws
  "\"provenance\"" ws ":" ws provenance
  ws "}"
operations ::= "[" ws operation (ws "," ws operation)* ws "]"
operation ::= replace-range | replace-text | create-file | delete-file | replace-symbol
replace-range ::= "{" ws
  "\"op\"" ws ":" ws "\"replace-range\"" ws "," ws
  "\"file\"" ws ":" ws string ws "," ws
  "\"start\"" ws ":" ws number ws "," ws
  "\"end\"" ws ":" ws number ws "," ws
  "\"replacement\"" ws ":" ws string
  (ws "," ws "\"expectedHash\"" ws ":" ws (string | null) )?
  (ws "," ws "\"anchorSymbol\"" ws ":" ws (string | null) )?
  ws "}"
replace-text ::= "{" ws
  "\"op\"" ws ":" ws "\"replace-text\"" ws "," ws
  "\"file\"" ws ":" ws string ws "," ws
  "\"search\"" ws ":" ws string ws "," ws
  "\"replace\"" ws ":" ws string
  (ws "," ws "\"anchorSymbol\"" ws ":" ws (string | null) )?
  ws "}"
create-file ::= "{" ws
  "\"op\"" ws ":" ws "\"create-file\"" ws "," ws
  "\"file\"" ws ":" ws string ws "," ws
  "\"content\"" ws ":" ws string
  ws "}"
delete-file ::= "{" ws
  "\"op\"" ws ":" ws "\"delete-file\"" ws "," ws
  "\"file\"" ws ":" ws string
  ws "}"
replace-symbol ::= "{" ws
  "\"op\"" ws ":" ws "\"replace-symbol\"" ws "," ws
  "\"symbolId\"" ws ":" ws string ws "," ws
  "\"replacement\"" ws ":" ws string
  (ws "," ws "\"file\"" ws ":" ws (string | null) )?
  (ws "," ws "\"expectedHash\"" ws ":" ws (string | null) )?
  ws "}"
provenance ::= "{" ws
  "\"format\"" ws ":" ws format
  (ws "," ws "\"modelId\"" ws ":" ws (string | null) )?
  (ws "," ws "\"raw\"" ws ":" ws (string | null) )?
  ws "}"
format ::= "\"search-replace\"" | "\"whole-file\"" | "\"structured-json\"" | "\"grammar-constrained\"" | "\"code-edit\""
array-any ::= "[" ws (value (ws "," ws value)*)? ws "]"
value ::= object | array-any | string | number | "true" | "false" | null
object ::= "{" ws (string ws ":" ws value (ws "," ws string ws ":" ws value)*)? ws "}"
string ::= "\"" (
  [^"\\] |
  "\\" (["\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])
)* "\""
number ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [+-]? [0-9]+)?
null ::= "null"
`;
}

/**
 * Whether the agent should attach a PatchIR grammar for this profile.
 * Grammar path is for local constrained backends (llama.cpp); HTTP providers ignore it.
 */
export function shouldUsePatchIrGrammar(profile?: {
  constrainedDecoding?: boolean;
  toolCalling?: string;
  editFormat?: string;
} | null): boolean {
  if (!profile) return false;
  if (profile.constrainedDecoding) return true;
  if (profile.toolCalling === 'grammar') return true;
  if (profile.editFormat === 'patch_ir_json' && profile.constrainedDecoding !== false) {
    // Prefer grammar when the pack is already PatchIR-oriented and decoding flag is not off.
    return !!profile.constrainedDecoding;
  }
  return false;
}
