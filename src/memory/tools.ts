/**
 * Memory tools — schemas the proxy / SDK expose to the model, and the
 * handler that executes them against a `MemoryStore`.
 *
 * Tool names: memory_save, memory_search, memory_update, memory_delete,
 * memory_list. Schemas are emitted in a stable key order so the bytes on the
 * wire are identical across turns (prefix-cache stability).
 */

import type { MessageFormat } from '../compress/types.js';
import { jaccard } from './rank.js';
import { normalizeMemoryText } from './types.js';
import type { MemoryStore } from './store.js';
import type { Memory, MemoryKind, MemoryScope } from './types.js';

export const MEMORY_TOOL_NAMES = ['memory_save', 'memory_search', 'memory_update', 'memory_delete', 'memory_list'] as const;
/** Token overlap at which a save gets a "similar memory exists" hint (never auto-merged). */
export const SIMILAR_NOTE_THRESHOLD = 0.75;
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

export function isMemoryTool(name: string): name is MemoryToolName {
  return (MEMORY_TOOL_NAMES as readonly string[]).includes(name);
}

interface ToolSpec {
  name: MemoryToolName;
  description: string;
  parameters: Record<string, unknown>;
}

const IMPORTANCE_DESC = 'Importance score from 0.0 (low) to 1.0 (critical). Higher importance memories are prioritized in search results and less likely to be forgotten.';

