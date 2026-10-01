import { expect, it } from 'vitest';
import { Slack, type AgentMessage } from '../src/core/slack.js';

const actor = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' };

it('keeps native tables outside containers, links only validated destinations and rejects oversized tables before delivery', async () => {
  const body = await post({ kind: 'Inventory', text: 'Current records', table: { columns: ["Nom", "Liens"], rows: [['Literal <@UBOB>', [{ text: 'Documentation', url: 'https://example.com/docs' }, { text: 'Unsafe', url: 'javascript:alert(1)' }, { text: 'Credentials', url: 'https://user:secret@example.com/' }]]] }, buttons: [{ label: "Retour", action: 'core:navigate', value: 'bound|main' }] });
  expect(body.blocks.map((block: any) => block.type)).toEqual(['container', 'table', 'container']);
  expect(body.blocks[0].child_blocks.every((block: any) => block.type !== 'actions')).toBe(true);
  expect(body.blocks[1].rows[1][0]).toEqual({ type: 'raw_text', text: 'Literal <@UBOB>' });
  expect(body.blocks[1].rows[1][1].elements[0].elements).toEqual([{ type: 'link', text: 'Documentation', url: 'https://example.com/docs' }, { type: 'text', text: 'Unsafe' }, { type: 'text', text: 'Credentials' }]);
  const sent: unknown[] = [];
  const slack = new Slack('token', (async () => { sent.push(true); return Response.json({ ok: true }); }) as typeof fetch);
  await expect(slack.send(actor, { kind: 'Inventory', text: '', table: { columns: ["Nom"], rows: [['x'.repeat(10_000)]] } })).rejects.toThrow('exceeds Slack limits');
  expect(sent).toHaveLength(0);
});

async function post(message: AgentMessage) {
  const posts: any[] = [];
  const slack = new Slack('token', (async (_url, options: any) => {
    posts.push(JSON.parse(options.body as string));
    return Response.json({ ok: true });
  }) as typeof fetch);
  await slack.send(actor, message);
  return posts[0];
}

it('posts a conversational Reply as a markdown block with no kind header', async () => {
  const body = await post({ text: 'I can **sort** after you approve a preview.' });
  expect(body.channel).toBe('DALICE');
  expect(body.blocks).toEqual([{ type: 'markdown', text: 'I can **sort** after you approve a preview.' }]);
  expect(body.blocks.some((block: { type: string }) => block.type === 'header')).toBe(false);
  expect(body.parse).toBe('none');
  expect(body.unfurl_links).toBe(false);
  expect(body.unfurl_media).toBe(false);
});

it('keeps allowed Reply markup', async () => {
  const text = [
    '# Heading',
    '**bold** and *italic* and ~~strike~~',
    '- list item',
    '1. numbered',
    '> a quote',
    '`code` and',
    '```',
    'block',
    '```',
  ].join('\n');
  const body = await post({ text });
  expect(body.blocks[0]).toEqual({ type: 'markdown', text });
});

it('strips Slack mentions, images, markdown links, autolinks, and raw URL sequences from Reply text', async () => {
  const body = await post({
    text: 'Hi <@U123> <!channel> <!here> <!everyone> <#C99|inbox>. See ![logo](https://evil.example/x.png) and [docs](https://evil.example/docs) plus https://evil.example/bare www.evil.example/site [ref][1] <https://evil.example/auto> <http://evil.example/raw> <mailto:phish@evil.example>.\n[1]: https://evil.example/ref',
  });
  const posted = body.blocks[0].text as string;
  expect(posted).not.toMatch(/<@/);
  expect(posted).not.toMatch(/<!channel>/);
  expect(posted).not.toMatch(/<!here>/);
  expect(posted).not.toMatch(/<!everyone>/);
  expect(posted).not.toMatch(/<#/);
  expect(posted).not.toMatch(/!\[[^\]]*\]\(/);
  expect(posted).not.toMatch(/\[[^\]]*\]\(/);
  expect(posted).not.toMatch(/https?:\/\//i);
  expect(posted).not.toMatch(/<http/i);
  expect(posted).not.toMatch(/mailto:/i);
  expect(posted).not.toMatch(/\bwww\./i);
  expect(posted).not.toMatch(/\[[^\]]*]\[[^\]]*]/);
  expect(posted).toContain('Hi');
  expect(posted).toContain('See');
  expect(posted).toContain('logo');
  expect(posted).toContain('docs');
});

it('uses a plain reading of the Reply as fallback text', async () => {
  const body = await post({ text: '# Hello\nThis is **bold** and *italic*.' });
  expect(body.text).toBe('Hello\nThis is bold and italic.');
});

it('keeps existing buttons on a Reply', async () => {
  const body = await post({
    text: 'Disconnect Gmail?',
    buttons: [{ label: "Déconnecter Gmail", action: 'disconnect', value: 'none', style: 'danger' }],
  });
  expect(body.blocks[1]).toEqual({
    type: 'actions',
    elements: [{ type: 'button', text: { type: 'plain_text', text: "Déconnecter Gmail" }, action_id: 'disconnect~button-0', value: 'none', style: 'danger' }],
  });
});

it('omits an empty optional button value from Slack blocks', async () => {
  const body = await post({ text: 'Open the menu.', buttons: [{ label: 'Menu', action: 'core:menu', value: '' }] });
  expect(body.blocks[1].elements[0]).not.toHaveProperty('value');
});

