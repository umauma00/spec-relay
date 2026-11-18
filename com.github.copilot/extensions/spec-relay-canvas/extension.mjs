// spec-relay canvas: shows the migration's progress, review pages and approved
// specs in a Copilot canvas, with an "ask about this" button on every item. On
// the page of an active change the person can also tick items, write decisions
// and the reviewer's name: the canvas writes them to review.md as their own edit.
// The optional code guide (openspec/spec-relay/guide/) is shown too: an answer the
// agent sends back with post_answer appears under the question's item, and only
// the person's "Helpful (save to the Q&A)" button saves it to the guide's Q&A file.
// The agent's actions only read, move the canvas and show answers; none of them writes a file.
//
// The only file that touches the Copilot SDK (the canvas API is experimental and
// may change). Everything else is in the kit's scripts/canvas.mjs, which runs and
// is tested without Copilot.
import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';
import path from 'node:path';

const kit = new URL('../../../scripts/', import.meta.url);
const { startServer, pageName, activeChanges } = await import(new URL('canvas.mjs', kit));
const { status, checklist } = await import(new URL('status.mjs', kit));
const { language } = await import(new URL('gate.mjs', kit));
const { canvasEdits } = await import(new URL('review-edit.mjs', kit));

let session = null;
// One server per repository, shared by the canvases open on it: root key -> { root, starting, instances }.
const servers = new Map();
// Canvas instance -> root key.
const instances = new Map();

const rootOf = (ctx) => path.resolve(ctx?.session?.workingDirectory || process.cwd());
// Windows paths differ only in case for the same folder.
const keyOf = (root) => (process.platform === 'win32' ? root.toLowerCase() : root);

function serverFor(root) {
  const key = keyOf(root);
  let entry = servers.get(key);
  if (!entry) {
    entry = {
      root,
      instances: new Set(),
      // A question the person typed in the canvas goes to the chat, queued after the current turn.
      starting: startServer({ root, ask: async ({ prompt, displayPrompt }) => { await session.send({ prompt, displayPrompt, mode: 'enqueue' }); } }),
    };
    servers.set(key, entry);
    entry.starting.catch(() => { if (servers.get(key) === entry) servers.delete(key); });
  }
  return entry;
}

// A canvas no longer shows this repository: stop its server once no canvas does.
async function release(key, instanceId) {
  const entry = servers.get(key);
  if (!entry) return;
  entry.instances.delete(instanceId);
  if (entry.instances.size > 0) return;
  // Forget the server before closing it, so an open that comes meanwhile starts a new one.
  servers.delete(key);
  try { await (await entry.starting).close(); } catch { /* already gone */ }
}

// The server of the canvas an action names, or of the only open repository.
async function serverOf(ctx) {
  const key = instances.get(ctx.instanceId) ?? keyOf(rootOf(ctx));
  const entry = servers.get(key);
  if (!entry || entry.instances.size === 0) throw new CanvasError('not_open', 'Open the spec-relay canvas first (open_canvas with canvasId "spec-relay").');
  return entry.starting;
}

async function go(ctx, which) {
  const server = await serverOf(ctx);
  const page = pageName(server.root, { view: which, name: ctx.input?.name });
  if (!page.ok) throw new CanvasError('not_found', page.problem);
  server.go(page.name, page.anchor);
  return { ok: true, shown: page.name, ...(page.anchor ? { anchor: page.anchor } : {}) };
}

const nameInput = (description) => ({ type: 'object', additionalProperties: false, properties: { name: { type: 'string', description } } });