const SPECS: readonly ToolSpec[] = [
  {
    name: 'memory_save',
    description: `Save important information to long-term memory for future reference.

Use this tool when you encounter information that should be remembered across conversations, such as:
- User preferences (e.g., "prefers Python over JavaScript", "likes concise answers")
- Personal facts (e.g., "works at Acme Corp", "has a dog named Max")
- Project context (e.g., "working on a CLI tool", "using React 18")
- Decisions made (e.g., "chose PostgreSQL for the database", "decided on REST over GraphQL")
- Important relationships (e.g., "Alice is Bob's manager", "Project X depends on Service Y")
- Technical insights (e.g., "the auth module is in src/auth/", "uses custom logging format")

DO save:
- Information explicitly shared by the user that seems important for future interactions
- Corrections to previous assumptions or memories
- Key decisions and their rationale
- Recurring topics or preferences that emerge from conversation patterns

DO NOT save:
- Transient information only relevant to the current conversation
- Sensitive data like passwords, API keys, or private credentials
- Information the user explicitly asks not to remember
- Redundant information already stored (search first if unsure)

The importance score (0.0-1.0) helps prioritize memories during retrieval:
- 0.9-1.0: Critical facts that should almost always be recalled
- 0.7-0.8: Important preferences or context
- 0.5-0.6: Useful but not essential information
- 0.3-0.4: Nice-to-have background context
- 0.1-0.2: Low-priority supplementary details`,
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description:
            "The information to remember. Be specific and self-contained - this should make sense without additional context. Good: 'User prefers dark mode in all applications'. Bad: 'likes dark mode'.",
        },
        importance: { type: 'number', minimum: 0, maximum: 1, description: IMPORTANCE_DESC },
        entities: {
          type: 'array',
          items: { type: 'string' },
          description: "List of entity names or identifiers referenced in this memory (e.g., ['Alice', 'Project X', 'auth-service']). Used for entity-based retrieval and relationship tracking.",
        },
        relationships: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', description: 'Source entity name' },
              relation: { type: 'string', description: "Relationship type (e.g., 'works_with', 'manages', 'depends_on', 'is_part_of')" },
              target: { type: 'string', description: 'Target entity name' },
            },
            required: ['source', 'relation', 'target'],
          },
          description: "Relationships between entities mentioned in this memory. Enables graph-based queries like 'who does Alice work with?'",
        },
      },
      required: ['content', 'importance'],
    },
  },
  {
    name: 'memory_search',
    description: `Search stored memories to recall relevant information.

Use this tool to retrieve previously saved information before responding to questions about:
- User preferences or past decisions
- Personal or professional context
- Previously discussed topics or projects
- Relationships between people, systems, or concepts
- Historical context from past conversations

Search strategies:
1. Semantic search (default): Use natural language queries that describe what you're looking for
   - "user's programming language preferences"
   - "information about the current project"
   - "past decisions about database choices"

2. Entity-based search: Specify entities to find memories mentioning specific people/things
   - entities=["Alice", "Project X"] finds memories involving Alice or Project X

3. Related memories: Set include_related=true to also retrieve connected memories
   - Finds memories linked by shared entities or explicit relationships

Best practices:
- Search BEFORE saving to avoid duplicates
- Search when answering questions that might rely on remembered information
- Use specific queries for better precision
- Combine entity filters with semantic queries for targeted retrieval`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Natural language search query describing what information you're looking for. Be specific but not too narrow." },
        entities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter to memories mentioning any of these entities. Useful for finding information about specific people, projects, or systems.',
        },
        include_related: { type: 'boolean', description: 'If true, also retrieve memories connected to the results via entity relationships. Helps build fuller context around a topic.' },
        top_k: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum number of memories to retrieve. Default is 10. Use higher values when you need comprehensive context.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_update',
    description: `Update an existing memory with new or corrected information.

Use this when the user corrects a previously saved fact, when information changes, or when you want to add detail to an existing memory. The update creates a new version of the memory and preserves history. Take the memory ID from the [id] prefix shown in the auto-injected memory block, or from a memory_search / memory_list result.`,
    parameters: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'The unique ID of the memory to update. Take this from the [id] prefix shown in the auto-injected memory block, or from a memory_search / memory_list result.' },
        new_content: { type: 'string', description: 'The updated content that will replace the existing memory content. Should be complete and self-contained.' },
        reason: { type: 'string', description: "Explanation for why this memory is being updated (e.g., 'user correction', 'information changed', 'adding detail'). Stored for audit trail." },
      },
      required: ['memory_id', 'new_content'],
    },
  },
  {
    name: 'memory_delete',
    description: `Delete a memory that is outdated, incorrect, or that the user asked you to forget.

Deletion is soft by default (the row is removed from retrieval). Take the memory ID from the [id] prefix shown in the auto-injected memory block, or from a memory_search / memory_list result.`,
    parameters: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'The unique ID of the memory to delete. Take this from the [id] prefix shown in the auto-injected memory block, or from a memory_search / memory_list result.' },
        reason: { type: 'string', description: "Explanation for why this memory is being deleted (e.g., 'user request', 'outdated', 'stored in error'). Required for audit trail." },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'memory_list',
    description: `List stored memories chronologically (newest first).

Unlike memory_search (semantic), this returns the most recently saved memories regardless of relevance — useful for a quick overview or for finding a specific memory ID.`,
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum number of memories to return (default 10, max 100). Use a smaller number for a quick overview; larger when you need to find a specific memory ID.',
          minimum: 1,
          maximum: 100,
        },
      },
      required: [],
    },
  },
];

