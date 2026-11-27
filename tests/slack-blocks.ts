export function tableBlocks(blocks: any[]): any[] {
  return blocks.flatMap(block => block.type === 'layout'
    ? block.rows.flatMap((row: any) => row.items.flatMap((item: any) => tableBlocks([item.block]))) : [block]);
}

export function wrappedTableRows(blocks: any[]): Array<{ fields: Record<string, string>; actions: any[] }> {
  const index = blocks.findIndex(block => block.type === 'table');
  if (index < 0) return [];
  const actions = new Map<string, any[]>();
  let number: string | undefined;
  for (const block of blocks.slice(index + 1)) {
    if (block.type === 'context') number = /^Ligne (\d+)\b/.exec(block.elements[0]?.text)?.[1];
    else if (block.type === 'actions' && number) actions.set(number, [...(actions.get(number) ?? []), ...block.elements]);
    else break;
  }
  const [headings, ...rows] = blocks[index].rows;
  return rows.map((row: any[]) => {
    const cells = actions.size ? row.slice(0, -1) : row;
    const fields = Object.fromEntries(cells.flatMap((cell, column) => {
      const value = cell.type === 'rich_text' ? cell.elements.flatMap((section: any) => section.elements.map((part: any) => part.text)).join('') : cell.text;
      return value === ' ' ? [] : [[headings[column].text, value]];
    }));
    return { fields, actions: actions.get(row.at(-1)?.text) ?? [] };
  });
}

// Slack rejects data_table (and other newer blocks) in layout fallbacks.
// https://docs.slack.dev/reference/block-kit/blocks/layout-block/#fallback-behavior
export function validLayoutFallbacks(blocks: any[]): boolean {
  const stable = new Set(['context', 'divider', 'header', 'image', 'rich_text', 'section', 'table', 'video']);
  return blocks.every(block => block.type !== 'layout' || (
    block.fallback?.every((child: any) => stable.has(child.type)) &&
    block.rows.every((row: any) => row.items.every((item: any) => validLayoutFallbacks([item.block])))
  ));
}