session = await joinSession({
  canvases: [
    createCanvas({
      id: 'spec-relay',
      displayName: 'spec-relay',
      description: 'Shows the spec-relay migration: progress, review pages, approved specs and the code guide, with a button to ask about any item. On the page of an active change the person can tick items, write decisions and the reviewer in review.md (their own edit; never an approval to archive). The agent cannot write through it.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          view: { type: 'string', enum: ['progress', 'review', 'spec', 'specs', 'guide'], description: 'The page to show. Default: progress.' },
          name: { type: 'string', description: 'For review: the change name (extract-billing-invoice). For spec: the capability (billing/invoice). For guide: a module, a file of the target code or a URL of routes.md (none: the guide\'s first page).' },
        },
      },
      actions: [
        {
          name: 'get_status',
          description: 'The migration status as the canvas shows it: the to-do list, where the work is, the active changes with their confirmed review items, and problems.',
          handler: async (ctx) => {
            const key = instances.get(ctx.instanceId);
            const root = key ? servers.get(key)?.root ?? rootOf(ctx) : rootOf(ctx);
            const report = status(root, { language: language(root) });
            return { todo: checklist(report, { problems: true }), current: report.current, changes: activeChanges(root), problems: report.problems };
          },
        },
        {
          name: 'get_review_edits',
          description: 'What the person changed in review.md from the canvas (ticks, decisions, the reviewer), oldest first. Read review.md again after any of them.',
          inputSchema: { type: 'object', additionalProperties: false, properties: { since: { type: 'string', description: 'Only edits after this date-time (ISO 8601, with Z or an offset such as +09:00).' } } },
          handler: async (ctx) => {
            const key = instances.get(ctx.instanceId);
            const root = key ? servers.get(key)?.root ?? rootOf(ctx) : rootOf(ctx);
            const result = canvasEdits(root, { since: typeof ctx.input?.since === 'string' ? ctx.input.since : undefined });
            if (!result.ok) throw new CanvasError('bad_input', result.problem);
            return { edits: result.edits.slice(-200) };
          },
        },
        { name: 'open_progress', description: 'Show the progress page in the open canvas.', handler: (ctx) => go(ctx, 'progress') },
        { name: 'open_review', description: 'Show the page of a change (its review) in the open canvas.', inputSchema: nameInput('The change, such as extract-billing-invoice.'), handler: (ctx) => go(ctx, 'review') },
        { name: 'open_spec', description: 'Show an approved spec, or the list of specs when no name is given, in the open canvas.', inputSchema: nameInput('The capability, such as billing/invoice.'), handler: (ctx) => go(ctx, 'spec') },
        { name: 'open_guide', description: 'Show the code guide in the open canvas: its first page, or the page of a module, a file of the target code or a URL listed in routes.md.', inputSchema: nameInput('A module (billing), a file (src/main/java/.../InvoiceService.java) or a URL (/invoices/{id}). None: the first page.'), handler: (ctx) => go(ctx, 'guide') },
        {
          name: 'post_answer',
          description: 'Show your answer to a question the person asked on a code guide page (its prompt gives the id) under the question\'s item. It writes no file: the person decides on the page whether to save it.',
          inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'answer'], properties: { id: { type: 'string', description: 'The question id from the prompt, such as q3-1a2b.' }, answer: { type: 'string', description: 'The answer, in Markdown (at most 20000 characters).' } } },
          handler: async (ctx) => {
            const server = await serverOf(ctx);
            const result = server.answer(ctx.input?.id, ctx.input?.answer);
            if (!result.ok) throw new CanvasError('not_found', result.problem);
            return { ok: true, page: result.page };
          },
        },
        { name: 'refresh', description: 'Reload the canvas after changing files (it also reloads by itself within a few seconds).', handler: async (ctx) => { (await serverOf(ctx)).refresh(); return { ok: true }; } },
      ],
      open: async (ctx) => {
        const root = rootOf(ctx);
        // Check what was asked for before starting anything.
        const page = pageName(root, { view: ctx.input?.view, name: ctx.input?.name });
        if (!page.ok) throw new CanvasError('not_found', page.problem);
        const entry = serverFor(root);
        const server = await entry.starting;
        const before = instances.get(ctx.instanceId);
        entry.instances.add(ctx.instanceId);
        instances.set(ctx.instanceId, keyOf(root));
        // The same canvas moved to another repository: stop the old server when nothing else shows it.
        if (before && before !== keyOf(root)) await release(before, ctx.instanceId);
        // Opening a canvas that is already open may only focus it: move it when a page was asked for.
        if (before === keyOf(root) && ctx.input?.view) server.go(page.name, page.anchor);
        return { url: server.url(page.name) + (page.anchor ? `#${page.anchor}` : ''), title: 'spec-relay', status: path.basename(root) };
      },
      onClose: async (ctx) => {
        const key = instances.get(ctx.instanceId);
        instances.delete(ctx.instanceId);
        if (key) await release(key, ctx.instanceId);
      },
    }),
  ],
});

// When the session's connection ends, end too (Windows does not stop child processes with their parent).
// (The kit's tests load this file with a stand-in SDK and set SPEC_RELAY_CANVAS_TEST.)
if (!process.env.SPEC_RELAY_CANVAS_TEST) {
  const quit = () => process.exit(0);
  process.stdin.on('end', quit);
  process.stdin.on('close', quit);
}