/** Tool definitions in the wire shape of `format` (stable order and key order). */
export function memoryTools(format: MessageFormat): Record<string, unknown>[] {
  return SPECS.map((s) => {
    switch (format) {
      case 'anthropic':
        return { name: s.name, description: s.description, input_schema: s.parameters };
      case 'responses':
        return { type: 'function', name: s.name, description: s.description, parameters: s.parameters };
      case 'gemini':
        return { name: s.name, description: s.description, parameters: s.parameters };
      default:
        return { type: 'function', function: { name: s.name, description: s.description, parameters: s.parameters } };
    }
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** Heuristic kind for free-text facts saved by a model. */
export function inferKind(text: string): MemoryKind {
  const t = text.toLowerCase();
  if (/^user preference|\bprefers?\b|\blikes?\b|\bwants?\b/.test(t)) return 'preference';
  if (/^(never|always|don't|do not|avoid|must)\b|\bnever\b|\balways\b/.test(t)) return 'rule';
  if (/^decision|\bdecided\b|\bchose\b|\bgo(ing)? with\b/.test(t)) return 'decision';
  if (/does not exist|fails\b|\berror\b|\bgotcha\b|\bworkaround\b|instead of/.test(t)) return 'gotcha';
  if (/^(run|working|use) .*`|\bcommand\b|`[^`]+`/.test(t) && /`/.test(t)) return 'command';
  return 'fact';
}

function errorResult(error: string): ToolResult {
  return { content: JSON.stringify({ status: 'error', error }), isError: true };
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

function numArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function listArg(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export interface HandleOptions {
  /** Scope for new memories (default: project when resolved, else user). */
  scope?: MemoryScope;
}

/**
 * Execute a memory tool. Always returns a JSON payload string; `isError` is
 * set for validation failures so wrappers can render them as tool errors.
 */
export function handleMemoryTool(store: MemoryStore, name: string, args: Record<string, unknown>, opts: HandleOptions = {}): ToolResult {
  const a = args ?? {};
  const defaultScope: MemoryScope = opts.scope ?? (store.projectResolved ? 'project' : 'user');
  try {
    switch (name) {
      case 'memory_save': {
        const content = strArg(a, 'content');
        if (!content) return errorResult('content is required');
        const importance = numArg(a, 'importance');
        if (importance !== undefined && (importance < 0 || importance > 1)) return errorResult('importance must be between 0.0 and 1.0');
        const tags = listArg(a, 'entities');
        const similar = store.search(content, { topK: 1 })[0];
        const m = store.add({ scope: defaultScope, kind: inferKind(content), text: content, tags, source: 'agent' });
        const payload: Record<string, unknown> = { status: 'saved', memory_id: m.id, content: m.text.slice(0, 100), evidence: m.evidence };
        const overlap = similar && similar.memory.id !== m.id ? jaccard(similar.memory.text, m.text) : 0;
        if (similar && overlap >= SIMILAR_NOTE_THRESHOLD) {
          payload.note = `Similar memory exists (id: ${similar.memory.id}, ${Math.round(overlap * 100)}% match): '${similar.memory.text.slice(0, 100)}'. Call memory_update('${similar.memory.id}', '<merged content>') to consolidate, or ignore if these are distinct facts.`;
        }
        return { content: JSON.stringify(payload) };
      }
      case 'memory_search': {
        const query = strArg(a, 'query');
        if (!query) return errorResult('query is required');
        const topK = Math.min(50, Math.max(1, Math.floor(numArg(a, 'top_k') ?? 10)));
        const entities = listArg(a, 'entities').map((e) => e.toLowerCase());
        let hits = store.search(query, { topK: entities.length ? topK * 3 : topK });
        if (entities.length) {
          hits = hits.filter((h) => entities.some((e) => h.memory.tags.includes(e) || h.memory.text.toLowerCase().includes(e))).slice(0, topK);
        }
        return {
          content: JSON.stringify({
            status: 'found',
            count: hits.length,
            memories: hits.map((h) => ({ id: h.memory.id, content: h.memory.text, score: Number(h.score.toFixed(3)), entities: h.memory.tags.slice(0, 5) })),
          }),
        };
      }
      case 'memory_update': {
        const id = strArg(a, 'memory_id');
        if (!id) return errorResult('memory_id is required');
        const text = strArg(a, 'new_content');
        if (!text) return errorResult('new_content is required');
        const updated = store.update(id, text);
        if (!updated) return errorResult(`Memory not found: ${id}`);
        return { content: JSON.stringify({ status: 'updated', memory_id: updated.id, previous_id: id }) };
      }
      case 'memory_delete': {
        const id = strArg(a, 'memory_id');
        if (!id) return errorResult('memory_id is required');
        const ok = store.delete(id);
        return { content: JSON.stringify({ status: ok ? 'deleted' : 'not_found', memory_id: id }) };
      }
      case 'memory_list': {
        const limit = Math.min(100, Math.max(1, Math.floor(numArg(a, 'limit') ?? 10)));
        const rows = store.list({ limit });
        return { content: JSON.stringify({ status: 'ok', count: rows.length, memories: rows.map((m) => ({ id: m.id, content: m.text, created_at: new Date(m.createdAt).toISOString() })) }) };
      }
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return errorResult(e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// MCP-flavoured helpers (text results) for `vg serve`
// ---------------------------------------------------------------------------

export const MCP_MEMORY_SEARCH_DESCRIPTION =
  'Search persistent memory for relevant knowledge from prior sessions. Use this for questions about architecture, conventions, prior decisions, project context, user preferences, org info, codenames, debugging history, or anything that might have been discussed before.';

export const MCP_MEMORY_SAVE_DESCRIPTION = `Save information to persistent memory for future sessions. Use this for decisions, conventions, architecture context, user preferences, project facts, or anything worth remembering. Saving a similar fact does not replace an existing memory; corrections must use an explicit update path with the existing memory ID.

IMPORTANT: Break information into atomic facts — one fact per entry in the 'facts' array. Each fact should be a single, self-contained statement that answers one question. Do NOT combine multiple facts into one string.

Good:  facts: ['Repo owner is Tejas C.', 'User prefers dark mode']
Bad:   facts: ['Repo owner is Tejas C. Prefers dark mode.']`;

export const MCP_MEMORY_SEARCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Natural-language search query.' },
    top_k: { type: 'integer', description: 'Max results to return (default 10).', default: 10 },
  },
  required: ['query'],
};

export const MCP_MEMORY_SAVE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: { type: 'string' },
      description: 'Array of atomic facts to save. Each entry should be one self-contained fact. The system stores and indexes each fact separately for precise retrieval.',
    },
    importance: { type: 'number', description: '0.0 (low) to 1.0 (critical). Default 0.7.', default: 0.7 },
  },
  required: [],
};

/** `{i}. [relevance=0.87] text` rows, or "No memories found." */
export function mcpMemorySearch(store: MemoryStore, args: Record<string, unknown>): string {
  const query = strArg(args, 'query');
  if (!query) return 'Error: query is required';
  const topK = Math.max(1, Math.floor(numArg(args, 'top_k') ?? 10));
  try {
    const hits = store.search(query, { topK });
    if (hits.length === 0) return 'No memories found.';
    const lines: string[] = [];
    hits.forEach((h, i) => {
      lines.push(`${i + 1}. [relevance=${h.score.toFixed(2)}] ${h.memory.text}`);
      if (h.memory.tags.length) lines.push(`   Related: ${h.memory.tags.slice(0, 3).join(', ')}`);
    });
    return lines.join('\n');
  } catch (e) {
    return `Search error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Saves each fact separately; returns the summary + per-fact lines. */
export function mcpMemorySave(store: MemoryStore, args: Record<string, unknown>, opts: HandleOptions = {}): string {
  let facts = listArg(args, 'facts').map((f) => normalizeMemoryText(f)).filter(Boolean);
  if (facts.length === 0) {
    const content = strArg(args, 'content');
    if (content) facts = [content];
  }
  if (facts.length === 0) return 'Error: facts array is required';
  const scope: MemoryScope = opts.scope ?? (store.projectResolved ? 'project' : 'user');
  try {
    let saved = 0;
    let updated = 0;
    const lines: string[] = [];
    for (const fact of facts) {
      const m: Memory = store.add({ scope, kind: inferKind(fact), text: fact, tags: [], source: 'agent' });
      if (m.evidence > 1) updated++;
      else saved++;
      lines.push(`  saved [${m.id.slice(0, 8)}]: ${fact.slice(0, 60)}`);
    }
    return `Saved ${saved} new, updated ${updated} existing (${saved + updated} total)\n${lines.join('\n')}`;
  } catch (e) {
    return `Save error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
