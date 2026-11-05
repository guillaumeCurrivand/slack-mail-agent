export function tableBlocks(blocks: any[]): any[] {
  return blocks.flatMap(block => block.type === 'layout'
    ? block.rows.flatMap((row: any) => row.items.flatMap((item: any) => tableBlocks([item.block]))) : [block]);
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
