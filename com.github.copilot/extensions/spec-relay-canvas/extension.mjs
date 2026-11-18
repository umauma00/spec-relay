// spec-relay canvas: shows the migration's progress, review pages and approved
// specs in a Copilot canvas, with an "ask about this" button on every item.
//
// The only file that touches the Copilot SDK (the canvas API is experimental and
// may change). Everything else is in the kit's scripts/canvas.mjs, which runs and
// is tested without Copilot.
import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';
import path from 'node:path';

const kit = new URL('../../../scripts/', import.meta.url);
const { startServer, pageName, changesForReview } = await import(new URL('canvas.mjs', kit));
const { status, checklist } = await import(new URL('status.mjs', kit));
const { language } = await import(new URL('gate.mjs', kit));

let workingDirectory = process.cwd();
let server = null;
const instances = new Set();
let session = null;

const rootOf = (ctx) => path.resolve(ctx?.session?.workingDirectory || workingDirectory);

async function serverFor(root) {
  if (server && server.root === root) return server;
  if (server) await server.close();
  server = await startServer({
    root,
    // A question the person typed in the canvas goes to the chat, queued after the current turn.
    ask: async ({ prompt, displayPrompt }) => { await session.send({ prompt, displayPrompt, mode: 'enqueue' }); },
  });
  return server;
}

function needOpen() {
  if (!server || instances.size === 0) throw new CanvasError('not_open', 'Open the spec-relay canvas first (open it with view "progress").');
  return server;
}

function go(ctx, which) {
  const s = needOpen();
  const page = pageName(s.root, { view: which, name: ctx.input?.name });
  if (!page.ok) throw new CanvasError('not_found', page.problem);
  s.go(page.name);
  return { ok: true, shown: page.name };
}

const nameInput = (description) => ({ type: 'object', additionalProperties: false, properties: { name: { type: 'string', description } } });

session = await joinSession({
  canvases: [
    createCanvas({
      id: 'spec-relay',
      displayName: 'spec-relay',
      description: 'Shows the spec-relay migration: progress, review pages and approved specs, with a button to ask about any item. Read-only: it never records a decision.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          view: { type: 'string', enum: ['progress', 'review', 'spec', 'specs'], description: 'The page to show first. Default: progress.' },
          name: { type: 'string', description: 'For review: the change name (extract-billing-invoice). For spec: the capability (billing/invoice).' },
        },
      },
      actions: [
        {
          name: 'get_status',
          description: 'The migration status as the canvas shows it: the to-do list, where the work is, the changes waiting for review with their open items, and problems.',
          handler: async (ctx) => {
            const root = rootOf(ctx);
            const report = status(root, { language: language(root) });
            return { todo: checklist(report, { problems: true }), current: report.current, reviews: changesForReview(root), problems: report.problems };
          },
        },
        { name: 'open_progress', description: 'Show the progress page in the open canvas.', handler: (ctx) => go(ctx, 'progress') },
        { name: 'open_review', description: 'Show the review page of a change in the open canvas. Render it for the person this way instead of describing it.', inputSchema: nameInput('The change, such as extract-billing-invoice.'), handler: (ctx) => go(ctx, 'review') },
        { name: 'open_spec', description: 'Show an approved spec (or the list of specs when no name is given) in the open canvas.', inputSchema: nameInput('The capability, such as billing/invoice.'), handler: (ctx) => go(ctx, 'spec') },
        { name: 'refresh', description: 'Reload the canvas after changing files (it also reloads by itself within a few seconds).', handler: () => { needOpen().refresh(); return { ok: true }; } },
      ],
      open: async (ctx) => {
        const root = rootOf(ctx);
        const s = await serverFor(root);
        const page = pageName(root, { view: ctx.input?.view, name: ctx.input?.name });
        if (!page.ok) throw new CanvasError('not_found', page.problem);
        instances.add(ctx.instanceId);
        return { url: s.url(page.name), title: 'spec-relay', status: path.basename(root) };
      },
      onClose: async (ctx) => {
        instances.delete(ctx.instanceId);
        if (instances.size === 0 && server) { await server.close(); server = null; }
      },
    }),
  ],
  hooks: {
    onSessionStart: async (input) => {
      if (input?.workingDirectory) workingDirectory = input.workingDirectory;
    },
  },
});
