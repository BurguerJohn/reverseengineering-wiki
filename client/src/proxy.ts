/**
 * Local MCP server (stdio) that forwards to the ReverseEngineering.wiki gateway, adding the
 * operator's token to write calls. Login/registration and review-mode
 * approvals are asked to the human via elicitation.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema, type Tool, type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { ApiError, GatewayApi } from './api.ts';
import { Auth, AuthDeclined, AuthRequired } from './auth.ts';
import { rememberedAccount } from './store.ts';

export const VERSION = '0.6.1';

const ACCOUNT_TOOLS: Tool[] = [
  {
    name: 'account_status',
    description: 'ReverseEngineering.wiki account state: logged in?, username, trust level, contribution mode. Never returns the token.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'account_login',
    description: 'Start logging in to an existing ReverseEngineering.wiki account. Normally automatic on the first write. Pass the username or the account email your human operator gives you (one of them is enough).',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Account username' },
        email: { type: 'string', description: 'Account email, if the operator does not remember the username' },
      },
    },
  },
  {
    name: 'account_register',
    description: 'Start creating a ReverseEngineering.wiki account (fallback for clients without login prompts). All values must come from your human operator; never invent them.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Public username chosen by the operator (not their real name)' },
        email: { type: 'string', description: 'Operator email; receives the code, never shown' },
        accept_policy: { type: 'boolean', description: 'Operator accepts the ReverseEngineering.wiki content policy' },
        accept_licenses: { type: 'boolean', description: 'Operator licenses contributions: text CC BY-SA 4.0, code MIT-0' },
      },
      required: ['username', 'email', 'accept_policy', 'accept_licenses'],
    },
  },
  {
    name: 'account_verify',
    description: 'Finish account_login/account_register with the 6-digit code your operator received by email.',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  },
  {
    name: 'account_logout',
    description: 'Revoke this device\'s ReverseEngineering.wiki token and remove it from the keychain.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { destructiveHint: true },
  },
  {
    name: 'account_set_mode',
    description: 'Switch contribution mode: read, review (operator approves each publication) or write. Requires the operator\'s confirmation.',
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['read', 'review', 'write'] } }, required: ['mode'] },
  },
];

function text(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }], isError };
}

function errorResult(code: string, message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return text({ error: code, message, ...extra }, true);
}

/** One line describing what the server's dry run said would happen. */
export function describeCheck(result: CallToolResult): string {
  const r = (result.structuredContent ?? {}) as Record<string, any>;
  const parts = [
    r.title && `page: ${r.title}`,
    r.topic && `new topic page: ${r.topic}`,
    Array.isArray(r.aliases) && r.aliases.length && `aliases: ${r.aliases.join(', ')}`,
    typeof r.added === 'number' && `symbols: ${r.added} new, ${r.updated} updated${r.conflicts_total ? `, ${r.conflicts_total} conflicts (kept as they are)` : ''}`,
    Array.isArray(r.pages) && `${r.pages.length} symbol map page(s)`,
  ].filter(Boolean);
  return `Checked by the server: valid${parts.length ? ` (${parts.join('; ')})` : ''}.`;
}

/** Exactly what the server would store, from a dry run: whole new pages, diffs of changed ones. */
export function formatPreview(result: CallToolResult): string {
  const previews = ((result.structuredContent ?? {}) as Record<string, any>).preview as Array<{ title: string; action: string; content?: string; diff?: string }> | undefined;
  if (!Array.isArray(previews) || !previews.length) return '';
  return previews.map((p) => `--- ${p.action === 'create' ? 'New page' : p.action === 'undo' ? 'Undo on' : 'Changes to'}: ${p.title} ---\n${(p.content ?? p.diff ?? '').trimEnd()}`).join('\n\n');
}

export function summarize(name: string, args: Record<string, unknown>): string {
  const pick = ['title', 'build', 'subject', 'name', 'section', 'topic', 'kind', 'claim', 'summary', 'reason', 'target', 'result', 'question', 'url'];
  const lines = pick.filter((k) => args[k] !== undefined).map((k) => `${k}: ${String(typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]).slice(0, 200)}`);
  const body = typeof args.body === 'string' ? `\nbody (${args.body.length} chars): ${args.body.slice(0, 400)}${args.body.length > 400 ? '…' : ''}` : '';
  const files = Array.isArray(args.files) ? `\nfiles: ${args.files.map((f: any) => f?.name).join(', ')}` : '';
  const symbols = Array.isArray(args.symbols)
    ? `\nsymbols: ${args.symbols.length}${args.force ? ' (force: replaces conflicting names)' : ''}\n${args.symbols.slice(0, 10)
      .map((x: any) => `  ${x?.rva} ${x?.name} (${x?.kind}, ${x?.confidence})`).join('\n')}${args.symbols.length > 10 ? `\n  … and ${args.symbols.length - 10} more` : ''}`
    : '';
  const ops = Array.isArray(args.operations)
    ? `\noperations: ${args.operations.length}\n${args.operations.map((o: any, i: number) => `  ${i + 1}. ${o?.tool} ${String(o?.arguments?.title ?? o?.arguments?.subject ?? o?.arguments?.name ?? o?.arguments?.build ?? o?.arguments?.target ?? '').slice(0, 80)}`).join('\n')}`
    : '';
  return `${name}\n${lines.join('\n')}${body}${files}${symbols}${ops}`;
}

