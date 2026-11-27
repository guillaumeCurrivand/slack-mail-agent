export function tableBlocks(blocks: any[]): any[] {
  return blocks.flatMap(block => block.type === 'layout'
    ? block.rows.flatMap((row: any) => row.items.flatMap((item: any) => tableBlocks([item.block]))) : [block]);
}

export function wideTableRows(blocks: any[]): Array<{ fields: Record<string, string>; actions: any[] }> {
  const rows: Array<{ fields: Record<string, string>; actions: any[] }> = [];
  for (const block of blocks) {
    if (block.type === 'actions' && rows.length) rows.at(-1)!.actions.push(...block.elements);
    if (block.type !== 'rich_text') continue;
    for (const section of block.elements) {
      const fields: Record<string, string> = {};
      let column: string | undefined;
      for (const part of section.elements) {
        if (part.style?.bold && part.text.endsWith(' · ')) {
          if (column !== undefined) fields[column] = fields[column]!.slice(0, -1);
          column = part.text.slice(0, -3);
          fields[column!] = '';
        } else if (column !== undefined) fields[column] += part.text;
      }
      if (column !== undefined) {
        fields[column] = fields[column]!.slice(0, -2);
        rows.push({ fields, actions: [] });
      }
    }
  }
  return rows;
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