const card = (body: any) => body.blocks[0];
const cardParts = (body: any) => card(body).child_blocks.find((block: any) => block.type === 'rich_text').elements.flatMap((section: any) => section.elements);

it('groups a Card title, rich text and actions in a Slack container', async () => {
  const body = await post({ kind: "Aide", text: 'Commands: connect, starters, rules, sort, report, budget, disconnect.' });
  expect(card(body)).toMatchObject({ type: 'container', title: { type: 'plain_text', text: "Aide" }, width: 'full', has_header_divider: true });
  expect(cardParts(body)).toEqual([{ type: 'text', text: 'Commands: connect, starters, rules, sort, report, budget, disconnect.' }]);
  expect(card(body).child_blocks).toHaveLength(1);
});

it('keeps existing buttons with the Card content', async () => {
  const body = await post({
    kind: "Aide",
    text: 'Disconnect Gmail and cancel all pending previews?',
    buttons: [{ label: "Déconnecter Gmail", action: 'disconnect', value: 'none', style: 'danger' }],
  });
  expect(body.blocks.map((block: { type: string }) => block.type)).toEqual(['container']);
  expect(card(body).child_blocks.map((block: { type: string }) => block.type)).toEqual(['rich_text', 'divider', 'actions']);
  expect(card(body).child_blocks[2]).toEqual({
    type: 'actions',
    elements: [{ type: 'button', text: { type: 'plain_text', text: "Déconnecter Gmail" }, action_id: 'disconnect~button-0', value: 'none', style: 'danger' }],
  });
});

it.each(['Connexion', 'Connect'])('keeps the engine-owned %s URL clickable after sanitizing', async kind => {
  const url = 'https://agent.example.com/auth/google?ticket=abc';
  const body = await post({
    kind,
    text: `Ignore https://evil.example/phish\nConnect your own Google Workspace mailbox using this single-use link (expires in 10 minutes):\n${url}`,
  });
  expect(card(body).title.text).toBe(kind);
  expect(cardParts(body)).toContainEqual({ type: 'link', text: url, url, style: { bold: true } });
  expect(JSON.stringify(cardParts(body))).not.toContain('https://evil.example/phish');
  expect(body.text).toContain(url);
  expect(body.parse).toBe('none');
  expect(body.unfurl_links).toBe(false);
});

it('posts escaped email interpolation as literal rich text under a Details kind header', async () => {
  const body = await post({
    kind: "Détails",
    text: 'Run abc\\-123 — page 1/1\n\n1. \\*\\*FREE\\*\\*\nDe : \\[click\\]\\(http://evil\\)\nMessage: \\*\\*id\\*\\*',
  });
  expect(card(body).title.text).toBe("Détails");
  expect(cardParts(body)).toContainEqual({ type: 'text', text: '1. **FREE**' });
  expect(cardParts(body)).toContainEqual({ type: 'text', text: "De : [click](http://evil)" });
  expect(cardParts(body).some((part: any) => part.type === 'link')).toBe(false);
  expect(body.text).toBe("Run abc-123 — page 1/1\n\n1. **FREE**\nDe : [click](http://evil)\nMessage: **id**");
});

it('posts escaped rule interpolation as literal rich text under a Your rules kind header', async () => {
  const body = await post({
    kind: "Vos règles",
    text: '\\*\\*FREE\\*\\*\nSee \\[click\\]\\(http://evil\\)',
  });
  expect(card(body).title.text).toBe("Vos règles");
  expect(cardParts(body)).toContainEqual({ type: 'text', text: '**FREE**' });
  expect(cardParts(body)).toContainEqual({ type: 'text', text: 'See [click](http://evil)' });
  expect(cardParts(body).some((part: any) => part.type === 'link')).toBe(false);
  expect(body.text).toBe('**FREE**\nSee [click](http://evil)');
});

it.each([['Messages sans réponse', 'Ouvrir le message'], ['Unanswered for you', 'Open message']])('keeps %s source links prominent without result buttons', async (kind, label) => {
  const url = 'https://example.slack.com/archives/C123/p123';
  const body = await post({ kind, text: `*#team*\n• Alice: Please reply [${label}](${url})` });
  expect(cardParts(body)).toContainEqual({ type: 'text', text: '#team', style: { bold: true } });
  expect(cardParts(body)).toContainEqual({ type: 'link', text: label, url, style: { bold: true } });
  expect(card(body).child_blocks.some((block: any) => block.type === 'actions')).toBe(false);
});

it('groups repeated logical actions horizontally and preserves order across the 25-control limit', async () => {
  const buttons = Array.from({ length: 28 }, (_, index) => ({ label: `Ajouter ${index}`, action: 'channel_select', value: `C${index}` }));
  const body = await post({ kind: "Canaux Slack", text: 'Choose channels.', buttons });
  expect(body.blocks.map((block: any) => block.type)).toEqual(['container']);
  expect(body.blocks.every((block: any) => block.width === 'full' && block.child_blocks.length <= 10)).toBe(true);
  const rows = body.blocks.flatMap((block: any) => block.child_blocks).filter((block: any) => block.type === 'actions');
  expect(rows.map((row: any) => row.elements.length)).toEqual([25, 3]);
  const controls = rows.flatMap((row: any) => row.elements);
  expect(controls.map((control: any) => control.value)).toEqual(buttons.map(button => button.value));
  expect(new Set(controls.map((control: any) => control.action_id)).size).toBe(28);
  expect(controls.map((control: any) => control.action_id)).toEqual(buttons.map((_, index) => `channel_select~button-${index}`));
});