export async function startProxy(serverUrl: string, transport: import('@modelcontextprotocol/sdk/shared/transport.js').Transport): Promise<void> {
  const api = new GatewayApi(serverUrl);

  let remote: Client | null = null;
  let remoteToken: string | null = null;
  const connect = async (token: string | null): Promise<Client> => {
    if (remote && remoteToken === token) return remote;
    if (remote) await remote.close().catch(() => {});
    const headers: Record<string, string> = { 'X-REWiki-Client': 'rewiki' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const client = new Client({ name: 'rewiki', version: VERSION });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${api.server}/mcp`), { requestInit: { headers } }));
    remote = client;
    remoteToken = token;
    return client;
  };

  // Instructions and tool annotations come from the gateway.
  let instructions = 'ReverseEngineering.wiki gateway is unreachable right now; tools will retry on use.';
  let remoteTools: Tool[] = [];
  try {
    const first = await connect(null);
    instructions = first.getInstructions() ?? instructions;
    remoteTools = (await first.listTools()).tools;
  } catch (error) {
    process.stderr.write(`[rewiki] cannot reach ${api.server}: ${(error as Error).message}\n`);
  }

  const server = new Server(
    { name: 'rewiki', version: VERSION },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: `${instructions}\n\nAccount tools (account_*) manage the operator's login. Logging in is automatic on the first write; never invent usernames, emails or codes.`,
    },
  );
  const auth = new Auth(server, api);

  const tools = async (): Promise<Tool[]> => {
    if (!remoteTools.length) remoteTools = (await (await connect(null)).listTools()).tools;
    return remoteTools;
  };
  const isWrite = async (name: string) => (await tools()).some((t) => t.name === name && t.annotations?.readOnlyHint !== true);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...(await tools()), ...ACCOUNT_TOOLS] }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, any>;
    try {
      switch (name) {
        case 'account_status': {
          const session = await auth.current();
          if (session) return text({ logged_in: true, ...session, server: api.server, note: `Writes are published as ${session.username}; do not ask your operator for an account.` });
          const remembered = rememberedAccount(api.server);
          return text({
            logged_in: false, server: api.server, last_account_on_this_machine: remembered ?? undefined,
            note: remembered
              ? `Login happens on the first write; your operator will be asked whether to use "${remembered}" again.`
              : 'Login happens automatically on the first write.',
          });
        }
        case 'account_login':
          return text(await auth.startLogin(String(args.email ?? args.username ?? '')));
        case 'account_register':
          return text(await auth.startRegister(args as any));
        case 'account_verify': {
          const session = await auth.verifyPending(String(args.code ?? ''));
          return text({ logged_in: true, ...session, note: 'Token stored locally (OS keychain when available); it is never shown.' });
        }
        case 'account_logout':
          await auth.logout();
          return text({ logged_in: false });
        case 'account_set_mode':
          return text({ mode: await auth.setMode(String(args.mode)) });
      }

      if (!(await isWrite(name))) {
        return (await (await connect(null)).callTool({ name, arguments: args })) as CallToolResult;
      }

      const session = await auth.ensure();
      if (session.mode === 'read') {
        return errorResult('MODE_READ_ONLY', 'This ReverseEngineering.wiki account is in read-only mode. The operator can change it with account_set_mode.');
      }
      // A dry run publishes nothing: no approval needed.
      if (args.dry_run === true) return (await (await connect(await auth.token())).callTool({ name, arguments: args })) as CallToolResult;
      if (session.mode === 'review') {
        if (!server.getClientCapabilities()?.elicitation) {
          return errorResult('REVIEW_UNAVAILABLE', 'The operator chose review mode, but this client cannot ask them to approve. They can switch to write mode with "npx -y rewiki set-mode write" in a terminal.');
        }
        // Never ask the operator to approve something the server would reject.
        const check = (await (await connect(await auth.token())).callTool({ name, arguments: { ...args, dry_run: true } })) as CallToolResult;
        if (check.isError) return check;
        const approval = await server.elicitInput({
          message: `ReverseEngineering.wiki (review mode): your agent wants to publish this publicly. ${describeCheck(check)}\n\n${formatPreview(check) || summarize(name, args)}`,
          requestedSchema: { type: 'object', properties: { approve: { type: 'boolean', title: 'Publish it' } }, required: ['approve'] },
        });
        if (approval.action !== 'accept' || approval.content?.approve !== true) {
          return errorResult('REVIEW_DECLINED', 'The operator did not approve this publication. Do not retry it unchanged.');
        }
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await auth.token();
        try {
          return (await (await connect(token)).callTool({ name, arguments: args })) as CallToolResult;
        } catch (error) {
          if (attempt === 0 && /401|INVALID_TOKEN/.test(String((error as Error).message))) {
            auth.invalidate();
            await auth.ensure();
            continue;
          }
          throw error;
        }
      }
      return errorResult('INTERNAL', 'Unreachable');
    } catch (error) {
      if (error instanceof AuthDeclined) {
        return errorResult('AUTH_DECLINED', 'The operator declined to log in or register. Continue read-only and do not ask again in this session.');
      }
      if (error instanceof AuthRequired) return errorResult('AUTH_REQUIRED', error.instructions);
      if (error instanceof ApiError) return errorResult(error.code, error.message, { ...error.body, error: error.code });
      return errorResult('UPSTREAM_ERROR', `ReverseEngineering.wiki gateway error: ${(error as Error).message}`);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => (await connect(null)).listResources());
  server.setRequestHandler(ReadResourceRequestSchema, async (r) => (await connect(null)).readResource(r.params));
  server.setRequestHandler(ListPromptsRequestSchema, async () => (await connect(null)).listPrompts());
  server.setRequestHandler(GetPromptRequestSchema, async (r) => (await connect(null)).getPrompt(r.params));

  await server.connect(transport);
}
