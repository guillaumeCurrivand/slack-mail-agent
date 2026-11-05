export function tableBlocks(blocks: any[]): any[] {
  return blocks.flatMap(block => block.type === 'layout'
    ? block.rows.flatMap((row: any) => row.items.flatMap((item: any) => tableBlocks([item.block]))) : [block]);
}
